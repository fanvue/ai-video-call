# Block-by-block LongLive-2.0-5B streaming generator: the reference image is the clean first latent and permanent attention sink, prompts switch at block boundaries with a KV-recache, and each block is VAE-decoded with the causal cache kept.
from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field

import torch
from PIL import Image

REPO = os.environ.get("LONGLIVE_REPO", "/root/LongLive")
WEIGHTS = os.environ.get("LONGLIVE_WEIGHTS", "/weights")
LATENT_CHANNELS = 48
# Wan2.2 VAE: 16x spatial, 4x temporal; the first latent frame decodes to one pixel frame.
SPATIAL_STRIDE = 16
TEMPORAL_STRIDE = 4


@dataclass
class EngineOptions:
    # Off: without torch.compile, TorchAO dynamic FP8 measured slower than BF16 on H100 (diffusion 1005 vs 608 ms per block).
    fp8: bool = False
    compile: bool = False
    sampling_steps: int = 4
    num_frame_per_block: int = 8
    local_attn_size: int = 32
    sink_size: int = 8
    # Relative RoPE keeps positions inside the rolling window, so sessions can run past the 1024-frame RoPE table.
    relative_rope: bool = True
    # Recent blocks re-encoded under the new prompt on a switch (LongLive's KV-recache); the sink block is never recached.
    # Two, because with a 32-frame window, 8 sink frames and 8-frame blocks only the last two survive the next roll.
    recache_blocks: int = 2
    jpeg_quality: int = 82


@dataclass
class BlockResult:
    first_frame_index: int
    jpegs: list[bytes]
    diffusion_ms: float
    recache_ms: float
    decode_ms: float
    encode_ms: float


@dataclass
class DiffusedBlock:
    first_frame_index: int
    frame_count: int
    latents: torch.Tensor
    start: torch.cuda.Event
    after_recache: torch.cuda.Event
    done: torch.cuda.Event


@dataclass
class _CachedBlock:
    start_frame: int
    latents: torch.Tensor


@dataclass
class _SessionState:
    width: int
    height: int
    frame_seq_length: int
    image_latent: torch.Tensor
    prompt_embeds: dict
    generator: torch.Generator
    block_index: int = 0
    current_start_frame: int = 0
    next_pixel_frame: int = 0
    pending_recache: bool = False
    recent: list[_CachedBlock] = field(default_factory=list)


def _cached_decode(vae_model, z: torch.Tensor, scale) -> torch.Tensor:
    # Wan2.2's VAE only ships a whole-clip decode that clears its causal cache; this keeps _feat_map across calls so blocks decode seamlessly.
    from wan_5b.modules.vae2_2 import unpatchify

    z = z / scale[1].view(1, vae_model.z_dim, 1, 1, 1) + scale[0].view(1, vae_model.z_dim, 1, 1, 1)
    x = vae_model.conv2(z)
    is_first = vae_model._feat_map[0] is None
    outputs = []
    for step in range(z.shape[2]):
        vae_model._conv_idx = [0]
        outputs.append(
            vae_model.decoder(
                x[:, :, step : step + 1],
                feat_cache=vae_model._feat_map,
                feat_idx=vae_model._conv_idx,
                first_chunk=step == 0 and is_first,
            )
        )
    return unpatchify(torch.cat(outputs, 2), patch_size=2)


class LongLiveEngine:
    def __init__(self, options: EngineOptions | None = None):
        self.options = options or EngineOptions()
        started = time.perf_counter()
        os.chdir(REPO)
        sys.path.insert(0, REPO)
        os.makedirs("wan_models", exist_ok=True)
        if not os.path.exists("wan_models/Wan2.2-TI2V-5B"):
            os.symlink(f"{WEIGHTS}/Wan2.2-TI2V-5B", "wan_models/Wan2.2-TI2V-5B")

        from omegaconf import OmegaConf

        from wan_5b.modules.causal_model import CausalWanModel

        # The checkpoint overwrites every backbone weight, so building from config skips loading the 20 GB base shards.
        CausalWanModel.from_pretrained = classmethod(lambda cls, path, **kw: cls.from_config(cls.load_config(path), **kw))

        from pipeline import CausalDiffusionInferencePipeline
        from utils.config import normalize_config
        from utils.inference_utils import load_generator_checkpoint

        opts = self.options
        raw = OmegaConf.load("configs/inference_i2v.yaml")
        raw.pop("adapter", None)
        raw.checkpoints.pop("lora_ckpt", None)
        raw.checkpoints.generator_ckpt = f"{WEIGHTS}/LongLive-2.0-5B/model_bf16.pt"
        raw.model_kwargs.num_frame_per_block = opts.num_frame_per_block
        raw.model_kwargs.local_attn_size = opts.local_attn_size
        raw.inference.sampling_steps = opts.sampling_steps
        raw.inference.sink_size = opts.sink_size
        raw.data.image_or_video_shape = [1, opts.num_frame_per_block, LATENT_CHANNELS, 832 // 16, 480 // 16]
        config = normalize_config(raw)

        self.device = torch.device("cuda")
        torch.set_grad_enabled(False)
        pipe = CausalDiffusionInferencePipeline(config, device=self.device)
        load_generator_checkpoint(pipe.generator, config.generator_ckpt)
        pipe = pipe.to(device=self.device, dtype=torch.bfloat16)
        pipe.generator.model.eval().requires_grad_(False)
        if opts.fp8:
            from utils.fp8 import quantize_model_fp8

            quantize_model_fp8(pipe.generator.model, verbose=True)
        if opts.compile:
            pipe.generator.configure_torch_compile(mode="max-autotune-no-cudagraphs", suppress_errors=True)
        self.pipe = pipe
        self.dit = pipe._dit_model
        self.vae_scale = [
            pipe.vae.mean.to(device=self.device, dtype=torch.bfloat16),
            1.0 / pipe.vae.std.to(device=self.device, dtype=torch.bfloat16),
        ]
        self.decode_stream = torch.cuda.Stream(device=self.device)
        self._configured_seq_length: int | None = None
        self._state: _SessionState | None = None
        self.load_ms = (time.perf_counter() - started) * 1000

    def encode_prompt(self, prompt: str) -> dict:
        embeds = self.pipe.text_encoder(text_prompts=[prompt])
        return {"prompt_embeds": embeds["prompt_embeds"].to(dtype=torch.bfloat16)}

    def _image_latent(self, image: Image.Image, width: int, height: int) -> torch.Tensor:
        image = image.convert("RGB")
        # Cover-crop so a square or landscape reference keeps its proportions in the portrait frame.
        scale = max(width / image.width, height / image.height)
        resized = image.resize((max(width, round(image.width * scale)), max(height, round(image.height * scale))), Image.LANCZOS)
        left, top = (resized.width - width) // 2, (resized.height - height) // 2
        cropped = resized.crop((left, top, left + width, top + height))
        pixels = torch.frombuffer(bytearray(cropped.tobytes()), dtype=torch.uint8).view(height, width, 3)
        tensor = pixels.permute(2, 0, 1).float().div(127.5).sub(1.0)
        tensor = tensor.unsqueeze(0).unsqueeze(2).to(device=self.device, dtype=torch.bfloat16)
        return self.pipe.vae.encode_to_latent(tensor).to(device=self.device, dtype=torch.bfloat16)

    def _configure(self, frame_seq_length: int) -> None:
        pipe, opts = self.pipe, self.options
        if self._configured_seq_length != frame_seq_length:
            pipe.frame_seq_length = frame_seq_length
            pipe.clear_cache()
            pipe._initialize_kv_cache(batch_size=1, dtype=torch.bfloat16, device=self.device)
            pipe._initialize_crossattn_cache(batch_size=1, dtype=torch.bfloat16, device=self.device)
            self._configured_seq_length = frame_seq_length
        for cache in pipe.kv_cache_pos:
            cache["global_end_index"].zero_()
            cache["local_end_index"].zero_()
            cache["pinned_start"].fill_(-1)
            cache["pinned_len"].zero_()
        for cache in pipe.crossattn_cache_pos:
            cache["is_init"] = False
        # Same module overrides pipeline.inference() applies per call; set once because this engine owns the model.
        self.dit.local_attn_size = pipe.local_attn_size
        pipe._set_all_modules_max_attention_size(pipe.local_attn_size)
        pipe._set_all_modules_sink_size(pipe.sink_size)
        pipe._set_all_modules_global_sink_size(pipe.global_sink_size)
        self.dit.use_relative_rope = opts.relative_rope
        self.dit.rope_temporal_offset = 0.0

    def start(self, image: Image.Image, prompt: str, width: int, height: int, seed: int | None = None) -> None:
        latent_h, latent_w = height // SPATIAL_STRIDE, width // SPATIAL_STRIDE
        self._configure(latent_h * latent_w // 4)
        self.pipe.vae.model.clear_cache()
        generator = torch.Generator(device=self.device)
        generator.manual_seed(seed if seed is not None else int.from_bytes(os.urandom(4), "big"))
        self._state = _SessionState(
            width=width,
            height=height,
            frame_seq_length=latent_h * latent_w // 4,
            image_latent=self._image_latent(image, width, height),
            prompt_embeds=self.encode_prompt(prompt),
            generator=generator,
        )

    def switch_prompt(self, prompt: str) -> int:
        """Queues a prompt for the next block; returns the pixel frame index it first shows at."""
        state = self._require_state()
        state.prompt_embeds = self.encode_prompt(prompt)
        state.pending_recache = True
        return state.next_pixel_frame

    def stop(self) -> None:
        self._state = None
        self.pipe.vae.model.clear_cache()

    def _require_state(self) -> _SessionState:
        if self._state is None:
            raise RuntimeError("no active session")
        return self._state

    def _forward(self, latents, timestep, start_frame, state):
        return self.pipe.generator(
            noisy_image_or_video=latents,
            conditional_dict=state.prompt_embeds,
            timestep=timestep,
            kv_cache=self.pipe.kv_cache_pos,
            crossattn_cache=self.pipe.crossattn_cache_pos,
            current_start=start_frame * state.frame_seq_length,
            cache_start=start_frame * state.frame_seq_length,
        )

    def _recache(self, state: _SessionState) -> None:
        for cache in self.pipe.crossattn_cache_pos:
            cache["is_init"] = False
        blocks = state.recent[-self.options.recache_blocks :] if self.options.recache_blocks > 0 else []
        # Oldest first and ending on the newest block, so the cache end indices land back where they were.
        for block in blocks:
            zero = torch.zeros([1, block.latents.shape[1]], device=self.device, dtype=torch.float32)
            self._forward(block.latents, zero, block.start_frame, state)
        state.pending_recache = False

    def diffuse_block(self) -> DiffusedBlock:
        from utils.i2v_conditioning import _overwrite_i2v_context, _zero_i2v_context_timestep

        state, pipe = self._require_state(), self.pipe
        frames = self.options.num_frame_per_block
        latent_h, latent_w = state.height // SPATIAL_STRIDE, state.width // SPATIAL_STRIDE

        start = torch.cuda.Event(enable_timing=True)
        after_recache = torch.cuda.Event(enable_timing=True)
        after_diffusion = torch.cuda.Event(enable_timing=True)
        start.record()
        if state.pending_recache:
            self._recache(state)
        after_recache.record()

        first_block = state.block_index == 0
        latents = torch.randn(
            [1, frames, LATENT_CHANNELS, latent_h, latent_w],
            device=self.device,
            dtype=torch.bfloat16,
            generator=state.generator,
        )
        scheduler = pipe._initialize_sample_scheduler(latents)
        timestep = None
        for t in scheduler.timesteps:
            timestep = t * torch.ones([1, frames], device=self.device, dtype=torch.float32)
            if first_block:
                latents = _overwrite_i2v_context(latents, state.image_latent, 1)
                timestep = _zero_i2v_context_timestep(timestep, 1)
            flow_pred, _ = self._forward(latents, timestep, state.current_start_frame, state)
            latents = scheduler.step(flow_pred, t, latents, return_dict=False)[0]
            if first_block:
                latents = _overwrite_i2v_context(latents, state.image_latent, 1)
        # Clean pass at t=0 writes this block's KV for the blocks after it.
        self._forward(latents, timestep * 0, state.current_start_frame, state)
        after_diffusion.record()

        # The first latent frame is the reference image and decodes to a single pixel frame.
        frame_count = (frames - 1) * TEMPORAL_STRIDE + 1 if first_block else frames * TEMPORAL_STRIDE
        block = DiffusedBlock(state.next_pixel_frame, frame_count, latents, start, after_recache, after_diffusion)
        state.recent.append(_CachedBlock(state.current_start_frame, latents))
        # The first block is the sink and stays in the cache for good, so it is never a recache candidate.
        if first_block:
            state.recent.clear()
        del state.recent[: -max(self.options.recache_blocks, 1)]
        state.block_index += 1
        state.current_start_frame += frames
        state.next_pixel_frame += frame_count
        return block

    def decode_block(self, block: DiffusedBlock) -> BlockResult:
        """Decodes on its own CUDA stream so a second thread can overlap it with the next block's diffusion; call in block order."""
        stream = self.decode_stream
        with torch.cuda.stream(stream):
            stream.wait_event(block.done)
            block.latents.record_stream(stream)
            started = torch.cuda.Event(enable_timing=True)
            finished = torch.cuda.Event(enable_timing=True)
            started.record(stream)
            decoded = _cached_decode(self.pipe.vae.model, block.latents.permute(0, 2, 1, 3, 4).contiguous(), self.vae_scale)
            pixels = decoded[0].float().clamp_(-1, 1).add_(1).mul_(127.5).to(torch.uint8).permute(1, 0, 2, 3).contiguous()
            finished.record(stream)
            # Blocking copy: it waits for this stream only, so the diffusion thread keeps running.
            pixels_cpu = pixels.cpu()
        finished.synchronize()
        encode_started = time.perf_counter()
        jpegs = self._encode_jpegs(pixels_cpu)
        encode_ms = (time.perf_counter() - encode_started) * 1000
        if len(jpegs) != block.frame_count:
            raise RuntimeError(f"decoded {len(jpegs)} frames, expected {block.frame_count}")
        return BlockResult(
            first_frame_index=block.first_frame_index,
            jpegs=jpegs,
            recache_ms=block.start.elapsed_time(block.after_recache),
            diffusion_ms=block.after_recache.elapsed_time(block.done),
            decode_ms=started.elapsed_time(finished),
            encode_ms=encode_ms,
        )

    def next_block(self) -> BlockResult:
        return self.decode_block(self.diffuse_block())

    def _encode_jpegs(self, pixels: torch.Tensor) -> list[bytes]:
        from torchvision.io import encode_jpeg

        # CPU libjpeg, not nvjpeg: GPU encode on the side stream returned corrupt JPEGs for 310 of 381 frames once decode overlapped diffusion.
        encoded = [bytes(item.numpy().tobytes()) for item in encode_jpeg(list(pixels.unbind(0)), quality=self.options.jpeg_quality)]
        # Fail loud: a truncated JPEG would reach the browser as a frame it cannot draw.
        for jpeg in encoded:
            if not (jpeg.startswith(b"\xff\xd8") and jpeg.endswith(b"\xff\xd9")):
                raise RuntimeError("JPEG encode produced an invalid frame")
        return encoded

    def warmup(self, width: int = 480, height: int = 832, blocks: int = 3) -> float:
        """Runs a throwaway session so the first real one skips CUDA/Triton first-call costs; returns ms."""
        started = time.perf_counter()
        self.start(Image.new("RGB", (width, height), (128, 128, 128)), "A static webcam shot of an empty room.", width, height, seed=0)
        try:
            for index in range(blocks):
                if index == 1:
                    self.switch_prompt("A static webcam shot of an empty room, lamp on.")
                self.next_block()
        finally:
            self.stop()
        torch.cuda.synchronize()
        return (time.perf_counter() - started) * 1000

    def peak_memory_gb(self) -> float:
        return torch.cuda.max_memory_allocated() / 1e9

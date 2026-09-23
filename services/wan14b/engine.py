# GPU half of the wan14b premium clip service: Wan2.1 I2V 14B 480P + lightx2v 4-step distill, fused, with the Phase 1 speed config.
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from types import SimpleNamespace

WEIGHTS = "/weights"
BASE = f"{WEIGHTS}/wan21-i2v-480p"
LORA_FILE = f"{WEIGHTS}/lora/loras/Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors"
HEIGHT, WIDTH, FPS = 832, 480, 16
STEPS = 4
# Measured on one H100 (480x832, 81 frames): FA3 3.15 s/step vs 4.41 native SDPA and 3.54 cuDNN, output within 37.6 dB of SDPA.
ATTENTION_BACKEND = "_flash_3_hub"
# Off until the fp8 / compile / VAE rows of the Phase 1 bench land (the run stopped at the workspace spend limit).
FP8 = False
COMPILE_MODE = None
# Latent frames past this index of the [seed, zeros] conditioning equal an all-zero video's, so only 1 + 4 * keep frames
# are encoded; None encodes all 81 frames until the bench confirms which keep is exact.
CONDITION_KEEP = None
DECODE_BF16_UNTILED = False


class FastConditionEncoder:
    def __init__(self, vae, keep: int):
        self.vae = vae
        self.keep = keep
        self.original = vae.encode
        self.tail_cache: dict[tuple[int, int, int], object] = {}

    def mode(self, video):
        return self.original(video.to(self.vae.dtype)).latent_dist.mode()

    def encode(self, video, *args, **kwargs):
        import torch

        key = tuple(video.shape[2:])
        with torch.autocast("cuda", dtype=torch.bfloat16):
            if key not in self.tail_cache:
                self.tail_cache[key] = self.mode(torch.zeros_like(video)).float()
            head = self.mode(video[:, :, : min(video.shape[2], 1 + 4 * self.keep)]).float()
        latents = torch.cat([head, self.tail_cache[key][:, :, head.shape[2]:]], dim=2).to(self.vae.dtype)
        return SimpleNamespace(latent_dist=SimpleNamespace(mode=lambda: latents, sample=lambda generator=None: latents))


def fit_image(image):
    from PIL import Image

    image = image.convert("RGB")
    target = WIDTH / HEIGHT
    if image.width / image.height > target:
        crop_w = round(image.height * target)
        left = (image.width - crop_w) // 2
        image = image.crop((left, 0, left + crop_w, image.height))
    else:
        crop_h = round(image.width / target)
        # Portrait seeds keep the head: crop a third from the top, two thirds from the bottom.
        top = max(0, (image.height - crop_h) // 3)
        image = image.crop((0, top, image.width, top + crop_h))
    return image.resize((WIDTH, HEIGHT), Image.LANCZOS)


class WanEngine:
    def __init__(self) -> None:
        import torch
        from diffusers import AutoencoderKLWan, FlowMatchEulerDiscreteScheduler, WanImageToVideoPipeline
        from safetensors.torch import load_file
        from transformers import CLIPVisionModel

        image_encoder = CLIPVisionModel.from_pretrained(BASE, subfolder="image_encoder", dtype=torch.float32)
        vae = AutoencoderKLWan.from_pretrained(BASE, subfolder="vae", torch_dtype=torch.float32)
        pipe = WanImageToVideoPipeline.from_pretrained(BASE, vae=vae, image_encoder=image_encoder, torch_dtype=torch.bfloat16)
        # lightx2v step distill was trained on the flow-matching Euler schedule with shift 5.
        pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(pipe.scheduler.config, shift=5.0)
        pipe.to("cuda")
        raw = load_file(LORA_FILE)
        try:
            pipe.load_lora_weights(raw, adapter_name="distill")
        except KeyError:
            # diffusers 0.35's Wan converter KeyErrors on the two output-head keys this file ships; the rest still loads.
            pipe.unload_lora_weights()
            pipe.load_lora_weights({k: v for k, v in raw.items() if "head.head" not in k}, adapter_name="distill")
        pipe.fuse_lora(adapter_names=["distill"], lora_scale=1.0)
        pipe.unload_lora_weights()
        transformer = pipe.transformer
        transformer.set_attention_backend(ATTENTION_BACKEND)
        if FP8:
            from torchao.quantization import Float8DynamicActivationFloat8WeightConfig, PerRow, quantize_

            quantize_(transformer, Float8DynamicActivationFloat8WeightConfig(granularity=PerRow()),
                      filter_fn=lambda m, fqn: isinstance(m, torch.nn.Linear) and fqn.startswith("blocks."))
        if COMPILE_MODE:
            transformer.compile_repeated_blocks(mode=COMPILE_MODE, fullgraph=False)
        if CONDITION_KEEP is not None:
            self.encoder = FastConditionEncoder(pipe.vae, CONDITION_KEEP)
            pipe.vae.encode = self.encoder.encode
        torch.cuda.empty_cache()
        self.pipe = pipe
        self.torch = torch

    def warm_up(self) -> None:
        from PIL import Image

        # Compile and autotune run on the first call; paying them at container start keeps them off the first clip.
        self.generate(Image.new("RGB", (WIDTH, HEIGHT), (120, 110, 100)), "a person sits still", 81, seed=0)

    def decode(self, latents):
        torch = self.torch
        vae = self.pipe.vae
        torch.cuda.empty_cache()
        if DECODE_BF16_UNTILED:
            vae.disable_tiling()
        else:
            # Untiled fp32 decode of 81 frames OOMs beside the resident 14B + T5 on 80 GB; tiling bounds it.
            vae.enable_tiling()
        mean = torch.tensor(vae.config.latents_mean).view(1, vae.config.z_dim, 1, 1, 1).to(latents.device, torch.float32)
        std = torch.tensor(vae.config.latents_std).view(1, vae.config.z_dim, 1, 1, 1).to(latents.device, torch.float32)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=DECODE_BF16_UNTILED):
            video = vae.decode((latents.float() * std + mean).to(vae.dtype), return_dict=False)[0]
        frames = ((video[0].float().clamp(-1, 1) + 1) * 127.5).round().to(torch.uint8)
        return frames.permute(1, 2, 3, 0).contiguous().cpu().numpy()

    def generate(self, image, prompt: str, num_frames: int, seed: int = 42):
        torch = self.torch
        timings = {}
        start = time.perf_counter()
        with torch.inference_mode():
            latents = self.pipe(image=fit_image(image), prompt=prompt, height=HEIGHT, width=WIDTH, num_frames=num_frames,
                                guidance_scale=1.0, num_inference_steps=STEPS, output_type="latent",
                                generator=torch.Generator("cuda").manual_seed(seed)).frames
            torch.cuda.synchronize()
            timings["render_ms"] = int((time.perf_counter() - start) * 1000)
            mark = time.perf_counter()
            frames = self.decode(latents)
        timings["decode_ms"] = int((time.perf_counter() - mark) * 1000)
        return frames, timings


def encode_mp4(frames, fps: int = FPS) -> bytes:
    count, height, width, _ = frames.shape
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "clip.mp4")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(fps),
               "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
        subprocess.run(cmd, input=frames.tobytes(), check=True)
        with open(path, "rb") as handle:
            return handle.read()

# GFPGAN 1.4 face restore for LongLive frames, run on its own GPU: detect the largest face, restore an aligned 512 crop, blend it back under a feathered ellipse.
# Recipe measured in the face A/B: sharpness about 45 to 65 on the face with no flicker at blend 0.6.
# The optional persona swap (inswapper_128) runs first, from an allowlisted persona embedding only (see persona.py).
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

MODEL_DIR = "/models"
# Share of the GFPGAN output kept over the input crop; full strength reads waxy (FaceFusion default 0.8).
RESTORE_BLEND = 0.6
RESTORE_SIZE = 512
# Three measured best on an idle H100: CPU decode, detect and encode overlap the GPU passes of the other frames.
WORKERS = 3
# The reply carries only the face region, so it can afford a higher quality than the full frames it replaces.
ROI_JPEG_QUALITY = 92
PROVIDERS = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})]
# Restore over a swapped face; tuned with the swap constants below on recorded LongLive frames.
SWAP_RESTORE_BLEND = 0.6
# Share of the ring-matched colour kept over the raw swap. Off: on recorded frames the match paled the face (face vs neck dL 20 to 40, swap alone 2.5).
SKIN_MATCH_BLEND = 0.0
STD_SCALE_RANGE = (0.85, 1.15)
# Ring width as a share of the face core's side, and the least pixels either side must have before a match is trusted.
RING_WIDTH = 0.15
# The ring starts where the paste mask fades out, and keeps only pixels this close (LAB units) to the frame's own face skin.
RING_INNER_ALPHA = 0.1
# Width of the face-edge band whose colour is matched to the ring, as a share of the core's side; 0 matches the whole face.
MATCH_BAND = 0.12
RING_MAX_DL = 30.0
RING_MAX_DAB = 10.0
MIN_RING_PIXELS = 200
MIN_CORE_PIXELS = 400
# Share of the generated eyes and mouth kept through the swap; the full swap damped blinks and speech in the face A/B.
MOTION_KEEP = 0.35
# Coverage below this is treated as untouched when cutting the reply's face box.
MIN_COVERAGE = 1 / 255

# insightface's ArcFace crop template (inswapper_128 input), normalised to the crop.
ARCFACE_128_TEMPLATE = [
    [0.36167656, 0.40387734],
    [0.63696719, 0.40235469],
    [0.50019687, 0.56044219],
    [0.38710391, 0.72160547],
    [0.61507734, 0.72034453],
]

# FFHQ alignment template GFPGAN was trained on (five landmarks, normalised to the crop).
FFHQ_TEMPLATE = [
    [0.37691676, 0.46864664],
    [0.62285697, 0.46912813],
    [0.50123859, 0.61331904],
    [0.39308822, 0.72541100],
    [0.61150205, 0.72490465],
]


# Soft ellipse over the face in an aligned crop; inset by the feather so it reaches ~0 before the crop edge and never leaves a seam.
@lru_cache(maxsize=8)
def face_ellipse_mask(size: int):
    import cv2
    import numpy as np

    feather = max(size / 12.0, 2.0)
    ys, xs = np.ogrid[:size, :size]
    inside = ((xs + 0.5 - 0.5 * size) / (0.42 * size)) ** 2 + ((ys + 0.5 - 0.55 * size) / (0.5 * size)) ** 2 <= 1.0
    mask = inside.astype(np.float32)
    inset = int(round(feather))
    mask[:inset, :] = 0.0
    mask[-inset:, :] = 0.0
    mask[:, :inset] = 0.0
    mask[:, -inset:] = 0.0
    mask = cv2.GaussianBlur(mask, (0, 0), feather / 3)
    mask.setflags(write=False)
    return mask


def patch_landing(frame_shape, size: int, matrix, margin: int = 0):
    """Frame box the aligned patch lands on, grown by `margin` px and clipped, plus the patch -> box warp; None off-frame."""
    import cv2
    import numpy as np

    inverse = cv2.invertAffineTransform(matrix)
    height, width = frame_shape[:2]
    corners = np.array([[0, 0, 1], [size, 0, 1], [0, size, 1], [size, size, 1]], dtype=np.float32)
    projected = corners @ inverse.T
    x0 = max(0, int(np.floor(projected[:, 0].min())) - margin)
    y0 = max(0, int(np.floor(projected[:, 1].min())) - margin)
    x1 = min(width, int(np.ceil(projected[:, 0].max())) + 1 + margin)
    y1 = min(height, int(np.ceil(projected[:, 1].max())) + 1 + margin)
    if x1 <= x0 or y1 <= y0:
        return None
    shifted = inverse.copy()
    shifted[:, 2] -= (x0, y0)
    return x0, y0, x1, y1, shifted


def skin_pixels(region_bgr):
    # Broad YCrCb skin box; drops hair, white lingerie and most backgrounds so the ring measures skin only.
    import cv2

    ycrcb = cv2.cvtColor(region_bgr, cv2.COLOR_BGR2YCrCb)
    y, cr, cb = ycrcb[:, :, 0], ycrcb[:, :, 1], ycrcb[:, :, 2]
    return (y > 50) & (y < 245) & (cr > 133) & (cr < 180) & (cb > 77) & (cb < 135)


def match_to_ring(pasted, region, alpha, blend: float):
    """Moves the pasted face's LAB mean/std toward the skin on a ring just outside the paste mask, in the same frame."""
    import cv2
    import numpy as np

    core = alpha > 0.5
    touched = alpha > RING_INNER_ALPHA
    if core.sum() < MIN_CORE_PIXELS:
        return pasted
    width = max(3, int(round(RING_WIDTH * np.sqrt(core.sum()))))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * width + 1, 2 * width + 1))
    ring = cv2.dilate(touched.astype(np.uint8), kernel).astype(bool) & ~touched
    region_u8 = np.clip(region, 0, 255).astype(np.uint8)
    region_lab = cv2.cvtColor(region_u8, cv2.COLOR_BGR2LAB).astype(np.float32)
    # A beige wall passes any fixed skin box, so ring pixels must also sit near this frame's own face skin in LAB.
    face_skin = core & skin_pixels(region_u8)
    if face_skin.sum() < MIN_CORE_PIXELS:
        return pasted
    face_median = np.median(region_lab[face_skin], axis=0)
    near = (np.abs(region_lab[:, :, 0] - face_median[0]) < RING_MAX_DL) & (
        np.hypot(region_lab[:, :, 1] - face_median[1], region_lab[:, :, 2] - face_median[2]) < RING_MAX_DAB
    )
    skin = ring & skin_pixels(region_u8) & near
    if skin.sum() < MIN_RING_PIXELS:
        return pasted
    patch_lab = cv2.cvtColor(np.clip(pasted, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    source = core
    if MATCH_BAND > 0:
        # Only the face's own edge is measured, so the seam matches without forcing the lit centre to the neck's level.
        band = max(2, int(round(MATCH_BAND * np.sqrt(core.sum()))))
        inner = cv2.erode(core.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1)))
        source = core & ~inner.astype(bool)
    patch_mean, patch_std = patch_lab[source].mean(0), patch_lab[source].std(0)
    ring_mean, ring_std = region_lab[skin].mean(0), region_lab[skin].std(0)
    # Clamped: a face carries eyes, brows and lips, so a full std transfer to plain neck skin would flatten its features.
    scale = np.where(patch_std < 1e-3, 1.0, np.clip(ring_std / np.maximum(patch_std, 1e-3), *STD_SCALE_RANGE))
    matched = np.clip((patch_lab - patch_mean) * scale + ring_mean, 0, 255).astype(np.uint8)
    matched = cv2.cvtColor(matched, cv2.COLOR_LAB2BGR).astype(np.float32)
    return matched * blend + pasted * (1.0 - blend)


# Soft eye and mouth regions of an inswapper crop (ArcFace template positions), where the generated frame's own motion is kept.
@lru_cache(maxsize=4)
def motion_mask(size: int):
    import cv2
    import numpy as np

    mask = np.zeros((size, size), np.float32)
    (lx, ly), (rx, ry), _, (mlx, mly), (mrx, mry) = ARCFACE_128_TEMPLATE
    for cx, cy, ax, ay in ((lx, ly, 0.11, 0.07), (rx, ry, 0.11, 0.07), ((mlx + mrx) / 2, (mly + mry) / 2, 0.17, 0.09)):
        cv2.ellipse(mask, (int(cx * size), int(cy * size)), (int(ax * size), int(ay * size)), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), size / 32)
    mask.setflags(write=False)
    return mask


def keep_motion(patch, original, keep: float):
    """Lets `keep` of the generated eyes and mouth through the swapped patch, so blinks and speech are not flattened."""
    import numpy as np

    if keep <= 0:
        return patch
    weight = (motion_mask(patch.shape[0]) * keep)[:, :, None]
    return (patch.astype(np.float32) * (1.0 - weight) + original.astype(np.float32) * weight).astype(np.uint8)


def paste_patch(frame, patch, matrix, coverage=None, skin_match: float = 0.0):
    # `matrix` maps frame -> patch. Blends the warped patch back with a feathered elliptical face mask, only
    # inside the frame region the patch lands on; the full-frame float blend was most of the per-frame cost.
    import cv2
    import numpy as np

    size = patch.shape[0]
    mask = face_ellipse_mask(size)
    # The skin ring sits outside the patch square too (neck under the chin), so its box grows by a third of the face.
    margin = int(round(np.sqrt(abs(np.linalg.det(matrix[:, :2]))) ** -1 * size / 3)) if skin_match > 0 else 0
    landing = patch_landing(frame.shape, size, matrix, margin)
    if landing is None:
        return frame
    x0, y0, x1, y1, shifted = landing
    roi_size = (x1 - x0, y1 - y0)
    pasted = cv2.warpAffine(patch, shifted, roi_size).astype(np.float32)
    alpha = cv2.warpAffine(mask, shifted, roi_size)
    out = frame.copy()
    region = out[y0:y1, x0:x1].astype(np.float32)
    if skin_match > 0:
        pasted = match_to_ring(pasted, region, alpha, skin_match)
    weight = alpha[:, :, None]
    out[y0:y1, x0:x1] = (pasted * weight + region * (1.0 - weight)).astype(np.uint8)
    if coverage is not None:
        np.maximum(coverage[y0:y1, x0:x1], alpha, out=coverage[y0:y1, x0:x1])
    return out


def face_region_reply(out, coverage) -> dict | None:
    """Only the changed face box goes back: JPEG pixels plus the paste coverage, so the caller composites onto its own frame."""
    import cv2
    import numpy as np

    rows = np.flatnonzero((coverage > MIN_COVERAGE).any(axis=1))
    cols = np.flatnonzero((coverage > MIN_COVERAGE).any(axis=0))
    if not rows.size:
        return None
    y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
    ok, roi = cv2.imencode(".jpg", out[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, ROI_JPEG_QUALITY])
    ok_alpha, alpha = cv2.imencode(".png", np.round(coverage[y0:y1, x0:x1] * 255).astype(np.uint8))
    if not (ok and ok_alpha):
        raise RuntimeError("face region encode failed")
    return {"x": x0, "y": y0, "roi": roi.tobytes(), "alpha": alpha.tobytes()}


class PersonaUnavailable(Exception):
    pass


class FaceRestorer:
    def __init__(self, model_dir: str = MODEL_DIR):
        import cv2
        import insightface
        import numpy as np
        import onnxruntime as ort

        self.cv2, self.np = cv2, np
        self.det = insightface.app.FaceAnalysis(
            name="buffalo_l", root=f"{model_dir}/insightface", allowed_modules=["detection"], providers=PROVIDERS
        )
        self.det.prepare(ctx_id=0, det_size=(640, 640))
        # Recognition is only for the persona image, once per session; frames never go through it.
        self.ident = insightface.app.FaceAnalysis(
            name="buffalo_l", root=f"{model_dir}/insightface", allowed_modules=["detection", "recognition"], providers=PROVIDERS
        )
        self.ident.prepare(ctx_id=0, det_size=(640, 640))
        self.swapper = insightface.model_zoo.get_model(f"{model_dir}/inswapper_128_fp16.onnx", providers=PROVIDERS)
        self.gfp = ort.InferenceSession(f"{model_dir}/gfpgan_1.4.onnx", providers=PROVIDERS)
        # Fail loud on a silent CPU fallback: a CPU GFPGAN pass would fail open on every block.
        for name, providers in (
            ("det", self.det.models["detection"].session.get_providers()),
            ("swap", self.swapper.session.get_providers()),
            ("gfpgan", self.gfp.get_providers()),
        ):
            if providers[0] != "CUDAExecutionProvider":
                raise RuntimeError(f"{name} not on CUDA: {providers}")
        self.gfp_input = self.gfp.get_inputs()[0].name
        self.template = np.array(FFHQ_TEMPLATE, dtype=np.float32) * RESTORE_SIZE
        self.pool = ThreadPoolExecutor(WORKERS)
        self._personas: dict = {}
        self._persona_lock = threading.Lock()

    def _warm_once(self, frame) -> None:
        np = self.np
        self.det.get(frame)
        self.gfp.run(None, {self.gfp_input: np.zeros((1, 3, RESTORE_SIZE, RESTORE_SIZE), np.float32)})
        size = self.swapper.input_size[0]
        self.swapper.session.run(
            self.swapper.output_names,
            {self.swapper.input_names[0]: np.zeros((1, 3, size, size), np.float32), self.swapper.input_names[1]: np.zeros((1, 512), np.float32)},
        )

    def warm_workers(self) -> None:
        # The barrier holds every item until all pool threads have one, so each thread pays its first-run ORT cost here, not on a live block.
        barrier = threading.Barrier(WORKERS)
        frame = self.np.full((832, 480, 3), 128, self.np.uint8)

        def run(_):
            barrier.wait(timeout=120)
            self._warm_once(frame)

        list(self.pool.map(run, range(WORKERS)))

    def load_persona(self, persona) -> None:
        """Embeds an allowlisted persona (persona.Persona) for the swap; raises PersonaUnavailable when its image has no usable face."""
        cv2 = self.cv2
        image = cv2.imread(persona.path, cv2.IMREAD_COLOR)
        if image is None:
            raise PersonaUnavailable(f"{persona.id}: image unreadable")
        # A headshot's face can fill the photo and SCRFD misses it; a replicated border shrinks it into range (as swap_core does).
        height, width = image.shape[:2]
        padded = cv2.copyMakeBorder(image, height // 2, height // 2, width // 2, width // 2, cv2.BORDER_REPLICATE)
        faces = self.ident.get(padded)
        if not faces:
            raise PersonaUnavailable(f"{persona.id}: no face in the persona image")
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        with self._persona_lock:
            self._personas[persona.id] = face

    def persona_face(self, persona_id: str | None):
        with self._persona_lock:
            return self._personas.get(persona_id) if persona_id else None

    def _restore_face(self, frame, kps, coverage, blend: float):
        cv2, np = self.cv2, self.np
        matrix, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), self.template, method=cv2.LMEDS)
        if matrix is None:
            return frame
        crop = cv2.warpAffine(frame, matrix, (RESTORE_SIZE, RESTORE_SIZE), borderMode=cv2.BORDER_REPLICATE)
        tensor = (crop[:, :, ::-1].astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]
        output = self.gfp.run(None, {self.gfp_input: np.ascontiguousarray(tensor)})[0][0]
        restored = np.clip((output.transpose(1, 2, 0) + 1.0) * 127.5, 0, 255)[:, :, ::-1].astype(np.uint8)
        blended = cv2.addWeighted(restored, blend, crop, 1.0 - blend, 0)
        return paste_patch(frame, blended, matrix, coverage)

    def process_frame(self, frame, source, restore: bool):
        """(output frame, coverage) or None when there is nothing to change (no face, or nothing asked)."""
        cv2, np = self.cv2, self.np
        faces = self.det.get(frame)
        if not faces or (source is None and not restore):
            return None
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        coverage = np.zeros(frame.shape[:2], np.float32)
        out = frame
        if source is not None:
            patch, matrix = self.swapper.get(frame, face, source, paste_back=False)
            size = patch.shape[0]
            original = cv2.warpAffine(frame, matrix, (size, size), borderMode=cv2.BORDER_REPLICATE)
            patch = keep_motion(patch, original, MOTION_KEEP)
            out = paste_patch(out, patch, matrix, coverage, skin_match=SKIN_MATCH_BLEND)
        if restore:
            out = self._restore_face(out, face.kps, coverage, SWAP_RESTORE_BLEND if source is not None else RESTORE_BLEND)
        return out, coverage

    def process_jpeg(self, jpeg: bytes, source, restore: bool) -> dict | None:
        """The face-region reply for one frame, or None when the caller should keep its original frame."""
        cv2, np = self.cv2, self.np
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("undecodable JPEG")
        processed = self.process_frame(frame, source, restore)
        return None if processed is None else face_region_reply(*processed)

    def process_block(self, jpegs: list[bytes], source, restore: bool) -> list[dict | None]:
        return list(self.pool.map(lambda jpeg: self.process_jpeg(jpeg, source, restore), jpegs))

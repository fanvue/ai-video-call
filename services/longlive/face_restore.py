# GFPGAN 1.4 face restore for LongLive frames, run on its own GPU: detect the largest face, restore an aligned 512 crop, blend it back under a feathered ellipse.
# Recipe measured in the face A/B: sharpness about 45 to 65 on the face with no flicker at blend 0.6.
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

MODEL_DIR = "/models"
# Share of the GFPGAN output kept over the input crop; full strength reads waxy (FaceFusion default 0.8).
RESTORE_BLEND = 0.6
RESTORE_SIZE = 512
# Three measured best on an idle H100: CPU decode, detect and encode overlap the GPU passes of the other frames.
WORKERS = 3
JPEG_QUALITY = 90
PROVIDERS = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})]

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


def paste_patch(frame, patch, matrix):
    # `matrix` maps frame -> patch. Blends the warped patch back with a feathered elliptical face mask, only
    # inside the frame region the patch lands on; the full-frame float blend was most of the per-frame cost.
    import cv2
    import numpy as np

    size = patch.shape[0]
    mask = face_ellipse_mask(size)

    inverse = cv2.invertAffineTransform(matrix)
    height, width = frame.shape[:2]
    corners = np.array([[0, 0, 1], [size, 0, 1], [0, size, 1], [size, size, 1]], dtype=np.float32)
    projected = corners @ inverse.T
    x0 = max(0, int(np.floor(projected[:, 0].min())))
    y0 = max(0, int(np.floor(projected[:, 1].min())))
    x1 = min(width, int(np.ceil(projected[:, 0].max())) + 1)
    y1 = min(height, int(np.ceil(projected[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return frame
    shifted = inverse.copy()
    shifted[:, 2] -= (x0, y0)
    roi_size = (x1 - x0, y1 - y0)
    pasted = cv2.warpAffine(patch, shifted, roi_size).astype(np.float32)
    alpha = cv2.warpAffine(mask, shifted, roi_size)[:, :, None]
    out = frame.copy()
    region = out[y0:y1, x0:x1].astype(np.float32)
    out[y0:y1, x0:x1] = (pasted * alpha + region * (1.0 - alpha)).astype(np.uint8)
    return out


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
        self.gfp = ort.InferenceSession(f"{model_dir}/gfpgan_1.4.onnx", providers=PROVIDERS)
        # Fail loud on a silent CPU fallback: a CPU GFPGAN pass would fail open on every block.
        for name, providers in (("det", self.det.models["detection"].session.get_providers()), ("gfpgan", self.gfp.get_providers())):
            if providers[0] != "CUDAExecutionProvider":
                raise RuntimeError(f"{name} not on CUDA: {providers}")
        self.gfp_input = self.gfp.get_inputs()[0].name
        self.template = np.array(FFHQ_TEMPLATE, dtype=np.float32) * RESTORE_SIZE
        self.pool = ThreadPoolExecutor(WORKERS)

    def _restore_face(self, frame, kps):
        cv2, np = self.cv2, self.np
        matrix, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), self.template, method=cv2.LMEDS)
        if matrix is None:
            return None
        crop = cv2.warpAffine(frame, matrix, (RESTORE_SIZE, RESTORE_SIZE), borderMode=cv2.BORDER_REPLICATE)
        tensor = (crop[:, :, ::-1].astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]
        output = self.gfp.run(None, {self.gfp_input: np.ascontiguousarray(tensor)})[0][0]
        restored = np.clip((output.transpose(1, 2, 0) + 1.0) * 127.5, 0, 255)[:, :, ::-1].astype(np.uint8)
        blended = cv2.addWeighted(restored, RESTORE_BLEND, crop, 1.0 - RESTORE_BLEND, 0)
        return paste_patch(frame, blended, matrix)

    def restore_jpeg(self, jpeg: bytes) -> bytes | None:
        """Returns the restored frame as JPEG, or None when there is no face, so the caller keeps the original bytes."""
        cv2, np = self.cv2, self.np
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("undecodable JPEG")
        faces = self.det.get(frame)
        if not faces:
            return None
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        out = self._restore_face(frame, face.kps)
        if out is None:
            return None
        ok, encoded = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok:
            raise RuntimeError("JPEG encode failed")
        return encoded.tobytes()

    def restore_block(self, jpegs: list[bytes]) -> list[bytes | None]:
        return list(self.pool.map(self.restore_jpeg, jpegs))

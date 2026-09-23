# Seed face tone lock, the same correction as swap mode's SEED_FACE_TONE_LOCK: the next clip's seed has its face-ellipse
# LAB moments pulled TONE_LOCK_BLEND of the way back toward the session's reference, so lighting and skin tone stop compounding.
from __future__ import annotations

import numpy as np

TONE_LOCK_BLEND = 0.5
CROP_SIZE = 256
# FFHQ five-point template (normalised), the crop swap mode's face lock aligns to.
FFHQ_TEMPLATE = np.array(
    [
        [0.37691676, 0.46864664],
        [0.62285697, 0.46912813],
        [0.50123859, 0.61331904],
        [0.39308822, 0.72541100],
        [0.61150205, 0.72490465],
    ],
    dtype=np.float32,
)


def face_ellipse_mask(size: int) -> np.ndarray:
    import cv2

    feather = max(size / 12.0, 2.0)
    ys, xs = np.ogrid[:size, :size]
    inside = ((xs + 0.5 - 0.5 * size) / (0.42 * size)) ** 2 + ((ys + 0.5 - 0.55 * size) / (0.5 * size)) ** 2 <= 1.0
    mask = inside.astype(np.float32)
    inset = int(round(feather))
    mask[:inset, :] = 0.0
    mask[-inset:, :] = 0.0
    mask[:, :inset] = 0.0
    mask[:, -inset:] = 0.0
    return cv2.GaussianBlur(mask, (0, 0), feather / 3)


def align_matrix(kps: np.ndarray, size: int = CROP_SIZE):
    import cv2

    matrix, _ = cv2.estimateAffinePartial2D(np.asarray(kps, np.float32), FFHQ_TEMPLATE * size, method=cv2.LMEDS)
    return matrix


def ellipse_stats(crop_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    import cv2

    region = (face_ellipse_mask(crop_bgr.shape[0]) > 0.5).astype(np.uint8)
    mean, std = cv2.meanStdDev(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2LAB), mask=region)
    return mean.reshape(3).astype(np.float32), std.reshape(3).astype(np.float32)


def face_stats(frame_bgr: np.ndarray, kps: np.ndarray):
    import cv2

    matrix = align_matrix(kps)
    if matrix is None:
        return None, None
    crop = cv2.warpAffine(frame_bgr, matrix, (CROP_SIZE, CROP_SIZE), borderMode=cv2.BORDER_REPLICATE)
    return ellipse_stats(crop), matrix


def tone_lock(frame_bgr: np.ndarray, kps: np.ndarray | None, ref_stats, blend: float = TONE_LOCK_BLEND):
    # Returns (frame, locked). No face or no reference leaves the seed as rendered: tone is a quality feature, not a guard.
    import cv2

    if kps is None or ref_stats is None:
        return frame_bgr, False
    stats, matrix = face_stats(frame_bgr, kps)
    if stats is None:
        return frame_bgr, False
    mean, std = stats
    ref_mean, ref_std = ref_stats
    # A flat channel (std ~0) keeps its spread and only shifts its mean.
    scale = np.where(std < 1e-3, 1.0, ref_std / np.maximum(std, 1e-3)).astype(np.float32)
    lab = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    locked = cv2.cvtColor(np.clip((lab - mean) * scale + ref_mean, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    height, width = frame_bgr.shape[:2]
    mask = cv2.warpAffine(face_ellipse_mask(CROP_SIZE), cv2.invertAffineTransform(matrix), (width, height))
    alpha = (mask * blend)[:, :, None]
    out = locked.astype(np.float32) * alpha + frame_bgr.astype(np.float32) * (1.0 - alpha)
    return np.clip(out, 0, 255).astype(np.uint8), True

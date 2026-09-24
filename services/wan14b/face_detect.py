# Face detection that survives Wan's tight framing: at 480x832 a headshot's face is ~440 px wide (92% of the frame),
# past what SCRFD finds at det_size 640 and threshold 0.5 (smoke: 0/81 and 21/81 frames). Padding shrinks it into range.
from __future__ import annotations

import numpy as np

# Half the frame on every side, the border the seed gate and swap_core's source_face_from_image already use.
PAD_FRACTION = 0.5


def pad_offsets(height: int, width: int) -> tuple[int, int]:
    return int(height * PAD_FRACTION), int(width * PAD_FRACTION)


def shift_face(face, dy: int, dx: int):
    # Maps a face found on the padded canvas back into frame coordinates; kps and bbox may fall past the edge, which
    # the swap's warpAffine and paste_patch's clamp both handle.
    face.bbox = np.asarray(face.bbox, dtype=np.float32) - np.array([dx, dy, dx, dy], dtype=np.float32)
    face.kps = np.asarray(face.kps, dtype=np.float32) - np.array([dx, dy], dtype=np.float32)
    return face


def detect_faces(detector, bgr) -> tuple[list, bool]:
    # Returns (faces in frame coordinates, padded). The unpadded pass comes first so a small, wide-shot face keeps its resolution.
    import cv2

    faces = detector.get(bgr)
    if faces:
        return list(faces), False
    height, width = bgr.shape[:2]
    dy, dx = pad_offsets(height, width)
    padded = cv2.copyMakeBorder(bgr, dy, dy, dx, dx, cv2.BORDER_REPLICATE)
    return [shift_face(face, dy, dx) for face in detector.get(padded)], True


def largest(faces):
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if faces else None

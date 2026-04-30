import argparse
import os
from pathlib import Path

import cv2
from PIL import Image, ImageDraw


def extract_frame(video_path: str) -> Image.Image:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # 顔が出やすい中盤（短い動画でもOK）
    idx = frame_count // 3 if frame_count else 0

    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ret, frame = cap.read()
    if not ret:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ret, frame = cap.read()
    cap.release()

    if not ret:
        raise RuntimeError("Failed to read frame from video.")

    frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return Image.fromarray(frame)


def center_square(img: Image.Image) -> Image.Image:
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def make_circle_icon(
    src_img: Image.Image,
    size: int = 512,
    margin: int = 12,
    ring_width: int = 10,
    ring_rgba=(200, 210, 225, 255),
) -> Image.Image:
    img_sq = center_square(src_img).resize((size, size), Image.LANCZOS)

    # 白背景
    bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))

    # 円形マスク
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    bbox = (margin, margin, size - margin, size - margin)
    d.ellipse(bbox, fill=255)

    # 円形に切り抜いて貼り付け
    bg.paste(img_sq.convert("RGBA"), (0, 0), mask)

    # 〇枠（リング）
    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(ring)
    dr.ellipse(bbox, outline=ring_rgba, width=ring_width)

    bg.alpha_composite(ring)
    return bg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="Input mp4 path")
    ap.add_argument("--out", required=True, help="Output png path")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--margin", type=int, default=12)
    ap.add_argument("--ring-width", type=int, default=10)
    ap.add_argument("--debug-frame", default="", help="Optional debug frame png path")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    frame = extract_frame(str(src))
    if args.debug_frame:
        dbg = Path(args.debug_frame)
        dbg.parent.mkdir(parents=True, exist_ok=True)
        center_square(frame).save(dbg)

    icon = make_circle_icon(
        frame,
        size=args.size,
        margin=args.margin,
        ring_width=args.ring_width,
    )
    icon.save(out)

    print("OK")
    print(f"src: {src}")
    print(f"out: {out}")


if __name__ == "__main__":
    main()


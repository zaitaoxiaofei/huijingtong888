import argparse
import json
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError as exc:
    print(json.dumps({"error": "Python missing OpenCV dependencies. Install opencv-python and numpy."}), file=sys.stderr)
    raise SystemExit(2) from exc


ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
WATERMARK_WIDTH_RATIO = 0.22
WATERMARK_MAX_HEIGHT_RATIO = 0.18
EDGE_MARGIN_RATIO = 0.035
DEFAULT_OPACITY = 0.82
POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right", "center", "custom"}


def parse_filenames(raw):
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [str(item) for item in data if str(item).strip()]


def safe_input_files(input_dir, filenames):
    allowed_names = set(filenames)
    available = []
    for entry in sorted(os.listdir(input_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue
        if allowed_names and entry not in allowed_names:
            continue
        available.append(entry)
    return available


def read_image(file_path, flags):
    data = np.fromfile(file_path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def write_image(file_path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"Failed to write watermarked image: {file_path}")
    encoded.tofile(file_path)


def watermark_layers(watermark):
    if watermark is None:
        raise RuntimeError("Unable to read watermark image.")
    if watermark.ndim == 2:
        color = cv2.cvtColor(watermark, cv2.COLOR_GRAY2BGR)
        alpha = np.full(watermark.shape, 255, dtype=np.uint8)
        return color, alpha
    if watermark.shape[2] == 4:
        return watermark[:, :, :3], watermark[:, :, 3]
    return watermark[:, :, :3], np.full(watermark.shape[:2], 255, dtype=np.uint8)


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def resize_watermark(color, alpha, image_width, image_height, width_ratio=WATERMARK_WIDTH_RATIO):
    wm_height, wm_width = color.shape[:2]
    if wm_width <= 0 or wm_height <= 0:
        raise RuntimeError("Invalid watermark dimensions.")

    scale = min(
        (image_width * clamp(width_ratio, 0.08, 0.45)) / wm_width,
        (image_height * max(WATERMARK_MAX_HEIGHT_RATIO, clamp(width_ratio, 0.08, 0.35))) / wm_height,
        4.0,
    )
    scale = max(scale, 0.01)
    target_width = max(1, int(round(wm_width * scale)))
    target_height = max(1, int(round(wm_height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    return (
        cv2.resize(color, (target_width, target_height), interpolation=interpolation),
        cv2.resize(alpha, (target_width, target_height), interpolation=interpolation),
    )


def position_watermark(image_width, image_height, watermark_width, watermark_height, position, x_percent=None, y_percent=None):
    margin = max(12, int(round(min(image_width, image_height) * EDGE_MARGIN_RATIO)))
    if position == "custom":
        left = int(round(image_width * clamp(float(x_percent if x_percent is not None else 75), 0, 100) / 100.0))
        top = int(round(image_height * clamp(float(y_percent if y_percent is not None else 75), 0, 100) / 100.0))
        return min(max(0, left), max(0, image_width - watermark_width)), min(max(0, top), max(0, image_height - watermark_height))
    if position == "top-left":
        return margin, margin
    if position == "top-right":
        return max(0, image_width - watermark_width - margin), margin
    if position == "bottom-left":
        return margin, max(0, image_height - watermark_height - margin)
    if position == "center":
        return max(0, (image_width - watermark_width) // 2), max(0, (image_height - watermark_height) // 2)
    return max(0, image_width - watermark_width - margin), max(0, image_height - watermark_height - margin)


def apply_watermark(image, watermark_color, watermark_alpha, position="bottom-right", width_ratio=WATERMARK_WIDTH_RATIO, opacity=DEFAULT_OPACITY, x_percent=None, y_percent=None):
    base_height, base_width = image.shape[:2]
    color, alpha = resize_watermark(watermark_color, watermark_alpha, base_width, base_height, width_ratio)
    wm_height, wm_width = color.shape[:2]
    left, top = position_watermark(base_width, base_height, wm_width, wm_height, position, x_percent, y_percent)

    result = image.copy()
    roi = result[top:top + wm_height, left:left + wm_width]
    alpha_float = (alpha.astype(np.float32) / 255.0 * clamp(opacity, 0.1, 1.0))[:, :, None]
    blended = color.astype(np.float32) * alpha_float + roi.astype(np.float32) * (1.0 - alpha_float)
    result[top:top + wm_height, left:left + wm_width] = np.clip(blended, 0, 255).astype(np.uint8)
    return result


def main():
    parser = argparse.ArgumentParser(description="Apply a configured shop watermark to ecommerce image crops.")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--watermark", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--filenames", default="")
    parser.add_argument("--position", default="bottom-right", choices=sorted(POSITIONS))
    parser.add_argument("--scale", type=float, default=WATERMARK_WIDTH_RATIO)
    parser.add_argument("--opacity", type=float, default=DEFAULT_OPACITY)
    parser.add_argument("--x-percent", type=float, default=None)
    parser.add_argument("--y-percent", type=float, default=None)
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    filenames = safe_input_files(args.input_dir, parse_filenames(args.filenames))
    if not filenames:
        raise RuntimeError("No images available for watermarking.")

    watermark = read_image(args.watermark, cv2.IMREAD_UNCHANGED)
    watermark_color, watermark_alpha = watermark_layers(watermark)
    images = []
    for index, filename in enumerate(filenames, start=1):
        source_path = os.path.join(args.input_dir, filename)
        source = read_image(source_path, cv2.IMREAD_COLOR)
        if source is None:
            continue
        output = apply_watermark(source, watermark_color, watermark_alpha, args.position, args.scale, args.opacity, args.x_percent, args.y_percent)
        output_name = f"watermarked_{index:03d}.png"
        output_path = os.path.join(args.output, output_name)
        write_image(output_path, output)
        height, width = output.shape[:2]
        images.append({
            "id": f"watermarked-{index:03d}",
            "filename": output_name,
            "sourceFilename": filename,
            "width": width,
            "height": height,
        })

    if not images:
        raise RuntimeError("Unable to add watermark to images.")

    print(json.dumps({"taskId": args.task_id, "images": images}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc

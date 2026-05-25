import argparse
from concurrent.futures import ProcessPoolExecutor
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
TARGET_WIDTH = 1080
TARGET_HEIGHT = 1440
DEFAULT_MAX_WORKERS = 4


def read_image(file_path):
    data = np.fromfile(file_path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def write_image(file_path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"Failed to write 3:4 image: {file_path}")
    encoded.tofile(file_path)


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
    available = []
    allowed_names = set(filenames)
    for entry in sorted(os.listdir(input_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue
        if allowed_names and entry not in allowed_names:
            continue
        available.append(entry)
    return available


def worker_count(total):
    if total <= 1:
        return 1

    raw = os.environ.get("IMAGE_CROPPER_WORKERS", "").strip()
    try:
        requested = int(raw) if raw else DEFAULT_MAX_WORKERS
    except ValueError:
        requested = DEFAULT_MAX_WORKERS

    cpu_count = os.cpu_count() or 2
    return max(1, min(total, requested, max(1, cpu_count - 1)))


def convert_file(args):
    index, input_dir, output_dir, filename = args
    source_path = os.path.join(input_dir, filename)
    image = read_image(source_path)
    if image is None:
        return None

    converted = fit_to_canvas(image)
    output_name = f"ratio_3x4_{index:03d}.png"
    output_path = os.path.join(output_dir, output_name)
    write_image(output_path, converted)
    return {
        "id": f"ratio-3x4-{index:03d}",
        "filename": output_name,
        "sourceFilename": filename,
        "width": TARGET_WIDTH,
        "height": TARGET_HEIGHT,
        "order": index,
    }


def convert_files(input_dir, output_dir, filenames):
    jobs = [(index, input_dir, output_dir, filename) for index, filename in enumerate(filenames, start=1)]
    workers = worker_count(len(jobs))
    if workers <= 1:
        results = [convert_file(job) for job in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(convert_file, jobs))

    images = [item for item in results if item]
    images.sort(key=lambda item: item.pop("order"))
    return images


def background_for(image):
    return 255


def fit_to_canvas(image, target_width=TARGET_WIDTH, target_height=TARGET_HEIGHT):
    height, width = image.shape[:2]
    if width <= 0 or height <= 0:
        raise RuntimeError("Invalid image dimensions.")

    scale = min(target_width / width, target_height / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    resized = cv2.resize(image, (resized_width, resized_height), interpolation=interpolation)

    bg = background_for(image)
    canvas = np.full((target_height, target_width, 3), bg, dtype=np.uint8)
    left = (target_width - resized_width) // 2
    top = (target_height - resized_height) // 2
    canvas[top:top + resized_height, left:left + resized_width] = resized
    return canvas


def main():
    parser = argparse.ArgumentParser(description="Put ecommerce images on a 1080x1440 3:4 canvas.")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--filenames", default="")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    filenames = safe_input_files(args.input_dir, parse_filenames(args.filenames))
    if not filenames:
        raise RuntimeError("No images available for 3:4 conversion.")

    images = convert_files(args.input_dir, args.output, filenames)

    if not images:
        raise RuntimeError("Unable to convert images to 3:4.")

    print(json.dumps({"taskId": args.task_id, "images": images}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc

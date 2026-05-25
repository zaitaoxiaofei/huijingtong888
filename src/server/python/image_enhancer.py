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
DETAIL_TARGET_LONG_EDGE = 1440
MAX_UPSCALE = 3.0
DEFAULT_MAX_WORKERS = 4


def read_image(file_path):
    data = np.fromfile(file_path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def write_image(file_path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"Failed to write enhanced image: {file_path}")
    encoded.tofile(file_path)


def enhance_image(image):
    upscaled = upscale_for_detail(image)
    denoised = cv2.fastNlMeansDenoisingColored(upscaled, None, 2, 2, 7, 17)

    lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB).astype(np.float32)
    lightness, a_channel, b_channel = cv2.split(lab)
    toned = blend_global_lightness(lightness)
    detailed = sharpen_lightness(toned)

    enhanced = cv2.cvtColor(
        cv2.merge((detailed, a_channel, b_channel)).astype(np.uint8),
        cv2.COLOR_LAB2BGR,
    )
    return boost_vibrance(enhanced)


def upscale_for_detail(image):
    height, width = image.shape[:2]
    long_edge = max(height, width)
    if long_edge <= 0 or long_edge >= DETAIL_TARGET_LONG_EDGE:
        return image

    scale = min(MAX_UPSCALE, DETAIL_TARGET_LONG_EDGE / long_edge)
    if scale <= 1.05:
        return image

    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    return cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_LANCZOS4)


def blend_global_lightness(lightness):
    low, high = np.percentile(lightness, (0.6, 99.4))
    if high - low < 12:
        return lightness

    stretched = np.clip((lightness - low) * (255.0 / (high - low)), 0, 255)
    # Global contrast keeps smooth ecommerce backgrounds clean where tiled CLAHE can ripple.
    return np.clip(lightness * 0.72 + stretched * 0.28 + 1.2, 0, 255).astype(np.float32)


def sharpen_lightness(lightness):
    fine_blur = cv2.GaussianBlur(lightness, (0, 0), 0.72)
    mid_blur = cv2.GaussianBlur(lightness, (0, 0), 2.0)
    fine_detail = lightness - fine_blur
    mid_detail = lightness - mid_blur

    edge_x = cv2.Sobel(lightness, cv2.CV_32F, 1, 0, ksize=3)
    edge_y = cv2.Sobel(lightness, cv2.CV_32F, 0, 1, ksize=3)
    edge_strength = cv2.magnitude(edge_x, edge_y)
    edge_mask = np.clip(edge_strength / 42.0, 0, 1)
    edge_mask = cv2.GaussianBlur(edge_mask, (0, 0), 0.8)

    # Keep flat backgrounds quiet while giving type, product rims, and material texture more bite.
    detail_gain = 0.18 + edge_mask * 0.92
    detail = fine_detail * 0.90 + mid_detail * 0.22
    return np.clip(lightness + detail * detail_gain, 0, 255)


def boost_vibrance(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV).astype(np.float32)
    saturation = hsv[:, :, 1]
    muted_room = 1.0 - saturation / 255.0
    hsv[:, :, 1] = np.clip(saturation * (1.0 + muted_room * 0.09), 0, 255)
    hsv[:, :, 2] = np.clip(hsv[:, :, 2] * 1.008, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


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


def enhance_file(args):
    index, input_dir, output_dir, filename = args
    source_path = os.path.join(input_dir, filename)
    image = read_image(source_path)
    if image is None:
        return None

    enhanced = enhance_image(image)
    output_name = f"enhanced_{index:03d}.png"
    output_path = os.path.join(output_dir, output_name)
    write_image(output_path, enhanced)
    height, width = enhanced.shape[:2]
    return {
        "id": f"enhanced-{index:03d}",
        "filename": output_name,
        "sourceFilename": filename,
        "width": int(width),
        "height": int(height),
        "order": index,
    }


def enhance_files(input_dir, output_dir, filenames):
    jobs = [(index, input_dir, output_dir, filename) for index, filename in enumerate(filenames, start=1)]
    workers = worker_count(len(jobs))
    if workers <= 1:
        results = [enhance_file(job) for job in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(enhance_file, jobs))

    images = [item for item in results if item]
    images.sort(key=lambda item: item.pop("order"))
    return images


def main():
    parser = argparse.ArgumentParser(description="Enhance cropped ecommerce images.")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--filenames", default="")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    filenames = safe_input_files(args.input_dir, parse_filenames(args.filenames))
    if not filenames:
        raise RuntimeError("No cropped images available for enhancement.")

    images = enhance_files(args.input_dir, args.output, filenames)

    if not images:
        raise RuntimeError("Unable to enhance cropped images.")

    print(json.dumps({"taskId": args.task_id, "images": images}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc

"""
Python 后端加水印接口示例。

安装依赖：
  pip install fastapi uvicorn opencv-python numpy

启动：
  uvicorn watermark_api_example:app --host 0.0.0.0 --port 8010
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse


Position = Literal["top-left", "top-right", "bottom-left", "bottom-right", "bottom-center"]

app = FastAPI(title="ERP Watermark API")

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "watermark-output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def read_upload_image(file_bytes: bytes, flags: int) -> np.ndarray:
    data = np.frombuffer(file_bytes, dtype=np.uint8)
    image = cv2.imdecode(data, flags)
    if image is None:
        raise HTTPException(status_code=400, detail="无法读取图片文件")
    return image


def split_watermark(watermark: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if watermark.ndim == 2:
        color = cv2.cvtColor(watermark, cv2.COLOR_GRAY2BGR)
        alpha = np.full(watermark.shape, 255, dtype=np.uint8)
        return color, alpha
    if watermark.shape[2] == 4:
        return watermark[:, :, :3], watermark[:, :, 3]
    return watermark[:, :, :3], np.full(watermark.shape[:2], 255, dtype=np.uint8)


def calculate_position(
    image_width: int,
    image_height: int,
    watermark_width: int,
    watermark_height: int,
    position: Position,
    margin: int,
) -> tuple[int, int]:
    if position == "top-left":
        return margin, margin
    if position == "top-right":
        return image_width - watermark_width - margin, margin
    if position == "bottom-left":
        return margin, image_height - watermark_height - margin
    if position == "bottom-center":
        return (image_width - watermark_width) // 2, image_height - watermark_height - margin
    return image_width - watermark_width - margin, image_height - watermark_height - margin


def apply_watermark(
    base_image: np.ndarray,
    watermark_image: np.ndarray,
    position: Position,
    opacity: float,
    size_percent: float,
    margin_px: int,
) -> np.ndarray:
    base_height, base_width = base_image.shape[:2]
    watermark_color, watermark_alpha = split_watermark(watermark_image)
    raw_height, raw_width = watermark_color.shape[:2]

    target_width = max(1, int(base_width * min(max(size_percent, 5), 60) / 100))
    scale = target_width / raw_width
    target_height = max(1, int(raw_height * scale))

    watermark_color = cv2.resize(watermark_color, (target_width, target_height), interpolation=cv2.INTER_AREA)
    watermark_alpha = cv2.resize(watermark_alpha, (target_width, target_height), interpolation=cv2.INTER_AREA)

    left, top = calculate_position(
        base_width,
        base_height,
        target_width,
        target_height,
        position,
        max(0, int(margin_px)),
    )
    left = max(0, min(left, base_width - target_width))
    top = max(0, min(top, base_height - target_height))

    result = base_image.copy()
    roi = result[top : top + target_height, left : left + target_width]
    alpha = (watermark_alpha.astype(np.float32) / 255.0 * min(max(opacity, 0.05), 1.0))[:, :, None]
    blended = watermark_color.astype(np.float32) * alpha + roi.astype(np.float32) * (1 - alpha)
    result[top : top + target_height, left : left + target_width] = np.clip(blended, 0, 255).astype(np.uint8)
    return result


@app.post("/api/images/watermark")
async def watermark_endpoint(
    image: UploadFile = File(...),
    watermark: UploadFile = File(...),
    position: Position = Form("bottom-right"),
    opacity: float = Form(0.82),
    size_percent: float = Form(22),
    margin_px: int = Form(24),
):
    image_bytes = await image.read()
    watermark_bytes = await watermark.read()
    base_image = read_upload_image(image_bytes, cv2.IMREAD_COLOR)
    watermark_image = read_upload_image(watermark_bytes, cv2.IMREAD_UNCHANGED)

    output = apply_watermark(base_image, watermark_image, position, opacity, size_percent, margin_px)
    output_name = f"watermarked-{uuid.uuid4().hex}.png"
    output_path = OUTPUT_DIR / output_name
    ok, encoded = cv2.imencode(".png", output)
    if not ok:
        raise HTTPException(status_code=500, detail="水印图片编码失败")
    encoded.tofile(str(output_path))

    return {
        "url": f"/api/images/watermark/{output_name}",
        "fileName": output_name,
        "width": int(output.shape[1]),
        "height": int(output.shape[0]),
    }


@app.get("/api/images/watermark/{file_name}")
async def get_watermarked_image(file_name: str):
    safe_name = os.path.basename(file_name)
    file_path = OUTPUT_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(file_path, media_type="image/png")

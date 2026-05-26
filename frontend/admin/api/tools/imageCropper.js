import { apiClient, getAuthToken } from "../../utils/api";

export async function uploadCropperImage(file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/tools/image-cropper/upload", {
    method: "POST",
    body: formData,
    headers: uploadHeaders()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `上传失败：${response.status}`);
  }
  return data;
}

export async function uploadListingMedia(file, metadata = {}) {
  const formData = new FormData();
  formData.append("file", file);
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value !== undefined && value !== null && value !== "") formData.append(key, String(value));
  }
  const response = await fetch("/api/listing/media/upload", {
    method: "POST",
    body: formData,
    headers: uploadHeaders()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `素材上传失败：${response.status}`);
  }
  return data;
}

export function detectCropperImage(payload) {
  return apiClient.post("/api/tools/image-cropper/detect", payload);
}

export function enhanceCropperImages(payload) {
  return apiClient.post("/api/tools/image-cropper/enhance", payload);
}

export function convertCropperImagesToRatio(payload) {
  return apiClient.post("/api/tools/image-cropper/ratio-3x4", payload);
}

export function watermarkCropperImages(payload) {
  return apiClient.post("/api/tools/image-cropper/watermark", payload);
}

export async function uploadShopWatermark(shopId, file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`/api/tools/image-cropper/shop-watermark/${encodeURIComponent(shopId)}`, {
    method: "POST",
    body: formData,
    headers: uploadHeaders()
  });
  const contentType = String(response.headers.get("content-type") || "");
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `水印上传失败：${response.status}`);
  }
  return data;
}

export function withImageToken(url) {
  const token = getAuthToken();
  if (!token || !url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function downloadUrl(url) {
  return withImageToken(url);
}

function uploadHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}


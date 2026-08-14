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

const LISTING_MEDIA_UPLOAD_CONCURRENCY = 10;
const listingMediaUploadQueue = [];
let activeListingMediaUploads = 0;

export async function uploadListingMedia(file, metadata = {}) {
  return withListingMediaUploadSlot(() => uploadListingMediaWithRetry(file, metadata));
}

async function uploadListingMediaWithRetry(file, metadata = {}) {
  const requestId = createUploadRequestId();
  const requestMetadata = {
    ...metadata,
    upload_request_id: requestId,
    source_id: metadata?.source_id || metadata?.sourceId || `upload:${requestId}`
  };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await uploadListingMediaOnce(file, requestMetadata);
    } catch (error) {
      lastError = error;
      if (!isRetriableUploadError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function uploadListingMediaOnce(file, metadata = {}) {
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
    const error = new Error(data?.error || `素材上传失败：${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function withListingMediaUploadSlot(task) {
  return new Promise((resolve, reject) => {
    listingMediaUploadQueue.push({ task, resolve, reject });
    drainListingMediaUploadQueue();
  });
}

function drainListingMediaUploadQueue() {
  while (activeListingMediaUploads < LISTING_MEDIA_UPLOAD_CONCURRENCY && listingMediaUploadQueue.length) {
    const job = listingMediaUploadQueue.shift();
    activeListingMediaUploads += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeListingMediaUploads -= 1;
        drainListingMediaUploadQueue();
      });
  }
}

function isRetriableUploadError(error) {
  const status = Number(error?.status || 0);
  return error instanceof TypeError || [408, 429, 502, 503, 504].includes(status);
}

function createUploadRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function uploadTeamAttachment(file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/team/attachments", {
    method: "POST",
    body: formData,
    headers: uploadHeaders()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `附件上传失败：${response.status}`);
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

export function watermarkListingMedia(payload) {
  return apiClient.post("/api/listing/media/watermark", payload);
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
  if (!isLocalProtectedUrl(url)) return url;
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

function isLocalProtectedUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  if (value.startsWith("/")) return true;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}


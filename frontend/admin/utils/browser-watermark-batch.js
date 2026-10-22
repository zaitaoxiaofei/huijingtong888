import { uploadListingMedia, watermarkListingMedia, withImageToken } from "../api/tools/imageCropper";

export const BROWSER_WATERMARK_CONCURRENCY = 10;
// Server-side watermarking is intentionally serialized. The backend uses the
// same limit because each Sharp job holds full image buffers in memory.
export const SERVER_WATERMARK_FALLBACK_CONCURRENCY = 1;
const MAX_EDGE = 2000;
const CACHE_PREFIX = "browserWatermark:v2:";
let activeServerFallbacks = 0;
const pendingServerFallbacks = [];

export async function prepareBrowserWatermarkBatch({ productId, images, shops, onProgress = () => {} }) {
  const prepared = await prepareBrowserWatermarkJobs({
    jobs: [{ productId, images, shops }],
    onProgress
  });
  return prepared[String(productId)] || {};
}

export async function prepareBrowserWatermarkJobs({ jobs, onProgress = () => {} }) {
  const tasks = [];
  const results = {};
  for (const job of jobs || []) {
    results[String(job.productId)] = {};
    appendTasks(tasks, results[String(job.productId)], job);
  }
  let completed = 0;
  onProgress({ stage: "browser_watermark", completed, total: tasks.length, concurrency: BROWSER_WATERMARK_CONCURRENCY });
  await mapConcurrent(tasks, BROWSER_WATERMARK_CONCURRENCY, async (task) => {
    const item = await prepareOne(task);
    results[String(task.productId)][task.shop.id][task.index] = {
      ...item, source_url: task.sourceUrl, type: task.index === 0 ? "main" : "detail",
      sortOrder: task.index + 1, sort_order: task.index + 1
    };
    completed += 1;
    onProgress({ stage: "browser_watermark", completed, total: tasks.length, concurrency: BROWSER_WATERMARK_CONCURRENCY, shopId: task.shop.id });
  });
  await recoverDuplicatePreparedImages(tasks, results, onProgress);
  return Object.fromEntries(Object.entries(results).map(([productId, shops]) => [
    productId,
    Object.fromEntries(Object.entries(shops).map(([shopId, values]) => [shopId, values.filter(Boolean)]))
  ]));
}

function duplicatePreparedTasks(tasks, results) {
  const groups = new Map();
  for (const task of tasks) {
    const key = JSON.stringify([String(task.productId), String(task.shop.id)]);
    if (!groups.has(key)) groups.set(key, new Map());
    const byUrl = groups.get(key);
    const output = results[String(task.productId)]?.[task.shop.id]?.[task.index];
    const url = String(output?.publishUrl || output?.url || "").trim();
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(task);
  }
  return [...groups.values()].flatMap((byUrl) => [...byUrl.values()]
    .filter((matches) => new Set(matches.map((task) => task.sourceUrl)).size > 1).flat());
}

async function recoverDuplicatePreparedImages(tasks, results, onProgress) {
  const affected = duplicatePreparedTasks(tasks, results);
  if (!affected.length) return;
  const fingerprints = new Map();
  for (const task of affected) {
    const fingerprint = await watermarkFingerprint(task);
    fingerprints.set(task, fingerprint);
    try { localStorage.removeItem(`${CACHE_PREFIX}${fingerprint}`); } catch { /* Cache is optional. */ }
  }
  onProgress({ stage: "browser_watermark_recovery", completed: 0, total: affected.length, concurrency: 1 });
  let completed = 0;
  for (const task of affected) {
    const response = await withServerFallbackSlot(() => watermarkListingMedia({
      shopId: task.shop.id,
      images: [{ url: task.sourceUrl, name: `image-${task.index + 1}.jpg` }],
      sourceModule: "browser_batch_watermark_recovery",
      sourceId: `${task.productId}:${task.shop.id}:${task.index + 1}`
    }));
    const item = normalizeUploaded(response?.images?.[0] || {}, task.index, "server_recovery");
    if (!item.publishUrl) throw new Error(`草稿 ${task.productId} 的第 ${task.index + 1} 张图片重新处理后没有返回公网地址，请重新准备素材。`);
    results[String(task.productId)][task.shop.id][task.index] = { ...item, source_url: task.sourceUrl };
    completed += 1;
    onProgress({ stage: "browser_watermark_recovery", completed, total: affected.length, concurrency: 1, shopId: task.shop.id });
  }
  if (duplicatePreparedTasks(tasks, results).length) {
    throw new Error("部分不同图片重新处理后仍为相同素材，已停止上架。请检查原图是否内容相同，移除重复图片后重新准备。");
  }
  for (const task of affected) writeCache(fingerprints.get(task), results[String(task.productId)][task.shop.id][task.index]);
}

function appendTasks(tasks, results, { productId, images, shops }) {
  for (const shop of shops || []) {
    if (!shop.watermarkPath) continue;
    results[shop.id] = [];
    for (const [index, sourceUrl] of (images || []).entries()) tasks.push({ productId, shop, sourceUrl, index });
  }
}

async function prepareOne(task) {
  const fingerprint = await watermarkFingerprint(task);
  const cached = readCache(fingerprint);
  if (cached?.publishUrl) return cached;
  try {
    const file = await retry(() => renderWatermarkedFile(task), 3);
    try {
      const uploaded = await retry(() => uploadListingMedia(file, {
        source_module: "browser_batch_watermark",
        source_id: `${task.productId}:${task.shop.id}:${task.index + 1}`,
        shop_id: task.shop.id,
        role: task.index === 0 ? "main" : "detail",
        media_type: "image",
        generated_by: "browser_canvas",
        watermark_fingerprint: fingerprint
      }), 3);
      const item = normalizeUploaded(uploaded, task.index, "browser");
      if (!item.publishUrl) throw new Error("OSS 未返回公网图片地址");
      writeCache(fingerprint, item);
      return item;
    } catch (uploadError) {
      throw withFailureStage(uploadError, "browser_upload");
    } finally {
      // File/Blob becomes collectible immediately after upload finishes.
    }
  } catch (browserError) {
    if (browserError?.watermarkStage === "browser_upload") throw browserError;
    let fallback;
    try {
      fallback = await withServerFallbackSlot(() => retry(() => watermarkListingMedia({
        shopId: task.shop.id,
        images: [{ url: task.sourceUrl, name: `image-${task.index + 1}.jpg` }],
        sourceModule: "browser_batch_watermark_fallback",
        sourceId: `${task.productId}:${task.shop.id}:${task.index + 1}`
      }), 3));
    } catch (fallbackError) {
      const error = new Error(`草稿 ${task.productId} 的第 ${task.index + 1} 张图片处理失败：${fallbackError?.message || "服务端水印请求失败"}`);
      error.cause = fallbackError;
      error.watermarkStage = "server_fallback";
      error.productId = task.productId;
      error.imageIndex = task.index;
      error.sourceUrl = task.sourceUrl;
      throw error;
    }
    const item = normalizeUploaded(fallback?.images?.[0] || {}, task.index, "server_fallback");
    if (!item.publishUrl) throw browserError;
    writeCache(fingerprint, item);
    return item;
  }
}

function withFailureStage(error, stage) {
  const failure = error instanceof Error ? error : new Error(String(error || stage));
  failure.watermarkStage = stage;
  return failure;
}

async function withServerFallbackSlot(worker) {
  if (activeServerFallbacks >= SERVER_WATERMARK_FALLBACK_CONCURRENCY) {
    await new Promise((resolve) => pendingServerFallbacks.push(resolve));
  }
  activeServerFallbacks += 1;
  try {
    return await worker();
  } finally {
    activeServerFallbacks -= 1;
    pendingServerFallbacks.shift()?.();
  }
}

async function renderWatermarkedFile({ sourceUrl, shop, index }) {
  const [source, logo] = await Promise.all([
    loadImage(withImageToken(toCanvasReadableUrl(sourceUrl))),
    loadImage(withImageToken(shopWatermarkUrl(shop)))
  ]);
  const ratio = Math.min(1, MAX_EDGE / Math.max(source.naturalWidth, source.naturalHeight));
  const width = Math.max(1, Math.round(source.naturalWidth * ratio));
  const height = Math.max(1, Math.round(source.naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建水印画布");
  context.drawImage(source, 0, 0, width, height);
  const logoWidth = Math.max(1, Math.round(width * clamp(shop.watermarkScalePercent, 8, 45) / 100));
  const logoHeight = Math.max(1, Math.round(logo.naturalHeight * logoWidth / Math.max(1, logo.naturalWidth)));
  const { x, y } = watermarkPosition(shop, width, height, logoWidth, logoHeight);
  context.globalAlpha = clamp(shop.watermarkOpacityPercent, 10, 100) / 100;
  context.drawImage(logo, x, y, logoWidth, logoHeight);
  context.globalAlpha = 1;
  const blob = await canvasBlob(canvas, "image/jpeg", 0.9);
  canvas.width = 1;
  canvas.height = 1;
  return new File([blob], `watermarked-${shop.id}-${index + 1}.jpg`, { type: "image/jpeg" });
}

function toCanvasReadableUrl(url) {
  const value = String(url || "").trim();
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin && parsed.pathname === "/api/image-proxy") {
      parsed.searchParams.set("require_original", "1");
      return /^https?:\/\//i.test(value) ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    if (!/^https?:\/\//i.test(value)) return value;
    if (parsed.origin === window.location.origin) return value;
  } catch {
    return value;
  }
  return `/api/image-proxy?url=${encodeURIComponent(value)}&require_original=1`;
}

function shopWatermarkUrl(shop = {}) {
  const shopId = Number(shop.id || 0);
  if (Number.isInteger(shopId) && shopId > 0) {
    return `/api/tools/image-cropper/shop-watermark/${encodeURIComponent(shopId)}/file`;
  }
  return toCanvasReadableUrl(shop.watermarkPath);
}

function watermarkPosition(shop, width, height, logoWidth, logoHeight) {
  const margin = Math.max(12, Math.round(Math.min(width, height) * 0.025));
  const position = String(shop.watermarkPosition || "bottom-right");
  if (position === "custom") return {
    x: clamp(width * Number(shop.watermarkXPercent || 0) / 100, 0, width - logoWidth),
    y: clamp(height * Number(shop.watermarkYPercent || 0) / 100, 0, height - logoHeight)
  };
  const horizontal = position.includes("left") ? margin : position.includes("right") ? width - logoWidth - margin : (width - logoWidth) / 2;
  const vertical = position.includes("top") ? margin : position.includes("bottom") ? height - logoHeight - margin : (height - logoHeight) / 2;
  return { x: horizontal, y: vertical };
}

function loadImage(src) {
  return withTimeout(new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("浏览器读取图片失败"));
    image.src = src;
  }), 30000, "图片下载超时");
}

function canvasBlob(canvas, type, quality) {
  return withTimeout(new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片导出失败")), type, quality)), 30000, "图片导出超时");
}

async function watermarkFingerprint({ sourceUrl, shop }) {
  const value = JSON.stringify([sourceUrl, shop.watermarkPath, shop.watermarkPosition, shop.watermarkXPercent, shop.watermarkYPercent, shop.watermarkScalePercent, shop.watermarkOpacityPercent]);
  const data = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return value;
}

function normalizeUploaded(uploaded, index, generatedBy) {
  const publishUrl = String(uploaded.publishUrl || uploaded.publish_url || uploaded.url || "").trim();
  return { type: index === 0 ? "main" : "detail", sortOrder: index + 1, sort_order: index + 1, url: publishUrl, publishUrl, previewUrl: uploaded.previewUrl || uploaded.preview_url || publishUrl, generatedBy };
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      const index = cursor++;
      try {
        await worker(items[index]);
      } catch (error) {
        failure ||= error;
      }
    }
  });
  await Promise.allSettled(workers);
  if (failure) throw failure;
}

async function retry(fn, attempts) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function readCache(key) {
  try { return JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${key}`) || "null"); } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ ...value, cachedAt: Date.now() })); } catch { /* Cache is optional. */ }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

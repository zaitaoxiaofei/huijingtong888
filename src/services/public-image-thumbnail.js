import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { isManagedPublicImageSource } from "./server-image-request.js";
import { readManagedOssObject } from "./object-storage.js";
import { createImageReadCacheWriter } from "./image-read-cache.js";

const WIDTHS = new Set([128, 180, 256, 360]);
const SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES = 512 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const error = (message, status, code) => Object.assign(new Error(message), { status, statusCode: status, code });
const busy = () => error("图片缩略图处理繁忙，请稍后重试", 503, "IMAGE_THUMBNAIL_BUSY");
function isRasterBody(buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    || (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    || /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))
    || (buffer.toString("ascii", 4, 8) === "ftyp" && [8, 16, 20, 24, 28, 32].some(offset => /^avi[fs]$/.test(buffer.toString("ascii", offset, offset + 4))));
}

export function createPublicImageThumbnailService({
  env = process.env,
  cacheDirectory = path.resolve("runtime", "product-thumbnail-cache"),
  readSource = (url, options) => readManagedOssObject(url, { ...options, env }),
  isAllowed = url => isManagedPublicImageSource(url, { env }),
  now = Date.now,
  concurrency = 2,
  queuedLimit = 6,
  queueTimeoutMs = 2000
} = {}) {
  if (!path.isAbsolute(cacheDirectory) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
    || !Number.isInteger(queuedLimit) || queuedLimit < 0 || queuedLimit > 6 || !Number.isInteger(queueTimeoutMs)
    || queueTimeoutMs < 1 || queueTimeoutMs > 2000) throw new Error("Invalid public thumbnail bounds");
  const writer = createImageReadCacheWriter(cacheDirectory, { maxBytes: 32 * 1024 * 1024, now });
  const inflight = new Map(), failures = new Map(), waiters = [];
  let active = 0;
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); active += 1; next.resolve(); }
  }
  async function acquire() {
    if (active < concurrency) { active += 1; return; }
    if (waiters.length >= queuedLimit) throw busy();
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(busy()); }, queueTimeoutMs);
      waiters.push(waiter);
    });
  }
  const payload = (buffer, cacheState) => ({ buffer, contentType: "image/webp", cacheControl: "public, max-age=86400", cacheState });
  async function cached(filename) {
    try {
      const file = path.join(cacheDirectory, filename), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !info.size || info.size > THUMBNAIL_MAX_BYTES
        || now() - info.mtimeMs > CACHE_TTL_MS) return null;
      const buffer = await fs.readFile(file);
      if (!buffer.length || buffer.length > THUMBNAIL_MAX_BYTES || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
      return payload(buffer, "HIT");
    } catch { return null; }
  }
  async function derive(url, width, filename) {
    await acquire();
    try {
      const original = await readSource(url, { maxBytes: SOURCE_MAX_BYTES, timeoutMs: 6000 });
      if (!original?.buffer?.length || original.buffer.length > SOURCE_MAX_BYTES
        || !/^image\/(?:png|jpeg|webp|gif|avif)(?:;|$)/i.test(original.contentType || "") || !isRasterBody(original.buffer)) {
        throw error("原图格式或大小不适合生成列表缩略图", 422, "IMAGE_THUMBNAIL_SOURCE_UNSUPPORTED");
      }
      const expectedHash = /\/([a-f0-9]{64})\.[a-z0-9]+$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
      if (createHash("sha256").update(original.buffer).digest("hex") !== expectedHash) {
        throw error("原图内容校验失败，请使用原图预览核对", 422, "IMAGE_THUMBNAIL_SOURCE_MISMATCH");
      }
      const image = sharp(original.buffer, { limitInputPixels: 24 * 1024 * 1024, animated: false, pages: 1, failOn: "error" }).timeout({ seconds: 3 });
      const metadata = await image.metadata();
      if (!["png", "jpeg", "webp", "gif", "heif", "avif"].includes(metadata.format)
        || !metadata.width || !metadata.height || metadata.width > 12000 || metadata.height > 12000
        || metadata.width * metadata.height > 24 * 1024 * 1024 || Number(metadata.pages || 1) > 1) {
        throw error("原图尺寸或动画格式不适合生成列表缩略图", 422, "IMAGE_THUMBNAIL_SOURCE_UNSUPPORTED");
      }
      // Keep every source pixel's composition; the existing UI controls cover/contain.
      const buffer = await image.rotate().resize({ width, height: Math.ceil(width * 4 / 3), fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72, effort: 3 }).toBuffer();
      if (!buffer.length || buffer.length > THUMBNAIL_MAX_BYTES) throw error("缩略图超出大小限制", 422, "IMAGE_THUMBNAIL_OUTPUT_LIMIT");
      await writer.write([{ name: filename, buffer }]);
      return payload(buffer, "MISS");
    } catch (failure) {
      if ([422, 503].includes(failure?.statusCode) && /^IMAGE_THUMBNAIL_/.test(failure?.code || "")) throw failure;
      throw error("列表缩略图暂不可用，请稍后重试", 502, "IMAGE_THUMBNAIL_SOURCE_UNAVAILABLE");
    } finally { release(); }
  }
  return {
    async get(target, { width = 180, force = false } = {}) {
      let allowed = false;
      try { allowed = typeof target === "string" && target.length <= 4096 && isAllowed(target); } catch { /* Fail closed before any cache or SDK access. */ }
      if (!allowed || !WIDTHS.has(width)) throw error("仅支持本系统公开商品原图及指定缩略图尺寸", 400, "IMAGE_THUMBNAIL_TARGET_INVALID");
      const parsed = new URL(target), url = parsed.origin + parsed.pathname;
      const filename = createHash("sha256").update(`public-thumbnail-inside-v1:${url}:${width}:webp72`).digest("hex") + ".webp";
      if (!force) { const found = await cached(filename); if (found) return found; }
      if (String(env.OSS_INTERNAL_READ || "").trim().toLowerCase() !== "true") throw error("内网图片读取暂不可用，请使用原图", 503, "IMAGE_THUMBNAIL_INTERNAL_REQUIRED");
      const failed = failures.get(filename);
      if (!force && failed?.until > now()) throw failed.error;
      if (inflight.has(filename)) return inflight.get(filename);
      if (inflight.size >= concurrency + queuedLimit) throw busy();
      const work = derive(url, width, filename).then(result => { failures.delete(filename); return result; }).catch(failure => {
        failures.set(filename, { until: now() + 15000, error: failure });
        while (failures.size > 128) failures.delete(failures.keys().next().value);
        throw failure;
      }).finally(() => { if (inflight.get(filename) === work) inflight.delete(filename); });
      inflight.set(filename, work);
      return work;
    }
  };
}

const service = createPublicImageThumbnailService();
export const getPublicImageThumbnail = (target, options) => service.get(target, options);

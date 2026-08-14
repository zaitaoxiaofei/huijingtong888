import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import OSS from "ali-oss";

const DEFAULT_REMOTE_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_REMOTE_MEDIA_TIMEOUT_MS = 30000;
const DEFAULT_OSS_REQUEST_TIMEOUT_MS = 60000;

function trimSlashes(value = "") {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizeExtension(value = "") {
  const extension = String(value || "").trim().toLowerCase();
  if (!extension) return "";
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function managedOssObjectKeyFromUrl(url, storage) {
  try {
    const parsed = new URL(String(url || "").trim());
    const expectedHost = `${storage.bucket}.${storage.region}.aliyuncs.com`.toLowerCase();
    const customHost = storage.publicBaseUrl ? new URL(storage.publicBaseUrl).host.toLowerCase() : "";
    if (parsed.host.toLowerCase() !== expectedHost && (!customHost || parsed.host.toLowerCase() !== customHost)) return "";
    return parsed.pathname.replace(/^\/+/, "").split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

function createOssClient(storage, timeoutMs, client = null) {
  return client || new OSS({
    region: storage.region,
    bucket: storage.bucket,
    accessKeyId: storage.accessKeyId,
    accessKeySecret: storage.accessKeySecret,
    stsToken: storage.stsToken || undefined,
    secure: true,
    timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_OSS_REQUEST_TIMEOUT_MS)
  });
}

function ossStatus(error) {
  return Number(error?.status || error?.statusCode || error?.res?.status || 0);
}

function isMissingOssObject(error) {
  return ossStatus(error) === 404 || error?.code === "NoSuchKey";
}

export function buildContentAddressedObjectKey(buffer, {
  prefix = "listing-media",
  extension = ""
} = {}) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const hashSha256 = crypto.createHash("sha256").update(source).digest("hex");
  const cleanPrefix = trimSlashes(prefix);
  const objectName = `${hashSha256}${normalizeExtension(extension)}`;
  return {
    hashSha256,
    objectKey: [cleanPrefix, hashSha256.slice(0, 2), objectName].filter(Boolean).join("/")
  };
}

export function publicOssObjectUrl({
  region = "",
  bucket = "",
  objectKey = "",
  publicBaseUrl = ""
} = {}) {
  const base = String(publicBaseUrl || "").trim()
    || `https://${String(bucket || "").trim()}.${String(region || "").trim()}.aliyuncs.com`;
  const encodedKey = trimSlashes(objectKey)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base.replace(/\/+$/g, "")}/${encodedKey}`;
}

export function isManagedOssObjectUrl(url, {
  prefix = "",
  env = process.env
} = {}) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled || !storage.bucket) return false;
  try {
    const parsed = new URL(String(url || "").trim());
    const expectedHost = `${storage.bucket}.${storage.region}.aliyuncs.com`.toLowerCase();
    const customHost = storage.publicBaseUrl ? new URL(storage.publicBaseUrl).host.toLowerCase() : "";
    if (parsed.host.toLowerCase() !== expectedHost && (!customHost || parsed.host.toLowerCase() !== customHost)) return false;
    const cleanPrefix = trimSlashes(prefix);
    return !cleanPrefix || parsed.pathname.replace(/^\/+/, "").startsWith(`${cleanPrefix}/`);
  } catch {
    return false;
  }
}

export function mediaObjectPrefixForRetention({
  sourceModule = "",
  role = "",
  contentType = ""
} = {}) {
  const source = String(sourceModule || "").trim().toLowerCase();
  const mediaRole = String(role || "").trim().toLowerCase();
  const type = String(contentType || "").trim().toLowerCase();
  if (source.includes("collector")) return "collector-media";
  if (type.startsWith("video/") && /(^|[_-])(source|raw|reference)([_-]|$)/.test(mediaRole)) return "video-source";
  return "listing-media";
}

export function ossStorageConfig(env = process.env) {
  const enabled = String(env.OSS_ENABLED || "").trim().toLowerCase() === "true";
  const region = String(env.OSS_REGION || "").trim();
  const bucket = String(env.OSS_BUCKET || "").trim();
  const accessKeyId = String(env.OSS_ACCESS_KEY_ID || "").trim();
  const accessKeySecret = String(env.OSS_ACCESS_KEY_SECRET || "").trim();
  const stsToken = String(env.OSS_STS_TOKEN || "").trim();
  const publicBaseUrl = String(env.OSS_PUBLIC_BASE_URL || "").trim();
  if (enabled) {
    const missing = [];
    if (!region) missing.push("OSS_REGION");
    if (!bucket) missing.push("OSS_BUCKET");
    if (!accessKeyId) missing.push("OSS_ACCESS_KEY_ID");
    if (!accessKeySecret) missing.push("OSS_ACCESS_KEY_SECRET");
    if (missing.length) {
      throw new Error(`OSS_ENABLED=true requires: ${missing.join(", ")}`);
    }
  }
  return {
    enabled,
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    stsToken,
    publicBaseUrl
  };
}

export async function putContentAddressedObject(buffer, {
  prefix = "listing-media",
  extension = "",
  contentType = "application/octet-stream",
  timeoutMs = DEFAULT_OSS_REQUEST_TIMEOUT_MS,
  env = process.env,
  client = null
} = {}) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled) return null;
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const { hashSha256, objectKey } = buildContentAddressedObjectKey(source, { prefix, extension });
  const ossClient = createOssClient(storage, timeoutMs, client);
  let exists = false;
  try {
    await ossClient.head(objectKey);
    exists = true;
  } catch (error) {
    if (!isMissingOssObject(error)) throw error;
  }
  if (!exists) {
    await ossClient.put(objectKey, source, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });
  }
  const url = publicOssObjectUrl({
    region: storage.region,
    bucket: storage.bucket,
    objectKey,
    publicBaseUrl: storage.publicBaseUrl
  });
  return {
    driver: "oss",
    bucket: storage.bucket,
    objectKey,
    storageName: objectKey,
    hashSha256,
    size: source.length,
    reused: exists,
    url
  };
}

export async function putContentAddressedFile(filePath, {
  prefix = "listing-media",
  extension = "",
  contentType = "application/octet-stream",
  timeoutMs = DEFAULT_OSS_REQUEST_TIMEOUT_MS,
  env = process.env,
  client = null
} = {}) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled) return null;
  const hash = crypto.createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => { hash.update(chunk); size += chunk.length; });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const hashSha256 = hash.digest("hex");
  const cleanPrefix = trimSlashes(prefix);
  const objectName = `${hashSha256}${normalizeExtension(extension)}`;
  const objectKey = [cleanPrefix, hashSha256.slice(0, 2), objectName].filter(Boolean).join("/");
  const ossClient = createOssClient(storage, timeoutMs, client);
  let exists = false;
  try { await ossClient.head(objectKey); exists = true; } catch (error) {
    if (!isMissingOssObject(error)) throw error;
  }
  if (!exists) {
    await ossClient.putStream(objectKey, fs.createReadStream(filePath), {
      contentLength: size,
      headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" }
    });
  }
  return {
    driver: "oss", bucket: storage.bucket, objectKey, storageName: objectKey,
    hashSha256, size, reused: exists,
    url: publicOssObjectUrl({ region: storage.region, bucket: storage.bucket, objectKey, publicBaseUrl: storage.publicBaseUrl })
  };
}

export async function promoteManagedOssObjectUrl(url, {
  fromPrefix = "ai-unused",
  toPrefix = "listing-media",
  contentType = "",
  timeoutMs = DEFAULT_OSS_REQUEST_TIMEOUT_MS,
  env = process.env,
  client = null
} = {}) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled) return null;
  const sourceKey = managedOssObjectKeyFromUrl(url, storage);
  const cleanFromPrefix = trimSlashes(fromPrefix);
  if (!sourceKey || !sourceKey.startsWith(`${cleanFromPrefix}/`)) return null;
  const objectKey = [trimSlashes(toPrefix), sourceKey.slice(cleanFromPrefix.length + 1)].filter(Boolean).join("/");
  const ossClient = createOssClient(storage, timeoutMs, client);
  let reused = false;
  let sourceHead = null;
  let targetHead = null;
  try {
    targetHead = await ossClient.head(objectKey);
    reused = true;
  } catch (error) {
    if (!isMissingOssObject(error)) throw error;
  }
  if (!reused) {
    sourceHead = await ossClient.head(sourceKey);
    const sourceHeaders = sourceHead?.res?.headers || {};
    await ossClient.copy(objectKey, sourceKey, {
      headers: {
        "Content-Type": contentType || sourceHeaders["content-type"] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });
  }
  const filename = path.basename(objectKey);
  const hashSha256 = filename.match(/^([a-f0-9]{64})(?:\.|$)/i)?.[1]?.toLowerCase() || "";
  return {
    driver: "oss",
    bucket: storage.bucket,
    sourceKey,
    objectKey,
    storageName: objectKey,
    hashSha256,
    size: Number((targetHead || sourceHead)?.res?.headers?.["content-length"] || 0),
    reused,
    copied: !reused,
    url: publicOssObjectUrl({ region: storage.region, bucket: storage.bucket, objectKey, publicBaseUrl: storage.publicBaseUrl })
  };
}

function extensionForRemoteMedia(url = "", contentType = "") {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const known = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov"
  };
  if (known[type]) return known[type];
  try {
    return normalizeExtension(path.extname(new URL(String(url || "")).pathname));
  } catch {
    return "";
  }
}

export async function archiveRemoteMediaObjectUrl(url, {
  prefix = "product-media",
  maxBytes = DEFAULT_REMOTE_MEDIA_MAX_BYTES,
  timeoutMs = DEFAULT_REMOTE_MEDIA_TIMEOUT_MS,
  env = process.env,
  client = null,
  fetchImpl = fetch
} = {}) {
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) return "";
  const storage = ossStorageConfig(env);
  if (!storage.enabled || isManagedOssObjectUrl(sourceUrl, { env })) return sourceUrl;
  if (!/^https:\/\//i.test(sourceUrl)) {
    throw new Error(`Only HTTPS media can be archived to OSS: ${sourceUrl.slice(0, 160)}`);
  }
  const response = await fetchImpl(sourceUrl, {
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DEFAULT_REMOTE_MEDIA_TIMEOUT_MS))
  });
  if (!response.ok) throw new Error(`Download media failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  const byteLimit = Math.max(1, Number(maxBytes) || DEFAULT_REMOTE_MEDIA_MAX_BYTES);
  if (contentLength > byteLimit) throw new Error(`Remote media exceeds ${byteLimit} bytes`);
  if (!response.body) throw new Error("Downloaded media is empty");
  const contentType = String(response.headers?.get?.("content-type") || "application/octet-stream").split(";")[0].trim();
  const temporaryPath = path.join(os.tmpdir(), `ozon-media-${crypto.randomUUID()}${extensionForRemoteMedia(sourceUrl, contentType) || ".bin"}`);
  let receivedBytes = 0;
  const byteLimiter = new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > byteLimit) return callback(new Error(`Remote media exceeds ${byteLimit} bytes`));
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), byteLimiter, fs.createWriteStream(temporaryPath));
    if (!receivedBytes) throw new Error("Downloaded media is empty");
    const stored = await putContentAddressedFile(temporaryPath, {
      prefix,
      extension: extensionForRemoteMedia(sourceUrl, contentType),
      contentType,
      timeoutMs,
      env,
      client
    });
    if (!stored?.url) throw new Error("OSS did not return a public media URL");
    return stored.url;
  } finally {
    await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

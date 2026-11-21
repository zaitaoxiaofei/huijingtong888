import { requestPublicImage } from "../http/public-image-request.js";
import { isManagedOssObjectUrl, readManagedOssObject } from "./object-storage.js";

// These public image namespaces may use server credentials. Private task media
// continues through its authenticated owner route and local cache recovery.
function publicManagedImage(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
    && /^\/(?:listing-media|product-media|collector-media|ai-unused|video-source)\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(parsed.pathname);
}

export function isManagedPublicImageSource(url, { env = process.env, isManaged = isManagedOssObjectUrl } = {}) {
  return isManaged(url, { env }) && publicManagedImage(url);
}

export async function requestServerImage(url, options = {}, {
  isManaged = isManagedOssObjectUrl,
  readManaged = readManagedOssObject,
  request = requestPublicImage
} = {}) {
  const { signal, beforeRequest, maxBytes = 20 * 1024 * 1024, timeoutMs = 20000 } = options;
  const check = async () => {
    signal?.throwIfAborted();
    await beforeRequest?.();
    signal?.throwIfAborted();
  };
  await check();
  let image;
  if (isManagedPublicImageSource(url, { isManaged })) {
    try { image = await readManaged(url, { maxBytes, timeoutMs }); }
    catch (error) {
      // Match the public image reader's null result for empty/oversize bodies.
      if (/^OSS object (?:exceeds \d+ bytes|is empty)$/.test(error.message || "")) image = null;
      else throw error;
    }
    if (image && (!image.buffer?.length || image.buffer.length > maxBytes || !String(image.contentType || "").startsWith("image/"))) image = null;
  } else image = await request(url, options);
  await check();
  return image;
}

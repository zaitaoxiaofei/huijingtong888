import sharp from "sharp";
import { ossInternalEnabled } from "./oss-client.js";
import { isManagedPublicImageSource, requestServerImage } from "./server-image-request.js";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_BYTES = 512 * 1024;
const MAX_REQUEST_INLINE_BYTES = 2 * 1024 * 1024;
let activePreparations = 0;

async function losslessWebp(buffer) {
  // libvips may expose only the first frame of APNG. Conservatively leave any
  // PNG carrying its animation-control marker on the original provider path.
  if (buffer.includes(Buffer.from("acTL"))) return null;
  const image = sharp(buffer, { limitInputPixels: 40_000_000 }).timeout({ seconds: 3 });
  const metadata = await image.metadata();
  // WebP is 8-bit. Do not flatten animation, resize, discard orientation or
  // convert colour profiles/16-bit originals as a bandwidth optimization.
  if (metadata.format !== "png" || metadata.depth !== "uchar" || metadata.icc
    || (metadata.pages || 1) !== 1 || (metadata.orientation || 1) !== 1) return null;
  return image.webp({ lossless: true, exact: true, effort: 2 }).toBuffer();
}

// Preserve the provider, model and image pixels. Base64 is NOT automatically
// cheaper: our EIP is 0.8 CNY/GB while OSS egress is 0.25-0.5 CNY/GB. Only
// replace a URL when the entire inline value is <= 25% of the source bytes.
export async function prepareVisionImageTransfers(messages, {
  env = process.env,
  beforeRequest,
  signal,
  readImage = requestServerImage,
  encodeImage = losslessWebp
} = {}) {
  // Optional compression must not let concurrent vision requests exhaust ECS
  // memory/CPU. Busy requests keep their existing provider URL path.
  if (!ossInternalEnabled(env) || activePreparations) return messages;
  activePreparations++;
  try {
    return await prepareTransfers(messages, { env, beforeRequest, signal, readImage, encodeImage });
  } finally { activePreparations--; }
}

async function prepareTransfers(messages, { env, beforeRequest, signal, readImage, encodeImage }) {
  const deadline = Date.now() + 20000;
  const resolved = new Map();
  let inlineBytes = 0;
  const check = async () => {
    signal?.throwIfAborted();
    await beforeRequest?.();
    signal?.throwIfAborted();
  };
  const prepare = async (url) => {
    let eligible = false;
    try { eligible = isManagedPublicImageSource(url, { env }) && new URL(url).pathname.endsWith(".png"); }
    catch { /* Leave malformed/unsupported URLs to the existing provider boundary. */ }
    if (!eligible) return url;
    if (!resolved.has(url)) {
      if (resolved.size >= 8 || Date.now() >= deadline - 1000) return url;
      await check();
      const image = await readImage(url, { maxBytes: MAX_SOURCE_BYTES, timeoutMs: Math.max(1000, deadline - Date.now()), signal, beforeRequest });
      await check();
      if (!image?.buffer?.length || image.buffer.length > MAX_SOURCE_BYTES || !String(image.contentType || "").startsWith("image/")) {
        throw Object.assign(new Error("Managed vision image is unavailable or exceeds the image limit"), { statusCode: 400 });
      }
      let encoded;
      try { encoded = await encodeImage(image.buffer); }
      catch { /* Encoding is optional; a valid original URL remains usable. */ }
      await check();
      const dataUrl = encoded?.length ? `data:image/webp;base64,${encoded.toString("base64")}` : "";
      const bytes = Buffer.byteLength(dataUrl);
      resolved.set(url, dataUrl && bytes <= MAX_INLINE_BYTES && bytes <= image.buffer.length * 0.25 ? dataUrl : url);
    }
    const candidate = resolved.get(url);
    const bytes = Buffer.byteLength(candidate);
    const replacement = candidate !== url && inlineBytes + bytes <= MAX_REQUEST_INLINE_BYTES ? candidate : url;
    if (replacement !== url) inlineBytes += bytes;
    return replacement;
  };
  const result = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { result.push(message); continue; }
    const content = [];
    for (const item of message.content) {
      if (item?.type !== "image_url" || typeof item.image_url?.url !== "string") { content.push(item); continue; }
      content.push({ ...item, image_url: { ...item.image_url, url: await prepare(item.image_url.url) } });
    }
    result.push({ ...message, content });
  }
  await check();
  return result;
}

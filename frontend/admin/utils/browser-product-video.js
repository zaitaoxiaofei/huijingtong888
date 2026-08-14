import { uploadListingMedia, withImageToken } from "../api/tools/imageCropper";

const WIDTH = 900;
const HEIGHT = 1200;
const FPS = 30;
const DEFAULT_DURATION_SECONDS = 10;
const MP4_TYPES = ["video/mp4;codecs=avc1.42E01E", "video/mp4"];

export function browserProductVideoSupported() {
  return typeof document !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && typeof MediaRecorder.isTypeSupported === "function"
    && typeof HTMLCanvasElement !== "undefined"
    && typeof HTMLCanvasElement.prototype.captureStream === "function"
    && Boolean(browserMp4MimeType());
}

export async function generateBrowserProductVideo(payload = {}, options = {}) {
  if (!browserProductVideoSupported()) throw new Error("当前浏览器不支持 MP4 视频录制");
  const imageUrl = String(payload.imageUrl || payload.image_url || payload.coverImageUrl || "").trim();
  if (!imageUrl) throw new Error("缺少视频主图");
  const image = await loadImage(withImageToken(imageUrl));
  const durationSeconds = Math.max(3, Math.min(10, Number(payload.durationSeconds || payload.duration_seconds || DEFAULT_DURATION_SECONDS)));
  const mimeType = browserMp4MimeType();
  const blob = await recordCanvasVideo({ image, durationSeconds, mimeType });
  const sourceId = String(payload.sourceId || payload.source_id || payload.productName || payload.title || Date.now()).trim();
  const fileName = `${safeFileStem(payload.title || payload.productName || sourceId || "product")}-video.mp4`;
  const file = new File([blob], fileName, { type: mimeType });
  const uploaded = await uploadListingMedia(file, {
    source_module: options.sourceModule || "browser_product_video",
    source_id: sourceId,
    role: "video",
    media_type: "video",
    generated_by: "browser_canvas_media_recorder",
    duration_seconds: durationSeconds
  });
  const publishUrl = String(uploaded.publishUrl || uploaded.publish_url || uploaded.url || "").trim();
  if (!publishUrl) throw new Error("浏览器视频已生成，但 OSS 未返回公网地址");
  const video = {
    url: publishUrl,
    publishUrl,
    publish_url: publishUrl,
    previewUrl: uploaded.previewUrl || uploaded.preview_url || publishUrl,
    preview_url: uploaded.previewUrl || uploaded.preview_url || publishUrl,
    name: uploaded.originalName || uploaded.original_name || fileName,
    contentType: uploaded.contentType || uploaded.mime_type || mimeType,
    size: uploaded.size || uploaded.file_size || blob.size,
    generatedBy: "browser_canvas_media_recorder"
  };
  return { ok: true, browserGenerated: true, video, cover: { ...video } };
}

function browserMp4MimeType() {
  return MP4_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("浏览器无法读取主图，已切换服务器生成"));
    image.src = src;
  });
}

function recordCanvasVideo({ image, durationSeconds, mimeType }) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return reject(new Error("浏览器无法创建视频画布"));
    const stream = canvas.captureStream(FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    const durationMs = durationSeconds * 1000;
    let startedAt = 0;
    let frameId = 0;
    let settled = false;
    recorder.ondataavailable = (event) => event.data?.size && chunks.push(event.data);
    recorder.onerror = () => finish(new Error("浏览器视频录制失败"));
    recorder.onstop = () => finish(null, new Blob(chunks, { type: mimeType }));

    function finish(error, blob) {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameId);
      stream.getTracks().forEach((track) => track.stop());
      if (error) reject(error);
      else if (!blob?.size) reject(new Error("浏览器没有生成有效视频"));
      else resolve(blob);
    }

    function draw(now) {
      if (!startedAt) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      drawFrame(context, image, progress);
      if (progress < 1) frameId = requestAnimationFrame(draw);
      else setTimeout(() => recorder.state === "recording" && recorder.stop(), 100);
    }

    recorder.start(250);
    frameId = requestAnimationFrame(draw);
    setTimeout(() => recorder.state === "recording" && recorder.stop(), durationMs + 800);
  });
}

function drawFrame(context, image, progress) {
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  const scale = Math.max(WIDTH / image.width, HEIGHT / image.height) * (1.025 + eased * 0.055);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = (WIDTH - width) / 2 + Math.sin(progress * Math.PI * 2) * WIDTH * 0.008;
  const y = (HEIGHT - height) / 2 + Math.cos(progress * Math.PI * 2) * HEIGHT * 0.006;
  context.drawImage(image, x, y, width, height);
  const shineX = WIDTH * (progress * 1.5 - 0.3);
  const shine = context.createLinearGradient(shineX - WIDTH * 0.15, 0, shineX + WIDTH * 0.15, 0);
  shine.addColorStop(0, "rgba(255,255,255,0)");
  shine.addColorStop(0.5, "rgba(255,255,255,0.28)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = shine;
  context.fillRect(0, 0, WIDTH, HEIGHT);
}

function safeFileStem(value) {
  return String(value || "product").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "product";
}

import path from "node:path";
import {
  convertTaskCropsToRatio,
  createEnhancedTaskZip,
  createRatioTaskZip,
  createTaskZip,
  createWatermarkedTaskZip,
  detectAndCropImage,
  enhanceTaskCrops,
  getShopWatermarkFile,
  getTaskFile,
  saveShopWatermark,
  saveUploadedImage,
  streamFile,
  watermarkTaskCrops
} from "../../services/tools/imageCropperService.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadImage(req) {
  const file = await readMultipartImage(req);
  return saveUploadedImage(file);
}

export async function uploadShopWatermark(req, shopId) {
  const file = await readMultipartImage(req);
  return saveShopWatermark({ shopId, ...file });
}

export async function detectImage(req, readJson) {
  const body = await readJson(req);
  return detectAndCropImage({
    taskId: body.taskId,
    imagePath: body.imagePath,
    mode: body.mode,
    rows: body.rows,
    cols: body.cols,
    trimBorder: body.trimBorder,
    backgroundColor: body.backgroundColor,
    threshold: body.threshold,
    minAreaRatio: body.minAreaRatio,
    mergeDistance: body.mergeDistance,
    padding: body.padding,
    roundCornerTolerance: body.roundCornerTolerance,
    manualBoxes: body.manualBoxes
  });
}

export async function enhanceImage(req, readJson) {
  const body = await readJson(req);
  return enhanceTaskCrops({
    taskId: body.taskId,
    filenames: body.filenames
  });
}

export async function convertRatioImage(req, readJson) {
  const body = await readJson(req);
  return convertTaskCropsToRatio({
    taskId: body.taskId,
    filenames: body.filenames
  });
}

export async function watermarkImage(req, readJson) {
  const body = await readJson(req);
  return watermarkTaskCrops({
    taskId: body.taskId,
    shopId: body.shopId,
    filenames: body.filenames,
    options: body.options
  });
}

export async function sendTaskImage({ res, writeHead, taskId, filename }) {
  const file = await getTaskFile(taskId, filename);
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Cache-Control": "private, max-age=3600"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function downloadCrop({ res, writeHead, taskId, filename }) {
  const file = await getTaskFile(taskId, path.join("crops", filename));
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "no-store"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function downloadEnhancedCrop({ res, writeHead, taskId, filename }) {
  const file = await getTaskFile(taskId, path.join("enhanced", filename));
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "no-store"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function downloadRatioCrop({ res, writeHead, taskId, filename }) {
  const file = await getTaskFile(taskId, path.join("ratio-3x4", filename));
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "no-store"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function downloadWatermarkedCrop({ res, writeHead, taskId, filename }) {
  const file = await getTaskFile(taskId, path.join("watermarked", filename));
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "no-store"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function sendShopWatermark({ res, writeHead, shopId }) {
  const file = await getShopWatermarkFile(shopId);
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Cache-Control": "no-store"
  });
  return streamFile(file.filePath).pipe(res);
}

export async function downloadZip({ res, writeHead, taskId, batch = "" }) {
  const zip = await createTaskZip(taskId, batch);
  writeHead(res, 200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.buffer.length,
    "Content-Disposition": contentDisposition(zip.filename),
    "Cache-Control": "no-store"
  });
  return res.end(zip.buffer);
}

export async function downloadEnhancedZip({ res, writeHead, taskId, batch = "" }) {
  const zip = await createEnhancedTaskZip(taskId, batch);
  writeHead(res, 200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.buffer.length,
    "Content-Disposition": contentDisposition(zip.filename),
    "Cache-Control": "no-store"
  });
  return res.end(zip.buffer);
}

export async function downloadRatioZip({ res, writeHead, taskId, batch = "" }) {
  const zip = await createRatioTaskZip(taskId, batch);
  writeHead(res, 200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.buffer.length,
    "Content-Disposition": contentDisposition(zip.filename),
    "Cache-Control": "no-store"
  });
  return res.end(zip.buffer);
}

export async function downloadWatermarkedZip({ res, writeHead, taskId, batch = "" }) {
  const zip = await createWatermarkedTaskZip(taskId, batch);
  writeHead(res, 200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.buffer.length,
    "Content-Disposition": contentDisposition(zip.filename),
    "Cache-Control": "no-store"
  });
  return res.end(zip.buffer);
}

export async function readMultipartImage(req) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    const error = new Error("请使用 multipart/form-data 上传图片");
    error.status = 400;
    throw error;
  }

  const body = await readBodyBuffer(req, MAX_UPLOAD_BYTES + 1024 * 1024);
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = splitMultipartBody(body, boundary);
  for (const part of parts) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headerText = part.subarray(0, separator).toString("utf8");
    if (!/name="file"/i.test(headerText)) continue;
    const filename = headerText.match(/filename="([^"]*)"/i)?.[1] || "upload.png";
    const partContentType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
    return {
      filename,
      contentType: partContentType,
      buffer: part.subarray(separator + 4)
    };
  }

  const error = new Error("未找到上传图片字段 file");
  error.status = 400;
  throw error;
}

async function readBodyBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("图片不能超过 25MB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function splitMultipartBody(body, boundary) {
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    parts.push(body.subarray(start, end));
    start = next;
  }
  return parts;
}

function contentDisposition(filename) {
  const fallback = String(filename).replace(/[^\w.-]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

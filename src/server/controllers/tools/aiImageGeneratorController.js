import path from "node:path";
import {
  createAiTaskZip,
  cropGeneratedImages,
  generateImages,
  getAiTaskFile,
  optimizePrompt,
  streamAiFile
} from "../../services/ai/aiWorkflowService.js";

export async function generateImage(req, readJson) {
  const result = await generateImages(await readJson(req));
  return {
    ...result,
    images: result.generatedImages
  };
}

export async function cropImage(req, readJson) {
  const body = await readJson(req);
  const taskId = body.taskId;
  const imagePaths = Array.isArray(body.imagePaths) ? body.imagePaths : [body.imagePath].filter(Boolean);
  const generatedImages = imagePaths.map((imagePath) => ({
    filename: path.basename(String(imagePath || "").replace(/\\/g, "/"))
  }));
  const result = await cropGeneratedImages({ taskId, generatedImages, cropMode: body.cropMode || "auto" });
  return {
    taskId,
    crops: result.croppedImages,
    zipUrl: `/api/ai/download-zip/${encodeURIComponent(taskId)}`,
    cropStatus: result.cropStatus,
    cropMessage: result.cropMessage
  };
}

export async function optimizePromptAction(req, readJson) {
  const result = await optimizePrompt(await readJson(req));
  return {
    ...result,
    prompt: result.finalPrompt
  };
}

export { optimizePromptAction as optimizePrompt };

export async function sendAiTaskImage({ res, writeHead, taskId, scope, filename }) {
  const file = await getAiTaskFile(taskId, scope, filename);
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Cache-Control": "private, max-age=3600"
  });
  return streamAiFile(file.filePath).pipe(res);
}

export async function downloadAiZip({ res, writeHead, taskId }) {
  const zip = await createAiTaskZip(taskId);
  writeHead(res, 200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.buffer.length,
    "Content-Disposition": contentDisposition(zip.filename),
    "Cache-Control": "no-store"
  });
  return res.end(zip.buffer);
}

function contentDisposition(filename) {
  const fallback = String(filename).replace(/[^\w.-]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

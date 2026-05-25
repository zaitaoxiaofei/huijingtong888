import {
  createAiTaskZip,
  generateImages,
  generateWorkflow,
  getAiStatus,
  getAiTaskFile,
  optimizePrompt,
  streamAiFile
} from "../services/ai/aiWorkflowService.js";

export function status() {
  return getAiStatus();
}

export async function optimizePromptAction(req, readJson) {
  return optimizePrompt(await readJson(req));
}

export async function generateImagesAction(req, readJson) {
  return generateImages(await readJson(req));
}

export async function generateWorkflowAction(req, readJson) {
  return generateWorkflow(await readJson(req));
}

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

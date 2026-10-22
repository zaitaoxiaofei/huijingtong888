import { withAiTenantSession } from "../../services/ai-tenant-context.js";
import {
  createAiTaskZip,
  generateCommerceCopy,
  generateImages,
  generateWorkflow,
  getAiStatus,
  getAiTaskFile,
  optimizePrompt,
  streamAiFile,
  testCopyGeneration
} from "../services/ai/aiWorkflowService.js";

export function status() {
  return getAiStatus();
}

export async function optimizePromptAction(req, readJson) {
  const body = await readJson(req);
  return withAiTenantSession(req._session, () => optimizePrompt(body));
}

export async function generateImagesAction(req, readJson) {
  const body = await readJson(req);
  return withAiTenantSession(req._session, () => generateImages(body));
}

export async function generateWorkflowAction(req, readJson) {
  const body = await readJson(req);
  return withAiTenantSession(req._session, () => generateWorkflow(body));
}

export async function generateCommerceCopyAction(req, readJson) {
  const body = await readJson(req);
  return withAiTenantSession(req._session, () => generateCommerceCopy(body));
}

export async function testCopyGenerationAction(req, readJson) {
  const body = await readJson(req);
  return withAiTenantSession(req._session, () => testCopyGeneration(body));
}

export async function sendAiTaskImage({ res, writeHead, taskId, scope, filename, session }) {
  const file = await getAiTaskFile(taskId, scope, filename, session);
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Length": file.size,
    "Cache-Control": "private, max-age=3600"
  });
  return streamAiFile(file.filePath).pipe(res);
}

export async function downloadAiZip({ res, writeHead, taskId, session }) {
  const zip = await createAiTaskZip(taskId, session);
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

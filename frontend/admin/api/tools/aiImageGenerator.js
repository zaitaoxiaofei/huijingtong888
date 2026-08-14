import { apiClient, getAuthToken, streamApiResponse } from "../../utils/api";
import { browserProductVideoSupported, generateBrowserProductVideo } from "../../utils/browser-product-video";

const AI_TASK_POLL_DELAYS_MS = [1500, 2500, 4000, 5000];

export class AiTaskStillRunningError extends Error {
  constructor(task, message = "AI 图片仍在后台生成，可继续等待或稍后拉回结果") {
    super(message);
    this.name = "AiTaskStillRunningError";
    this.code = "AI_TASK_STILL_RUNNING";
    this.taskId = task?.taskId || task?.taskNo || "";
    this.task = task || null;
    this.recoverable = true;
  }
}

function aiTaskPollDelay(attempt) {
  return AI_TASK_POLL_DELAYS_MS[Math.min(Math.max(0, attempt), AI_TASK_POLL_DELAYS_MS.length - 1)];
}

function waitForAiTaskUpdate(taskId, fallbackMs) {
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(cleanup, fallbackMs);
    function onUpdate(event) {
      if (event?.detail?.taskId !== taskId) return;
      cleanup();
    }
    function cleanup() {
      globalThis.clearTimeout(timeout);
      globalThis.removeEventListener?.("erp:ai-task-update", onUpdate);
      resolve();
    }
    globalThis.addEventListener?.("erp:ai-task-update", onUpdate);
  });
}

export function getAiStatus() {
  return apiClient.get("/api/ai/status");
}

export function streamAiProviderResponse(payload, options = {}) {
  return streamApiResponse("/api/ai-provider/stream", payload, options);
}

export async function generateAiImages(payload, options = {}) {
  const taskId = String(options.taskId || options.task_id || "") || await createAiImageTask(payload, options);
  if (!taskId) throw new Error("AI 图片任务创建失败");
  const deadline = Date.now() + Math.max(60_000, Number(options.timeoutMs || 10 * 60 * 1000));
  let pollAttempt = 0;
  while (Date.now() < deadline) {
    const tasks = await apiClient.get(`/api/ai-generation/tasks?taskIds=${encodeURIComponent(taskId)}&includePayload=1`, { noCache: true });
    const task = Array.isArray(tasks) ? tasks[0] : null;
    if (task?.status === "done") return task.output || {};
    if (task?.status === "provider_pending") {
      await apiClient.post(`/api/ai-generation/tasks/${encodeURIComponent(taskId)}/retry`, {});
      await waitForAiTaskUpdate(taskId, aiTaskPollDelay(pollAttempt++));
      continue;
    }
    if (["failed", "cancelled"].includes(String(task?.status || ""))) {
      throw new Error(task?.error?.message || "AI 图片生成失败");
    }
    await waitForAiTaskUpdate(taskId, aiTaskPollDelay(pollAttempt++));
  }
  const tasks = await apiClient.get(`/api/ai-generation/tasks?taskIds=${encodeURIComponent(taskId)}&includePayload=1`, { noCache: true }).catch(() => []);
  throw new AiTaskStillRunningError(Array.isArray(tasks) ? tasks[0] : { taskId });
}

export async function createAiImageTask(payload, options = {}) {
  const created = await apiClient.post("/api/ai-generation/tasks", {
    fieldKey: "mainImage",
    sourceModule: options.sourceModule || "ai_image_generator",
    input: payload
  });
  return created?.taskId || created?.taskIds?.[0] || "";
}

export async function pullAiImageTaskResult(taskId, options = {}) {
  const tasks = await apiClient.get(`/api/ai-generation/tasks?taskIds=${encodeURIComponent(taskId)}&includePayload=1`, { noCache: true });
  const task = Array.isArray(tasks) ? tasks[0] : null;
  if (!task) throw new Error("AI 图片任务不存在或已清理");
  if (task.status === "done") return task.output || {};
  if (task.status === "provider_pending" && options.resume !== false) {
    await apiClient.post(`/api/ai-generation/tasks/${encodeURIComponent(taskId)}/retry`, {});
  }
  if (["failed", "cancelled"].includes(String(task.status || ""))) throw new Error(task?.error?.message || "AI 图片生成失败");
  throw new AiTaskStillRunningError(task);
}

export async function generateAiVideo(payload, options = {}) {
  if (options.browser !== false && browserProductVideoSupported()) {
    try {
      return await generateBrowserProductVideo(payload, options);
    } catch (error) {
      if (options.serverFallback === false) throw error;
      console.warn("[browser-product-video] fallback to server:", error?.message || error);
    }
  }
  const created = await apiClient.post("/api/ai-generation/tasks", {
    fieldKey: "video",
    sourceModule: options.sourceModule || "ai_video_generator",
    input: {
      ...payload,
      listingVariantMedia: Boolean(options.listingVariantMedia)
    }
  });
  const taskId = created?.taskId || created?.taskIds?.[0];
  if (!taskId) throw new Error("AI 视频任务创建失败");
  const deadline = Date.now() + Math.max(60_000, Number(options.timeoutMs || 15 * 60 * 1000));
  let pollAttempt = 0;
  while (Date.now() < deadline) {
    const tasks = await apiClient.get(`/api/ai-generation/tasks?taskIds=${encodeURIComponent(taskId)}&includePayload=1`, { noCache: true });
    const task = Array.isArray(tasks) ? tasks[0] : null;
    if (task?.status === "done") return task.output || {};
    if (["failed", "cancelled"].includes(String(task?.status || ""))) {
      throw new Error(task?.error?.message || "AI 视频生成失败");
    }
    await waitForAiTaskUpdate(taskId, aiTaskPollDelay(pollAttempt++));
  }
  throw new Error("AI 视频生成超时，请在任务记录中查看结果");
}

export function generateAiWorkflow(payload) {
  return apiClient.post("/api/ai/generate-workflow", payload);
}

export async function generateAiCommerceCopy(payload, options = {}) {
  const created = await apiClient.post("/api/ai-generation/tasks", {
    fieldKey: "commerceCopy",
    sourceModule: "ai_commerce_copy",
    input: payload
  });
  const taskId = created?.taskId || created?.taskIds?.[0];
  if (!taskId) throw new Error("AI 文案任务创建失败");
  const deadline = Date.now() + Math.max(60_000, Number(options.timeoutMs || 5 * 60 * 1000));
  let pollAttempt = 0;
  while (Date.now() < deadline) {
    const tasks = await apiClient.get(`/api/ai-generation/tasks?taskIds=${encodeURIComponent(taskId)}&includePayload=1`, { noCache: true });
    const task = Array.isArray(tasks) ? tasks[0] : null;
    if (task?.status === "done") return task.output || {};
    if (["failed", "cancelled"].includes(String(task?.status || ""))) {
      throw new Error(task?.error?.message || "AI 文案生成失败");
    }
    await waitForAiTaskUpdate(taskId, aiTaskPollDelay(pollAttempt++));
  }
  throw new Error("AI 文案生成超时，请在任务记录中查看结果");
}

export function testAiCopyGeneration(payload) {
  return apiClient.post("/api/ai/copy-generation-test", payload);
}

export function optimizeAiPrompt(payload) {
  return apiClient.post("/api/ai/optimize-prompt", payload);
}

export function withImageToken(url) {
  const token = getAuthToken();
  if (!token || !url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function downloadUrl(url) {
  return withImageToken(url);
}

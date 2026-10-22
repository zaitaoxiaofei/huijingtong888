import { randomUUID } from "node:crypto";
import { authorizeBusinessTaskSession } from "./business-task-tenant.js";

// Task handles are private to their enterprise, including progress and cancellation.
export function createTenantBackgroundTasks({ authorize = authorizeBusinessTaskSession } = {}) {
  const tasks = new Map();
  function key(session, kind) {
    const id = Number(session?.tenant?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("任务缺少企业上下文"), { statusCode: 403 });
    return `${id}:${kind}`;
  }
  function view(task) {
    if (!task) return { task_id: "", running: false, started_at: "", finished_at: "", progress: null, result: null, error: "" };
    const { controller, ...snapshot } = task;
    return structuredClone(snapshot);
  }
  return {
    async snapshot(session, kind) {
      const current = await authorize(session);
      return view(tasks.get(key(current, kind)));
    },
    async cancel(session, kind) {
      const current = await authorize(session);
      const task = tasks.get(key(current, kind));
      if (task?.running) task.controller.abort(new Error("用户取消了任务"));
      return { cancelling: Boolean(task?.running), ...view(task) };
    },
    async start(session, kind, run, metadata = {}) {
      const current = await authorize(session);
      const taskKey = key(current, kind);
      const existing = tasks.get(taskKey);
      if (existing?.running) return { started: false, queued: false, reason: "already_running", ...view(existing) };
      const task = { ...metadata, task_id: randomUUID(), running: true, started_at: new Date().toISOString(), finished_at: "", progress: null, result: null, error: "", controller: new AbortController() };
      tasks.set(taskKey, task);
      // Bound completed state; a running task is never evicted or replaced.
      if (tasks.size > 500) for (const [oldKey, old] of tasks) {
        if (tasks.size <= 500) break;
        if (!old.running && oldKey !== taskKey) tasks.delete(oldKey);
      }
      void Promise.resolve().then(async () => {
        const restored = await authorize(current);
        task.result = await run({ session: restored, signal: task.controller.signal, onProgress: progress => {
          if (tasks.get(taskKey) === task && task.running) task.progress = structuredClone(progress);
        } });
        task.progress = { phase: "done", message: "任务已完成" };
      }).catch(error => {
        task.error = error?.message || String(error);
        task.progress = { phase: "failed", message: task.error };
      }).finally(() => {
        task.running = false;
        task.finished_at = new Date().toISOString();
      });
      return { started: true, queued: true, ...view(task) };
    }
  };
}

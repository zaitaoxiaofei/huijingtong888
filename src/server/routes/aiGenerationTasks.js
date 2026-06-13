export function createAiGenerationTaskRoutes({ services, readJson }) {
  return {
    "POST /api/ai-generation/tasks": async (req) => services.createAiGenerationTasks(await readJson(req), req._session),
    "GET /api/ai-generation/tasks": (req) => services.aiGenerationTasks(req.query || {}, req._session)
  };
}

export async function handleAiGenerationTaskRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (parts[0] !== "api" || parts[1] !== "ai-generation") return false;

  if (req.method === "POST" && parts[2] === "tasks" && parts[3] && parts[4] === "retry") {
    return json(res, await services.retryAiGenerationTask(decodeURIComponent(parts[3]), req._session));
  }

  return false;
}

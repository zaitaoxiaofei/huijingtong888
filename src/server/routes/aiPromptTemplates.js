export function createAiPromptTemplateRoutes({ services, readJson }) {
  return {
    "GET /api/ai-prompt-templates": (req) => services.aiPromptTemplates(req.query || {}),
    "POST /api/ai-prompt-templates": async (req) => services.createAiPromptTemplate(await readJson(req), req._session?.person_id),
    "POST /api/ai-prompt-templates/render": async (req) => services.renderAiPromptTemplate(await readJson(req))
  };
}

export async function handleAiPromptTemplateRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (parts[0] !== "api" || parts[1] !== "ai-prompt-templates") return false;
  const id = Number(parts[2] || 0);
  if (!id) return false;

  try {
    if (req.method === "GET" && !parts[3]) {
      return json(res, await services.aiPromptTemplateDetail(id));
    }
    if (req.method === "PUT" && !parts[3]) {
      return json(res, await services.updateAiPromptTemplate(id, await readJson(req)));
    }
    if (req.method === "DELETE" && !parts[3]) {
      return json(res, await services.deleteAiPromptTemplate(id));
    }
    if (req.method === "POST" && parts[3] === "duplicate") {
      return json(res, await services.duplicateAiPromptTemplate(id, req._session?.person_id));
    }
    if (req.method === "POST" && parts[3] === "set-default") {
      return json(res, await services.setDefaultAiPromptTemplate(id));
    }
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }

  return notFound(res);
}

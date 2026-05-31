export function createAiStrategyRoutes({ services, readJson }) {
  return {
    "GET /api/ai-strategies": (req) => services.aiStrategies(req.query || {}),
    "GET /api/ai-strategy-layer-rules": (req) => services.aiStrategyLayerRules(req.query || {}),
    "POST /api/ai-strategies": async (req) => services.createAiStrategy(await readJson(req), req._session?.personId),
    "POST /api/ai-strategies/resolve": async (req) => services.resolveAiStrategyPlan(await readJson(req))
  };
}

export async function handleAiStrategyRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (parts[0] !== "api" || parts[1] !== "ai-strategies") return false;
  const id = Number(parts[2] || 0);
  if (!id) return false;

  try {
    if (req.method === "GET" && !parts[3]) {
      return json(res, await services.aiStrategyDetail(id));
    }
    if (req.method === "PUT" && !parts[3]) {
      return json(res, await services.updateAiStrategy(id, await readJson(req)));
    }
    if (req.method === "DELETE" && !parts[3]) {
      return json(res, await services.deleteAiStrategy(id));
    }
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }

  return notFound(res);
}

export function createAiStrategyRoutes({ services, readJson }) {
  return {
    "GET /api/ai-strategies": (req) => services.aiStrategies(req.query || {}),
    "GET /api/ai-strategy-layer-rules": (req) => services.aiStrategyLayerRules(req.query || {}),
    "GET /api/ai-strategy-category-nodes": (req) => services.aiStrategyCategoryNodes(req.query || {}),
    "POST /api/ai-strategy-category-nodes": async (req) => services.createAiStrategyCategoryNode(await readJson(req)),
    "GET /api/ai-strategy-bundles": (req) => services.aiStrategyBundles(req.query || {}),
    "POST /api/ai-strategy-bundles": async (req) => services.createAiStrategyBundle(await readJson(req)),
    "POST /api/ai-strategy-bundles/match": async (req) => services.matchAiStrategyBundles(await readJson(req)),
    "POST /api/ai-strategy-layer-rules": async (req) => services.createAiStrategyLayerRule(await readJson(req)),
    "POST /api/ai-strategies": async (req) => services.createAiStrategy(await readJson(req), req._session?.personId),
    "POST /api/ai-strategies/resolve": async (req) => services.resolveAiStrategyPlan(await readJson(req))
  };
}

export async function handleAiStrategyRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (parts[0] === "api" && parts[1] === "ai-strategy-layer-rules") {
    const layerId = Number(parts[2] || 0);
    if (!layerId) return false;
    try {
      if (req.method === "GET" && !parts[3]) {
        return json(res, await services.aiStrategyLayerRuleDetail(layerId));
      }
      if (req.method === "PUT" && !parts[3]) {
        return json(res, await services.updateAiStrategyLayerRule(layerId, await readJson(req)));
      }
    } catch (error) {
      return json(res, { error: error.message }, error.status || 500);
    }
    return notFound(res);
  }

  if (parts[0] === "api" && parts[1] === "ai-strategy-category-nodes") {
    const nodeId = Number(parts[2] || 0);
    if (!nodeId) return false;
    try {
      if (req.method === "GET" && !parts[3]) {
        return json(res, await services.aiStrategyCategoryNodeDetail(nodeId));
      }
      if (req.method === "PUT" && !parts[3]) {
        return json(res, await services.updateAiStrategyCategoryNode(nodeId, await readJson(req)));
      }
    } catch (error) {
      return json(res, { error: error.message }, error.status || 500);
    }
    return notFound(res);
  }

  if (parts[0] === "api" && parts[1] === "ai-strategy-bundles") {
    const bundleId = Number(parts[2] || 0);
    if (!bundleId) return false;
    try {
      if (req.method === "GET" && !parts[3]) {
        return json(res, await services.aiStrategyBundleDetail(bundleId));
      }
      if (req.method === "PUT" && !parts[3]) {
        return json(res, await services.updateAiStrategyBundle(bundleId, await readJson(req)));
      }
    } catch (error) {
      return json(res, { error: error.message }, error.status || 500);
    }
    return notFound(res);
  }

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

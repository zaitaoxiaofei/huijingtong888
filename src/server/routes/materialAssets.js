export function createMaterialAssetRoutes({ services, readJson }) {
  return {
    "GET /api/material-assets": (req) => services.materialAssets(req.query || {}),
    "POST /api/material-assets": async (req) => services.createMaterialAsset(await readJson(req), req._session?.person_id)
  };
}

export async function handleMaterialAssetRestRoute({ req, res, parts, services, readJson, json, notFound }) {
  if (parts[0] !== "api" || parts[1] !== "material-assets") return false;
  const id = Number(parts[2] || 0);
  if (!id) return false;
  try {
    if (req.method === "GET" && !parts[3]) return json(res, await services.materialAssetDetail(id));
    if (req.method === "PUT" && !parts[3]) return json(res, await services.updateMaterialAsset(id, await readJson(req)));
    if (req.method === "POST" && parts[3] === "archive") return json(res, await services.archiveMaterialAsset(id));
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }
  return notFound(res);
}

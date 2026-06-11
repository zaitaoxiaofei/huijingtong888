export function createAssetVariantEngineRoutes({ services, readJson }) {
  return {
    "GET /api/asset-variant-engine/bootstrap": (req) => services.assetVariantBootstrap(req.query || {}, req._session),
    "GET /api/asset-variant-engine/selection-publish-shops": (req) => services.selectionPublishShops(req.query || {}, req._session),
    "GET /api/asset-variant-engine/jobs": (req) => services.assetVariantJobs(req.query || {}, req._session),
    "GET /api/asset-variant-engine/tail-templates": (req) => services.assetTailTemplates(req.query || {}, req._session),
    "POST /api/asset-variant-engine/tail-templates": async (req) => services.createAssetTailTemplate(await readJson(req), req._session),
    "POST /api/asset-variant-engine/generate": async (req) => services.generateAssetVariants(await readJson(req), req._session),
    "POST /api/asset-variant-engine/generate-video": async (req) => services.generateAssetVariantVideoFromImage(await readJson(req), req._session),
    "POST /api/asset-variant-engine/title-preview": async (req) => services.generateAssetVariantTitlePreview(await readJson(req), req._session),
    "POST /api/asset-variant-engine/sync-ozon-categories": async (req) => services.syncAssetOzonCategories(await readJson(req), req._session),
    "POST /api/asset-variant-engine/rules": async (req) => services.saveShopVariantRule(await readJson(req), req._session),
    "POST /api/asset-variant-engine/delete-media-group": async (req) => services.deleteAssetVariantMediaGroup(await readJson(req), req._session),
    "POST /api/asset-variant-engine/import-listing-automation": async (req) => services.importAssetVariantToListingAutomation(await readJson(req), req._session),
    "POST /api/asset-variant-engine/publish-to-ozon": async (req) => services.publishAssetVariantsToOzon(await readJson(req), req._session),
    "POST /api/asset-variant-engine/publish-selection": async (req) => services.enqueuePublishSelectionProductToOzon(await readJson(req), req._session)
  };
}

export async function handleAssetVariantEngineRestRoute({ req, res, parts, services, json, notFound, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "asset-variant-engine") return false;

  if (req.method === "GET" && parts[2] === "files" && parts[3] && parts[4]) {
    const file = await services.resolveAssetVariantFile(decodeURIComponent(parts[3]), parts.slice(4).map(decodeURIComponent).join("/"));
    if (!file) return notFound(res);
    writeHead(res, 200, {
      "Content-Type": file.mime,
      "Content-Length": file.buffer.length,
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(file.buffer);
  }

  if (req.method === "GET" && parts[2] === "tail-template-files" && parts[3]) {
    const file = await services.resolveAssetTailTemplateFile(decodeURIComponent(parts[3]));
    if (!file) return notFound(res);
    writeHead(res, 200, {
      "Content-Type": file.mime,
      "Content-Length": file.buffer.length,
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(file.buffer);
  }

  if (req.method === "GET" && parts[2] === "jobs" && parts[3]) {
    const detail = await services.assetVariantJobDetail(Number(parts[3]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "POST" && parts[2] === "jobs" && parts[3] && parts[4] === "cancel") {
    return json(res, await services.cancelAssetVariantJob(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "jobs" && parts[3] && parts[4] === "retry-failures") {
    return json(res, await services.retryAssetVariantJobFailures(Number(parts[3]), req._session));
  }

  return false;
}

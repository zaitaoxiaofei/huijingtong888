export function createMultiShopPublishRoutes({ services, readJson }) {
  return {
    "GET /api/multi-shop-publish/bootstrap": (req) => services.multiShopPublishBootstrap(req.query || {}, req._session),
    "POST /api/multi-shop-publish/generate-versions": async (req) => services.generateMultiShopVersions(await readJson(req), req._session),
    "POST /api/multi-shop-publish/generate-preview-images": async (req) => services.generatePreviewImages(await readJson(req), req._session),
    "POST /api/multi-shop-publish/export-package": async (req) => services.exportMultiShopListingPackage(await readJson(req), req._session),
    "POST /api/multi-shop-publish/tasks": async (req) => services.createMultiShopPublishTask(await readJson(req), req._session)
  };
}

export async function handleMultiShopPublishRestRoute({ req, res, parts, services, readJson, json, notFound, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "multi-shop-publish") return false;

  if (req.method === "GET" && parts[2] === "generated-images" && parts[3] && parts[4]) {
    const file = await services.resolveGeneratedImageFile(decodeURIComponent(parts[3]), decodeURIComponent(parts[4]));
    if (!file) return notFound(res);
    writeHead(res, 200, {
      "Content-Type": file.mime,
      "Content-Length": file.buffer.length,
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(file.buffer);
  }

  if (req.method === "GET" && parts[2] === "versions") {
    return json(res, await services.multiShopVersions(req.query || {}, req._session));
  }

  if (req.method === "GET" && parts[2] === "tasks" && parts[3]) {
    return json(res, await services.multiShopPublishTaskDetail(Number(parts[3]), req._session));
  }

  if (req.method === "GET" && parts[2] === "tasks") {
    return json(res, await services.multiShopPublishTasks(req.query || {}, req._session));
  }

  if (req.method === "POST" && parts[2] === "task-items" && parts[3] && parts[4] === "retry") {
    return json(res, await services.retryMultiShopPublishItem(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "POST" && parts[2] === "versions" && parts[3] && parts[4] === "regenerate") {
    return json(res, await services.regenerateMultiShopVersion(Number(parts[3]), await readJson(req), req._session));
  }

  return false;
}

export function createOglDispatchRoutes({ dispatch, readJson }) {
  return {
    "GET /api/ogl-dispatch/bootstrap": (req) => dispatch.bootstrap(req._session),
    "PUT /api/ogl-dispatch/settings": async (req) => dispatch.saveSettings(req._session, await readJson(req)),
    "POST /api/ogl-dispatch/preview": async (req) => dispatch.preview(req._session, await readJson(req)),
    "POST /api/ogl-dispatch/batches": async (req) => dispatch.createBatch(req._session, await readJson(req)),
    "GET /api/ogl-dispatch/batches": (req, url) => dispatch.listBatches(req._session, Object.fromEntries(url.searchParams)),
    "GET /api/ogl-dispatch/batch": (req, url) => dispatch.detail(req._session, url.searchParams.get("id")),
    "GET /api/ogl-dispatch/official-carriages": (req, url) => dispatch.listOfficial(req._session, Object.fromEntries(url.searchParams)),
    "GET /api/ogl-dispatch/official-carriage": (req, url) => dispatch.officialDetail(req._session, Object.fromEntries(url.searchParams)),
    "GET /api/ogl-dispatch/official-carriage-tracking": (req, url) => dispatch.officialTracking(req._session, Object.fromEntries(url.searchParams)),
    "POST /api/ogl-dispatch/action": async (req) => dispatch.action(req._session, await readJson(req))
  };
}

// The server's JSON route registry has no response argument. Serve files before it.
export async function handleOglDispatchFileRoute({ req, res, url, dispatch, writeHead = (response, status, headers) => response.writeHead(status, headers) }) {
  if (req.method !== "GET" || url.pathname !== "/api/ogl-dispatch/file") return false;
  const file = await dispatch.file(req._session, url.searchParams.get("batch_id"), url.searchParams.get("type"));
  if (!Buffer.isBuffer(file?.buffer) || !["application/pdf", "image/png"].includes(file.contentType)) {
    throw Object.assign(new Error("OGL 发运文件暂不可用，请在批次详情核对官方文件状态后重新下载。"), { statusCode: 502 });
  }
  const extension = file.contentType === "image/png" ? "png" : "pdf";
  const filename = String(file.filename || `ogl-dispatch.${extension}`).replace(/[\r\n\x00-\x1f\x7f]/g, "").split(/[\\/]/).pop();
  writeHead(res, 200, {
    "Content-Type": file.contentType,
    "Content-Disposition": `attachment; filename="ogl-dispatch.${extension}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Content-Length": file.buffer.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  res.end(file.buffer);
  return true;
}

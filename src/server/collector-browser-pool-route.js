import { readJson as defaultReadJson } from "../http/request.js";

export function createCollectorBrowserPoolHandler({ pool, resolveShop, sendJson, readJson = defaultReadJson }) {
  if (!pool || !resolveShop || !sendJson) throw new Error("Collector browser pool dependencies are required");

  return async function handleCollectorBrowserPoolRoute(req, res, parts, principal) {
    if (parts[0] !== "api" || parts[1] !== "local-plugin" || parts[2] !== "collector-browser-pool") return false;
    const tenantKey = String(principal?.tenantKey || "").trim();
    if (!tenantKey) {
      sendJson(req, res, { success: false, code: "TENANT_PLUGIN_AUTH_REQUIRED", error: "请先配置当前企业的插件令牌" }, 403);
      return true;
    }
    const method = String(req.method || "GET").toUpperCase();
    const action = parts[3];
    const supported = parts.length === 4 && ((method === "GET" && action === "status")
      || (method === "POST" && ["heartbeat", "batches", "claim", "results"].includes(action)))
      || parts.length === 5 && method === "GET" && action === "batches" && /^[A-Za-z0-9_-]{1,128}$/.test(parts[4]);
    if (!supported) {
      sendJson(req, res, { success: false, code: "COLLECTOR_BROWSER_ROUTE_NOT_FOUND", error: "商品取数接口不存在" }, 404);
      return true;
    }
    try {
      const body = method === "POST" ? await readJson(req, { limitBytes: 512 * 1024 }) : {};
      let result;
      if (method === "GET" && action === "status") {
        result = pool.status(tenantKey);
      } else if (method === "GET") {
        const url = new URL(req.url, "http://localhost");
        const after = Number(url.searchParams.get("after") || 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          const error = new Error("结果游标无效，请重新查询商品");
          error.status = 400;
          error.code = "COLLECTOR_BROWSER_INVALID_CURSOR";
          throw error;
        }
        result = pool.batchStatus(tenantKey, parts[4], after);
      } else if (action === "batches") {
        result = pool.createBatch(tenantKey, body?.skus);
      } else {
        // Every worker action rechecks the current shop ownership. Client shop IDs
        // and tenant selectors never determine the enterprise or source shop.
        const shop = await resolveShop(String(body?.company_id || "").trim(), tenantKey);
        if (action === "heartbeat") {
          result = pool.heartbeat(tenantKey, { ...body, ...shop });
        } else if (action === "claim") {
          result = pool.claim(tenantKey, body);
        } else {
          pool.report(tenantKey, body);
          // Incremental batch polling owns result delivery. Workers need only an
          // acknowledgement, not another copy of every product in the batch.
          result = { accepted: true, task_id: body.task_id };
        }
      }
      sendJson(req, res, { ...result, data: result, success: result?.success !== false });
      return true;
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : Number(error?.status || error?.statusCode || 500);
      const knownClientError = status >= 400 && status < 500;
      sendJson(req, res, {
        success: false,
        code: error instanceof SyntaxError ? "COLLECTOR_BROWSER_INVALID_JSON" : error?.code || "COLLECTOR_BROWSER_POOL_ERROR",
        error: error instanceof SyntaxError ? "请求内容不是有效 JSON" : knownClientError ? error.message : "商品取数服务暂时不可用，请稍后重试"
      }, status >= 400 && status <= 599 ? status : 500);
      return true;
    }
  };
}

import { tenantIdFromRequest } from "../tenant-context.js";
import { createTenantBackgroundTasks } from "../../services/tenant-background-tasks.js";
import { authorizeBusinessTaskSession } from "../../services/business-task-tenant.js";

function onlineProductSyncScope(body = {}) {
  if (body.pending_listing || body.pendingListing || body.scope === "pending_listing") return "pending_listing";
  if (Array.isArray(body.offer_ids || body.offerIds) && (body.offer_ids || body.offerIds).length) return "publish_offers";
  return Array.isArray(body.online_product_ids) && body.online_product_ids.length ? "selected" : "all";
}

export function createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders, tasks = createTenantBackgroundTasks(), authorize = authorizeBusinessTaskSession }) {
  const options = async req => {
    const session = await authorize(req._session);
    return { session, tenantId: tenantIdFromRequest({ _session: session }), signal: req._abortSignal };
  };
  const startOrders = async (req, mode) => {
    const body = await readJson(req);
    return tasks.start(req._session, "orders", async ({ session, signal, onProgress }) => {
      const sync = mode === "incremental" ? services.syncOzonIncrementalOrders : services.syncDemoOrders;
      return sync(body, { session, tenantId: tenantIdFromRequest({ _session: session }), signal, onProgress });
    }, { mode });
  };
  return {
    "GET /api/exception-workbench": (req, url) => services.exceptionWorkbench(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/exception-workbench/sync": async req => syncExceptionWorkbenchOrders(req),
    "POST /api/exception-workbench/tasks/state": async req => services.updateExceptionTaskState(await readJson(req), req._session?.personId, tenantIdFromRequest(req), { session: req._session, signal: req._abortSignal }),
    "GET /api/sync/ozon/status": async req => {
      const task = await tasks.snapshot(req._session, "orders");
      const result = task.result || {};
      return { ...task, fetched: Number(result.fetched || 0), inserted: Number(result.inserted || 0), updated: Number(result.updated || 0), requests: Number(result.requests || 0),
        ...(services.latestOrderSyncStatus ? await services.latestOrderSyncStatus(tenantIdFromRequest(req)) : {}) };
    },
    "POST /api/sync/ozon/cancel": req => tasks.cancel(req._session, "orders"),
    "POST /api/sync/ozon": req => startOrders(req, "range"),
    "POST /api/sync/ozon/details": async req => services.syncKnownOzonPostingDetails(await readJson(req), await options(req)),
    "POST /api/sync/ozon/incremental": req => startOrders(req, "incremental"),
    "POST /api/sync/ozon/postings": async req => services.syncOzonPostingsByNumber(await readJson(req), await options(req)),
    "GET /api/sync/online-products/status": req => tasks.snapshot(req._session, "online-products"),
    "POST /api/sync/online-products": async req => {
      const body = await readJson(req);
      return tasks.start(req._session, "online-products", ({ session, signal }) => services.syncOzonOnlineProducts(body, { session, signal, tenantId: tenantIdFromRequest({ _session: session }) }),
        { scope: onlineProductSyncScope(body), payload: body });
    },
    "POST /api/sync/ozon-stocks": async req => services.syncOzonStocks(await readJson(req), await options(req)),
    "POST /api/sync/ozon-fbo-supplies": async req => services.syncOzonFboSupplyOrders(await readJson(req), await options(req)),
    "POST /api/sync/ozon-finance": async req => services.syncOzonFinance(await readJson(req), await options(req))
  };
}

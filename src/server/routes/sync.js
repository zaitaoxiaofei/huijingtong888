let onlineProductSyncTask = {
  running: false,
  started_at: "",
  finished_at: "",
  scope: "all",
  payload: {},
  result: null,
  error: ""
};

function snapshotOnlineProductSyncTask() {
  return {
    running: Boolean(onlineProductSyncTask.running),
    started_at: onlineProductSyncTask.started_at || "",
    finished_at: onlineProductSyncTask.finished_at || "",
    scope: onlineProductSyncTask.scope || "all",
    payload: onlineProductSyncTask.payload || {},
    result: onlineProductSyncTask.result || null,
    error: onlineProductSyncTask.error || ""
  };
}

function onlineProductSyncScope(body = {}) {
  return Array.isArray(body.online_product_ids) && body.online_product_ids.length ? "selected" : "all";
}

export function createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }) {
  return {
    "GET /api/exception-workbench": (req, url) => services.exceptionWorkbench(Object.fromEntries(url.searchParams.entries())),
    "POST /api/exception-workbench/sync": async (req) => syncExceptionWorkbenchOrders(req),
    "POST /api/exception-workbench/tasks/state": async (req) => services.updateExceptionTaskState(await readJson(req), req._session?.personId),
    "POST /api/sync/ozon": async (req) => services.syncDemoOrders(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon/details": async (req) => services.syncKnownOzonPostingDetails(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon/incremental": async (req) => services.syncOzonIncrementalOrders(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon/postings": async (req) => services.syncOzonPostingsByNumber(await readJson(req), { signal: req._abortSignal }),
    "GET /api/sync/online-products/status": () => snapshotOnlineProductSyncTask(),
    "POST /api/sync/online-products": async (req) => {
      const body = await readJson(req);
      if (onlineProductSyncTask.running) {
        return { started: false, queued: false, ...snapshotOnlineProductSyncTask() };
      }
      onlineProductSyncTask = {
        running: true,
        started_at: new Date().toISOString(),
        finished_at: "",
        scope: onlineProductSyncScope(body),
        payload: body || {},
        result: null,
        error: ""
      };
      void (async () => {
        try {
          const result = await services.syncOzonOnlineProducts(body);
          onlineProductSyncTask = {
            ...onlineProductSyncTask,
            running: false,
            finished_at: new Date().toISOString(),
            result,
            error: ""
          };
        } catch (error) {
          onlineProductSyncTask = {
            ...onlineProductSyncTask,
            running: false,
            finished_at: new Date().toISOString(),
            result: null,
            error: error?.message || String(error || "online product sync failed")
          };
        }
      })();
      return { started: true, queued: true, ...snapshotOnlineProductSyncTask() };
    },
    "POST /api/sync/ozon-stocks": async (req) => services.syncOzonStocks(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon-fbo-supplies": async (req) => services.syncOzonFboSupplyOrders(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon-finance": async (req) => services.syncOzonFinance(await readJson(req), { signal: req._abortSignal })
  };
}

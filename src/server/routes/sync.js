let onlineProductSyncTask = {
  running: false,
  started_at: "",
  finished_at: "",
  scope: "all",
  payload: {},
  result: null,
  error: ""
};

let orderSyncTask = {
  task_id: "",
  running: false,
  mode: "",
  started_at: "",
  finished_at: "",
  progress: null,
  result: null,
  error: "",
  controller: null
};

function snapshotOrderSyncTask() {
  const result = orderSyncTask.result || null;
  return {
    task_id: orderSyncTask.task_id || "",
    running: Boolean(orderSyncTask.running),
    mode: orderSyncTask.mode || "",
    started_at: orderSyncTask.started_at || "",
    finished_at: orderSyncTask.finished_at || "",
    progress: orderSyncTask.progress || null,
    result,
    fetched: Number(result?.fetched || 0),
    inserted: Number(result?.inserted || 0),
    updated: Number(result?.updated || 0),
    requests: Number(result?.requests || 0),
    error: orderSyncTask.error || ""
  };
}

function startOrderSyncTask(services, mode, body = {}) {
  if (orderSyncTask.running) return { started: false, queued: true, ...snapshotOrderSyncTask() };
  const controller = new AbortController();
  orderSyncTask = {
    task_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    running: true,
    mode,
    started_at: new Date().toISOString(),
    finished_at: "",
    progress: { phase: "starting", message: "正在准备订单同步..." },
    result: null,
    error: "",
    controller
  };
  const sync = mode === "incremental" ? services.syncOzonIncrementalOrders : services.syncDemoOrders;
  void sync(body, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (!orderSyncTask.running || orderSyncTask.controller !== controller) return;
      orderSyncTask.progress = progress;
    }
  }).then((result) => {
    if (orderSyncTask.controller !== controller) return;
    orderSyncTask = { ...orderSyncTask, running: false, finished_at: new Date().toISOString(), progress: { phase: "done", message: "订单同步完成" }, result, error: "", controller: null };
  }).catch((error) => {
    if (orderSyncTask.controller !== controller) return;
    orderSyncTask = { ...orderSyncTask, running: false, finished_at: new Date().toISOString(), progress: { phase: "failed", message: error?.message || "订单同步失败" }, result: null, error: error?.message || String(error), controller: null };
  });
  return { started: true, queued: true, ...snapshotOrderSyncTask() };
}

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
  if (body.pending_listing || body.pendingListing || body.scope === "pending_listing") return "pending_listing";
  return Array.isArray(body.online_product_ids) && body.online_product_ids.length ? "selected" : "all";
}

export function createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }) {
  return {
    "GET /api/exception-workbench": (req, url) => services.exceptionWorkbench(Object.fromEntries(url.searchParams.entries())),
    "POST /api/exception-workbench/sync": async (req) => syncExceptionWorkbenchOrders(req),
    "POST /api/exception-workbench/tasks/state": async (req) => services.updateExceptionTaskState(await readJson(req), req._session?.personId),
    "GET /api/sync/ozon/status": async () => ({
      ...snapshotOrderSyncTask(),
      ...(services.latestOrderSyncStatus ? await services.latestOrderSyncStatus() : {})
    }),
    "POST /api/sync/ozon/cancel": () => {
      if (orderSyncTask.running && orderSyncTask.controller) orderSyncTask.controller.abort(new Error("用户取消了订单同步"));
      return { cancelling: Boolean(orderSyncTask.running), ...snapshotOrderSyncTask() };
    },
    "POST /api/sync/ozon": async (req) => startOrderSyncTask(services, "range", await readJson(req)),
    "POST /api/sync/ozon/details": async (req) => services.syncKnownOzonPostingDetails(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon/incremental": async (req) => startOrderSyncTask(services, "incremental", await readJson(req)),
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

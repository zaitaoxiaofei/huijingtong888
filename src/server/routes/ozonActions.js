export function createOzonActionRoutes({ services, readJson }) {
  return {
    "POST /api/ozon/actions/list": async (req) => services.listOzonActions(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/candidates": async (req) => services.listOzonActionCandidates(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/products": async (req) => services.listOzonActionProducts(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/products/add": async (req) => services.addOzonActionProducts(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/products/remove": async (req) => services.removeOzonActionProducts(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/activity/toggle": async (req) => services.toggleOzonSellerAction(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "POST /api/ozon/actions/activity/archive": async (req) => services.archiveOzonSellerAction(await readJson(req), { signal: req._abortSignal, session: req._session }),
    "GET /api/ozon/actions/cleanup-config": (req, url) => services.getOzonActionCleanupConfig(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/ozon/actions/cleanup-config": async (req) => services.saveOzonActionCleanupConfig(await readJson(req), req._session)
  };
}

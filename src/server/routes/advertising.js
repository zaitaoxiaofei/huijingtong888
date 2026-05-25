export function createAdvertisingRoutes({ services, readJson }) {
  return {
    "GET /api/advertising/daily": (req, url) => services.advertisingDaily(Object.fromEntries(url.searchParams.entries())),
    "GET /api/advertising/daily/summary": (req, url) => services.advertisingDailySummary(Object.fromEntries(url.searchParams.entries())),
    "GET /api/advertising/daily/details": (req, url) => services.advertisingDailyDetails(Object.fromEntries(url.searchParams.entries())),
    "GET /api/advertising/pilot-shop": () => services.advertisingPilotShop(),
    "POST /api/advertising/daily/sync": async (req) => services.syncAdvertisingDailyFromOzon(await readJson(req), { signal: req._abortSignal }),
    "POST /api/advertising/daily/import": async (req) => services.upsertAdvertisingDailyRows(await readJson(req))
  };
}

import { config } from "../../config.js";
import { exceptionWorkbenchMysql, syncOzonFinanceMysql, syncOzonOnlineProductsMysql, updateExceptionTaskStateMysql } from "../../services/mysql-cutover.js";

export function createSyncRoutes({ services, readJson, syncExceptionWorkbenchOrders }) {
  return {
    "GET /api/exception-workbench": (req, url) => config.dbClient === "mysql"
      ? exceptionWorkbenchMysql(Object.fromEntries(url.searchParams.entries()))
      : services.exceptionWorkbench(Object.fromEntries(url.searchParams.entries())),
    "POST /api/exception-workbench/sync": async (req) => syncExceptionWorkbenchOrders(req),
    "POST /api/exception-workbench/tasks/state": async (req) => config.dbClient === "mysql"
      ? updateExceptionTaskStateMysql(await readJson(req), req._session?.personId)
      : services.updateExceptionTaskState(await readJson(req), req._session?.personId),
    "POST /api/sync/ozon": async (req) => services.syncDemoOrders(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon/incremental": async (req) => services.syncOzonIncrementalOrders(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/online-products": async (req) => config.dbClient === "mysql"
      ? syncOzonOnlineProductsMysql(await readJson(req))
      : services.syncOzonOnlineProducts(await readJson(req)),
    "POST /api/sync/ozon-stocks": async (req) => services.syncOzonStocks(await readJson(req), { signal: req._abortSignal }),
    "POST /api/sync/ozon-finance": async (req) => config.dbClient === "mysql"
      ? syncOzonFinanceMysql(await readJson(req), { signal: req._abortSignal })
      : services.syncOzonFinance(await readJson(req), { signal: req._abortSignal })
  };
}

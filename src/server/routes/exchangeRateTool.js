import { hasPermission } from "../../shared/permissions.js";
import { authorizeBusinessTaskSession } from "../../services/business-task-tenant.js";
import { getExchangeRateTool, getExchangeRateToday } from "../../services/exchange-rate-tool.js";

export function createExchangeRateToolRoutes({ db, authorizeSession = authorizeBusinessTaskSession, tool = getExchangeRateTool, today = getExchangeRateToday }) {
  const queryFor = (req, url) => req.query || Object.fromEntries(url?.searchParams || []);
  return {
    "GET /api/exchange-rates/tool": async (req, url) => {
      let tenantScope = null;
      if (req._session?.tenant?.id) {
        const current = await authorizeSession(req._session, db.query.bind(db));
        if (hasPermission(current, "finance")) tenantScope = { id: Number(current.tenant.id), isDefault: current.tenant.slug === "default", financeAuthorized: true };
      }
      return tool(db, { query: queryFor(req, url), tenantScope });
    },
    "GET /api/exchange-rates/tool/today": (req, url) => {
      const query = queryFor(req, url);
      if (["tenant_id", "tenantId", "shop_id", "shopId"].some(key => Object.hasOwn(query, key))) {
        throw Object.assign(new Error("每日汇率是公共参考数据，无需选择企业或店铺"), { statusCode: 400, code: "EXCHANGE_RATE_TOOL_FILTER_INVALID" });
      }
      return today(db);
    }
  };
}

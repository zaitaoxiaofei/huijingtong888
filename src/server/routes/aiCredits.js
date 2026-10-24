import { createAiCreditLedger } from "../../services/ai-credit-ledger.js";
import { isAiCreditReadRoute } from "../ai-credit-paths.js";

let defaultLedger;
async function runtimeLedger() {
  if (!defaultLedger) {
    const { withMysqlTransaction } = await import("../../mysql-pool.js");
    defaultLedger = createAiCreditLedger({ transaction: withMysqlTransaction });
  }
  return defaultLedger;
}
const normalize = error => {
  if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
  throw Object.assign(new Error("AI 积分服务尚未安装，请由平台管理员执行积分表迁移"), { status: 503, statusCode: 503, code: "AI_CREDIT_SCHEMA_PENDING" });
};

export async function handleAiCreditRoute({ req, res, url, parts, readJson, json, ledger }) {
  const read = isAiCreditReadRoute(parts, req.method);
  const platform = req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "platform"
    && parts[2] === "ai-credits" && ["accounts", "prices", "recharges", "reconcile"].includes(parts[3]);
  if (!read && !platform) return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    ledger ||= await runtimeLedger();
    const session = req._session;
    if (read) {
      let result;
      if (parts[2] === "wallet") result = await ledger.wallet(session);
      if (parts[2] === "audit") result = await ledger.audit(session);
      if (parts[2] === "entries") result = await ledger.entries(session, {
        before: url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
        limit: url.searchParams.get("limit") || 30
      });
      if (parts[2] === "tasks") result = await ledger.task(session, parts[3]);
      json(res, result); return true;
    }
    const actions = { accounts: "configureAccount", prices: "createPrice", recharges: "recharge", reconcile: "reconcile" };
    json(res, await ledger[actions[parts[3]]](session, await readJson(req)));
    return true;
  } catch (error) { normalize(error); }
}

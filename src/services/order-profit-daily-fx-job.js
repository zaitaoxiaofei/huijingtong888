import { ensureOrderProfitDailyFx, orderProfitFxBusinessDate } from "./order-profit-daily-fx.js";
import { assertOrderProfitDailyFxSchema } from "./order-profit-daily-fx-schema.js";

export const ORDER_PROFIT_DAILY_FX_JOB = {
  key: "order_profit_daily_fx_archive",
  name: "订单每日汇率归档",
  category: "finance",
  priority: "high",
  intervalMinutes: 15,
  initialDelaySeconds: 60,
  catchupEnabled: true,
  maxCatchupRuns: 1
};

// Bounded catch-up after restart: only yesterday and today in Beijing. Never
// walk the full order history or acquire a business transaction for fetching.
export async function runOrderProfitDailyFxArchive(db, { now = Date.now(), fetchImpl = fetch } = {}) {
  await assertOrderProfitDailyFxSchema(db);
  const today = orderProfitFxBusinessDate(new Date(now));
  const yesterday = orderProfitFxBusinessDate(new Date(new Date(today + "T00:00:00+08:00").getTime() - 86400000));
  const rows = [], errors = [];
  for (const day of [yesterday, today]) {
    try {
      const saved = await ensureOrderProfitDailyFx(db, day, { now, fetchImpl });
      rows.push({ business_date: saved.business_date, source_date: saved.source_date, id: saved.id, rate: saved.rate });
    } catch (error) { errors.push({ business_date: day, code: error.code || "ORDER_PROFIT_DAILY_FX_UNAVAILABLE" }); }
  }
  if (errors.length) {
    throw Object.assign(new Error(`每日汇率归档待补：${errors.map(item => `${item.business_date} [${item.code}]`).join("；")}；本轮已归档：${rows.map(item => item.business_date).join("、") || "无"}。15 分钟后重试，不使用固定或今日汇率代替。`),
      { code: "ORDER_PROFIT_DAILY_FX_ARCHIVE_INCOMPLETE" });
  }
  return { status: "success", timezone: "Asia/Shanghai", from: yesterday, to: today, days: rows.length, rows };
}

import { roundMoney } from "../v1/profit.js";

function invalid(message) {
  return Object.assign(new Error(message), { code: "ORDER_PROFIT_FX_INVALID", statusCode: 409 });
}

function finiteAmount(value, label) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(Number(value))) {
    throw invalid(`${label}必须是明确的有限金额，不能使用缺失值或默认汇率`);
  }
  return Number(value);
}

function dateKey(value, label) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw invalid(`${label}必须是明确的北京日期 YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(`${label}不是有效日期`);
  }
  return text;
}

// A snapshot is an archived CNY -> RUB quote: one CNY buys rate RUB.
export function validateDailyFxSnapshot(snapshot, { businessDate } = {}) {
  if (!snapshot || typeof snapshot !== "object") throw invalid("缺少已存档的每日汇率，请先补齐该业务日期汇率");
  const archiveId = String(snapshot.id ?? "");
  if (!/^[1-9]\d*$/.test(archiveId) || (typeof snapshot.id === "number" && !Number.isSafeInteger(snapshot.id))) {
    throw invalid("每日汇率缺少有效存档 ID，不能使用未归档报价结算");
  }
  if (snapshot.currency_from !== "CNY" || snapshot.currency_to !== "RUB") {
    throw invalid("每日汇率方向必须为 CNY → RUB，不能使用反向报价");
  }
  const rate = finiteAmount(snapshot.rate, "每日汇率");
  if (rate <= 0) throw invalid("每日汇率必须大于零");
  const business = dateKey(snapshot.business_date, "汇率业务日期");
  const sourceDate = dateKey(snapshot.source_date, "汇率来源日期");
  if (sourceDate > business) throw invalid("汇率来源日期不能晚于业务日期，不能使用未来报价");
  if (businessDate !== undefined && business !== dateKey(businessDate, "订单业务日期")) {
    throw invalid("归档汇率日期与订单业务日期不一致，请补齐正确日期的汇率");
  }
  if (typeof snapshot.source !== "string" || !snapshot.source.trim()) throw invalid("每日汇率缺少来源，无法审计");
  return Object.freeze({ ...snapshot, id: archiveId, rate, business_date: business, source_date: sourceDate });
}

// Keep precision until the business total is rounded. CNY is never converted again.
export function moneyToCny(amount, currency, snapshot, options = {}) {
  const value = finiteAmount(amount, "原币金额");
  const code = String(currency ?? "").trim().toUpperCase();
  if (code === "CNY") return value;
  if (code === "RUB") return finiteAmount(value / validateDailyFxSnapshot(snapshot, options).rate, "换算后人民币金额");
  throw invalid(`不支持或缺少原币币种 ${code || "（空）"}，请先核对账单币种`);
}

export function attributeOrderProfitFx({ initialEstimatedProfitCny, actualNetAmounts, actualCnyCost, orderFx, signedFx }) {
  const ordered = validateDailyFxSnapshot(orderFx);
  const signed = validateDailyFxSnapshot(signedFx);
  if (signed.business_date < ordered.business_date) throw invalid("签收汇率日期不能早于下单汇率日期");
  const initial = finiteAmount(initialEstimatedProfitCny, "原始预估利润");
  const cost = finiteAmount(actualCnyCost, "实际人民币成本");
  if (!Array.isArray(actualNetAmounts) || !actualNetAmounts.length) throw invalid("缺少明确原币净额，无法拆分汇差");
  let atOrder = 0;
  let atSigned = 0;
  for (const row of actualNetAmounts) {
    atOrder = finiteAmount(atOrder + moneyToCny(row?.amount, row?.currency, ordered), "下单汇率实际净额合计");
    atSigned = finiteAmount(atSigned + moneyToCny(row?.amount, row?.currency, signed), "签收汇率实际净额合计");
  }
  const initialRounded = roundMoney(initial);
  const actualAtOrder = roundMoney(atOrder - cost);
  const actualAtSigned = roundMoney(atSigned - cost);
  const fx = roundMoney(atSigned - atOrder);
  const business = roundMoney(atOrder - cost - initial);
  const total = roundMoney(actualAtSigned - initialRounded);
  return {
    initial_estimated_profit_cny: initialRounded,
    actual_profit_at_order_rate_cny: actualAtOrder,
    actual_profit_at_signed_rate_cny: actualAtSigned,
    fx_gain_loss_cny: fx,
    business_variance_cny: business,
    rounding_difference_cny: roundMoney(total - fx - business),
    total_variance_cny: total
  };
}

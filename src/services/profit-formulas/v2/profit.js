import { estimateItemProfit as estimateV1, commissionRate as commissionV1, ozonCommissionRate } from "../v1/profit.js";
import { validateDailyFxSnapshot } from "./fx.js";

// V2 changes date-pinned FX inputs; frozen V1 cost/tariff arithmetic is reused explicitly.
export { actualItemProfit, roundMoney, ozonCommissionRate } from "../v1/profit.js";

export function commissionRate(price, mapping, exchangeRate, pricingAmountRub) {
  if (pricingAmountRub === undefined || ozonCommissionRate(mapping) !== null) {
    return commissionV1(price, mapping, exchangeRate);
  }
  if (pricingAmountRub === null || String(pricingAmountRub).trim() === "" || !Number.isFinite(Number(pricingAmountRub)) || Number(pricingAmountRub) < 0) {
    throw new Error("佣金定价原币金额 pricingAmountRub 必须是有效 RUB 金额");
  }
  return commissionV1(Number(pricingAmountRub), mapping, 1);
}

export function estimateItemProfit({ fx, orderBusinessDate, pricingAmountRub, salePriceCurrency = "CNY", ...input }) {
  if (!orderBusinessDate) throw new Error("新订单预估必须提供下单北京日期 orderBusinessDate");
  const pinned = validateDailyFxSnapshot(fx, { businessDate: orderBusinessDate });
  if (salePriceCurrency !== "CNY" || input.salePrice === null || input.salePrice === undefined || String(input.salePrice).trim() === "" || !Number.isFinite(Number(input.salePrice))) {
    throw new Error("预估 salePrice 必须为已按下单日汇率换算的 CNY 金额");
  }
  const product = { ...input.product, exchange_rate: pinned.rate, pricing_effective_at: input.product?.pricing_effective_at || orderBusinessDate };
  if (product.pricing_effective_at) {
    const text = product.pricing_effective_at instanceof Date ? product.pricing_effective_at.toISOString() : String(product.pricing_effective_at).trim();
    const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+08:00`
      : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(" ", "T")}Z`;
    const date = new Date(timestamp);
    const day = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
      : "";
    if (day !== orderBusinessDate) throw new Error("佣金及物流规则定价日期必须保留下单日，不能按签收日重新选档");
  }
  let mapping = input.mapping;
  if (pricingAmountRub !== undefined && ozonCommissionRate(mapping) === null) {
    const selected = commissionRate(input.salePrice, mapping, pinned.rate, pricingAmountRub);
    mapping = { ...mapping, commission_low: selected, commission_high: selected };
  }
  return estimateV1({ ...input, product, mapping });
}

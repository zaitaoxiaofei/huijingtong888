import { shanghaiDateTimeText } from "../../admin/utils/shanghai-date.js";

export function formatDateTime(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

export function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

export function formatSignedMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0.00";
  if (Math.abs(amount) < 0.005) return "0.00";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}`;
}

export function formatPercent(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? `${amount.toFixed(2)}%` : "0.00%";
}

export function moneyValueClass(value) {
  const amount = Number(value || 0);
  if (amount < -0.005) return "is-negative";
  if (amount > 0.005) return "is-positive";
  return "";
}

export function formatLogisticsRuleLabel(rule) {
  if (!rule) return "-";
  return `${rule.name} (${Number(rule.min_weight_g || 0)}-${Number(rule.max_weight_g || 0)}g)`;
}

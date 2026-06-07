import { shanghaiDateDaysAgo, shanghaiDateKey } from "../../utils/shanghai-date.js";

export const MOBILE_STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "awaiting_packaging", label: "备货" },
  { value: "awaiting_deliver", label: "发货" },
  { value: "unbound", label: "待绑定" },
  { value: "delivering", label: "运输中" },
  { value: "dispute", label: "争议" }
];

export function defaultOrderDateRange() {
  return {
    dateFrom: shanghaiDateDaysAgo(21),
    dateTo: shanghaiDateKey()
  };
}

export function money(value, currency = "¥") {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return `${currency}0.00`;
  return `${currency}${number.toFixed(2)}`;
}

export function shortText(value, fallback = "-") {
  return String(value || "").trim() || fallback;
}

export function firstCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

export function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function orderImage(row = {}) {
  return firstCsv(row.order_image_urls || row.image_urls || row.inventory_image_urls || "");
}

export function orderTitle(row = {}) {
  return firstCsv(row.product_names) || firstSkuName(row) || row.posting_number || row.order_number || "订单";
}

export function firstSkuName(row = {}) {
  const pair = String(row.sku_names || "").split("||").find(Boolean) || "";
  return pair.includes(":") ? pair.slice(pair.indexOf(":") + 1) : pair;
}

export function orderStatusLabel(row = {}) {
  const raw = String(row.status || row.tracking_stage || row.logistics_status || "").toLowerCase();
  if (Number(row.unbound_item_count || 0) > 0) return "待绑定";
  if (raw.includes("awaiting_packaging") || raw.includes("awaiting_registration")) return "待备货";
  if (raw.includes("awaiting_deliver") || raw.includes("posting_registered")) return "待发货";
  if (raw.includes("delivered")) return "已签收";
  if (raw.includes("cancel") || raw.includes("return")) return "已取消";
  if (raw.includes("deliver") || raw.includes("transferring") || raw.includes("carriage")) return "运输中";
  return row.status || row.tracking_stage || "订单";
}

export function procurementLabel(row = {}) {
  const total = Number(row.procurement_total_item_count || 0);
  const handled = Number(row.procurement_handled_item_count || 0);
  if (!total) return "待判断";
  if (handled >= total) return "已处理";
  return `${handled}/${total} 已处理`;
}

export function unboundSkus(row = {}) {
  return splitCsv(row.unbound_skus);
}

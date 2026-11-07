export const SEARCH_TYPE_OPTIONS = [
  { value: "order", label: "订单号" },
  { value: "sku", label: "SKU" },
  { value: "offer", label: "货号" },
  { value: "tracking", label: "跟踪号" },
  { value: "purchaseTracking", label: "采购快递单号" },
  { value: "product", label: "库存产品" }
];

export const ORDER_DETAIL_CACHE_TTL_MS = 60 * 1000;
export const INVENTORY_LIST_PAGE_SIZE = 20;

export const STATE_META = {
  all: { label: "全部订单", color: "slate" },
  awaiting_packaging: { label: "等待备货", color: "amber" },
  awaiting_deliver: { label: "等待发运", color: "blue" },
  ogl_dispatched: { label: "已发运", color: "blue" },
  delivering: { label: "运输中", color: "green" },
  dispute: { label: "有争议", color: "red" },
  delivered: { label: "已签收", color: "green" },
  cancelled: { label: "已取消", color: "slate" },
  unbound: { label: "待绑定库存", color: "amber" },
  pending_purchase: { label: "待采购", color: "red" },
  stock_issue: { label: "库存异常", color: "red" }
};

const AWAITING_PACKAGING_STATES = ["awaiting_approve", "awaiting_packaging", "posting_created"];
const AWAITING_DELIVER_STATES = ["acceptance_in_progress", "posting_acceptance_in_progress", "awaiting_registration", "posting_awaiting_registration", "posting_registration_error", "awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service", "posting_transferring", "posting_in_carriage", "posting_transferring_to_delivery"];
const DELIVERING_KEYWORDS = ["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "发往", "已上网", "发走"];

export function orderStateKey(row = {}) {
  const status = String(row?.status || "").toLowerCase();
  const text = [status, row?.tracking_stage, row?.logistics_status].map(value => String(value || "").toLowerCase()).join(" ");
  if (text.includes("return")) return "returned";
  if (text.includes("reject") || text.includes("not_accepted") || text.includes("unclaimed")) return "rejected";
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("delivered")) return "delivered";
  if (text.includes("dispute") || text.includes("arbitration")) return "dispute";
  // A stale acceptance substatus must not move an already-transiting order back.
  if (/(^|\s)(delivering|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^\s]*|posting_in_courier_service|posting_in_pickup_point)(\s|$)/.test(text)) return "delivering";
  const oglDisplayStatus = row?.ogl_dispatch?.dispatched === true || row?.ogl_dispatch?.tracking === true ? String(row?.display_status || "") : "";
  if (["delivering", "delivered", "cancelled", "dispute"].includes(oglDisplayStatus)) return oglDisplayStatus;
  if (DELIVERING_KEYWORDS.some(value => text.includes(value)) && !AWAITING_DELIVER_STATES.some(value => text.includes(value))) return "delivering";
  if (oglDisplayStatus === "ogl_dispatched") return "ogl_dispatched";
  if (AWAITING_DELIVER_STATES.some(value => text.includes(value))) return "awaiting_deliver";
  if (DELIVERING_KEYWORDS.some(value => text.includes(value))) return "delivering";
  if (AWAITING_PACKAGING_STATES.some(value => text.includes(value))) return "awaiting_packaging";
  return status || "all";
}

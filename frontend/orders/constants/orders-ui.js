export const SEARCH_TYPE_OPTIONS = [
  { value: "order", label: "订单号" },
  { value: "sku", label: "SKU" },
  { value: "offer", label: "货号" },
  { value: "tracking", label: "跟踪号" },
  { value: "purchaseTracking", label: "采购快递单号" },
  { value: "product", label: "库存产品" }
];

export const ORDER_DETAIL_CACHE_TTL_MS = 60 * 1000;
export const INVENTORY_LIST_PAGE_SIZE = 10;

export const STATE_META = {
  all: { label: "全部订单", color: "slate" },
  awaiting_packaging: { label: "等待备货", color: "amber" },
  awaiting_deliver: { label: "等待发货", color: "blue" },
  delivering: { label: "运输中", color: "green" },
  dispute: { label: "有争议", color: "red" },
  delivered: { label: "已签收", color: "green" },
  cancelled: { label: "已取消", color: "slate" },
  unbound: { label: "待绑定库存", color: "amber" },
  stock_issue: { label: "库存异常", color: "red" }
};

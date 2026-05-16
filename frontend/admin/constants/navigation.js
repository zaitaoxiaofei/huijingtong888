import { DataAnalysis, Document, Goods, House, Setting, ShoppingCart, WarningFilled } from "@element-plus/icons-vue";

export const navigationMenus = [
  { key: "dashboard", label: "首页看板", route: "/dashboard", icon: House },
  {
    key: "analytics",
    label: "经营分析",
    icon: DataAnalysis,
    children: [
      { key: "profit-dashboard", label: "利润看板", route: "/profit" },
      { key: "profit-sku-ranking", label: "SKU 排行榜", route: "/profit/sku-ranking" },
      { key: "profit-shop-ranking", label: "店铺排行榜", route: "/profit/shop-ranking" }
    ]
  },
  {
    key: "orders",
    label: "订单中心",
    icon: Document,
    children: [
      { key: "orders", label: "订单列表", route: "/orders" },
      { key: "outbound", label: "出库记录", route: "/outbound" }
    ]
  },
  {
    key: "inventory",
    label: "库存管理",
    icon: Goods,
    children: [
      { key: "inventory-products", label: "产品库存表", route: "/inventory/products" },
      { key: "inventory-fbp", label: "FBP 库存表", route: "/inventory/fbp" },
      { key: "inventory-hidden", label: "已隐藏产品", route: "/inventory/hidden" },
      { key: "inventory-mappings", label: "SKU 绑定配置", route: "/inventory/mappings" },
      { key: "inventory-suppliers", label: "供应商配置", route: "/inventory/suppliers" },
      { key: "inventory-alerts", label: "库存预警", route: "/inventory/alerts" }
    ]
  },
  {
    key: "procurement",
    label: "采购管理",
    icon: ShoppingCart,
    children: [
      { key: "procurement", label: "采购请求", route: "/procurement" },
      { key: "purchase-list", label: "采购清单", route: "/purchase-list" },
      { key: "purchase-history", label: "采购历史", route: "/purchase-history" },
      { key: "inbound", label: "入库管理", route: "/inbound" }
    ]
  },
  {
    key: "products",
    label: "商品管理",
    icon: Goods,
    children: [
      { key: "selection", label: "选品中心", route: "/selection" },
      { key: "online-products", label: "在线商品", route: "/online-products" }
    ]
  },
  {
    key: "exceptions",
    label: "异常中心",
    icon: WarningFilled,
    children: [
      { key: "exceptions-profit", label: "利润异常", route: "/exceptions/profit" },
      { key: "exceptions-deadline", label: "订单超时异常", route: "/exceptions/deadline" },
      { key: "exceptions-deadline-warning", label: "超时预警", route: "/exceptions/deadline-warning" },
      { key: "exceptions-stock", label: "库存异常", route: "/exceptions/stock" },
      { key: "exceptions-binding", label: "未绑定库存", route: "/exceptions/binding" }
    ]
  },
  {
    key: "settings",
    label: "系统设置",
    icon: Setting,
    children: [
      { key: "settings", label: "配置中心", route: "/settings" }
    ]
  }
];

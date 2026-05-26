import { ChatDotRound, DataAnalysis, Document, Goods, House, Setting, ShoppingCart, Tools, WarningFilled } from "@element-plus/icons-vue";

export const navigationMenus = [
  { key: "dashboard", label: "首页看板", route: "/dashboard", icon: House },
  {
    key: "analytics",
    label: "经营分析",
    icon: DataAnalysis,
    children: [
      { key: "profit-dashboard", label: "利润看板", route: "/profit" },
      { key: "advertising-daily", label: "广告系统", route: "/advertising/daily" },
      { key: "reviews", label: "评价中心", route: "/reviews", icon: ChatDotRound },
      { key: "profit-aftersales", label: "售后损失", route: "/profit/aftersales" }
    ]
  },
  {
    key: "tools",
    label: "工具中心",
    icon: Tools,
    children: [
      { key: "selection", label: "选品计价表", route: "/selection" },
      { key: "asset-variant-center", label: "素材裂变中心", route: "/asset-variant-center" },
      { key: "listing-automation", label: "编辑上架", route: "/listing-automation" },
      { key: "tools-image-cropper", label: "电商套图拆分器", route: "/tools/ecommerce-image-splitter" },
      { key: "tools-product-video-generator", label: "一键生成视频", route: "/tools/product-video-generator" },
      { key: "tools-ai-image-generator", label: "AI 套图生成中心", route: "/tools/ai-image-generator" }
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
      { key: "inventory-mappings", label: "库存-SKU映射表", route: "/inventory/mappings" },
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
      { key: "purchase-history", label: "采购历史", route: "/purchase-history" }
    ]
  },
  {
    key: "products",
    label: "商品管理",
    icon: Goods,
    children: [
      { key: "multi-shop-publish", label: "多店铺商品发布中台", route: "/multi-shop-publish" },
      { key: "ozon-actions", label: "活动管理", route: "/ozon-actions" },
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
      { key: "exceptions-binding", label: "未绑定仓库", route: "/exceptions/binding" }
    ]
  },
  {
    key: "settings",
    label: "系统设置",
    icon: Setting,
    children: [
      { key: "settings", label: "配置中心", route: "/settings" },
      { key: "settings-ai", label: "AI 配置", route: "/settings/ai" }
    ]
  }
];

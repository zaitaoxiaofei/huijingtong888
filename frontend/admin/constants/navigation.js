import { ChatDotRound, DataAnalysis, Document, Goods, House, Setting, ShoppingCart, Tools, WarningFilled } from "@element-plus/icons-vue";

export const navigationMenus = [
  { key: "dashboard", label: "首页看板", route: "/dashboard", icon: House },
  {
    key: "analytics",
    label: "经营分析",
    icon: DataAnalysis,
    children: [
      { key: "profit-dashboard", label: "利润看板", route: "/profit" },
      { key: "advertising-daily", label: "广告数据", route: "/advertising/daily" },
      { key: "reviews", label: "评价中心", route: "/reviews", icon: ChatDotRound },
      { key: "profit-aftersales", label: "售后损益", route: "/profit/aftersales" }
    ]
  },
  {
    key: "products",
    label: "商品中心",
    icon: Goods,
    children: [
      { key: "selection", label: "选品上架", route: "/selection" },
      { key: "listing-automation", label: "编辑上架", route: "/listing-automation" },
      { key: "listing-records", label: "上架记录", route: "/listing-records" },
      { key: "online-products", label: "在线商品", route: "/online-products" },
      { key: "asset-variant-center", label: "店铺矩阵列表", route: "/asset-variant-center" },
      { key: "main-image-vehicle-variant", label: "AI内容优化", route: "/asset-variant-center/create" },
      { key: "ozon-actions", label: "活动管理", route: "/ozon-actions" }
    ]
  },
  {
    key: "orders",
    label: "订单中心",
    icon: Document,
    children: [
      { key: "orders", label: "Ozon订单", route: "/orders" },
      { key: "outbound", label: "出库记录", route: "/outbound" }
    ]
  },
  {
    key: "inventory",
    label: "库存管理",
    icon: Goods,
    children: [
      { key: "inventory-products", label: "本地库存", route: "/inventory/products" },
      { key: "inventory-fbp", label: "Ozon FBP库存", route: "/inventory/fbp" },
      { key: "inventory-mappings", label: "SKU库存映射", route: "/inventory/mappings" },
      { key: "inventory-alerts", label: "库存预警", route: "/inventory/alerts" },
      { key: "inventory-hidden", label: "隐藏商品", route: "/inventory/hidden" },
      { key: "inventory-suppliers", label: "供应商", route: "/inventory/suppliers" }
    ]
  },
  {
    key: "procurement",
    label: "采购管理",
    icon: ShoppingCart,
    children: [
      { key: "procurement", label: "采购需求", route: "/procurement" },
      { key: "purchase-list", label: "采购清单", route: "/purchase-list" },
      { key: "purchase-history", label: "采购历史", route: "/purchase-history" }
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
    key: "tools",
    label: "工具中心",
    icon: Tools,
    children: [
      { key: "tools-image-cropper", label: "套图拆分", route: "/tools/ecommerce-image-splitter" },
      { key: "tools-product-video-generator", label: "视频生成", route: "/tools/product-video-generator" }
    ]
  },
  {
    key: "settings",
    label: "系统设置",
    icon: Setting,
    children: [
      { key: "settings", label: "配置中心", route: "/settings" },
      { key: "settings-ai", label: "AI 配置", route: "/settings/ai" },
      { key: "settings-materials", label: "素材中心", route: "/settings/materials" }
    ]
  }
];

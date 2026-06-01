import { ChatDotRound, DataAnalysis, Document, Goods, House, Setting, ShoppingCart, Tools, WarningFilled } from "@element-plus/icons-vue";

export const navigationMenus = [
  { key: "dashboard", label: "首页", route: "/dashboard", icon: House },
  {
    key: "analytics",
    label: "看板",
    icon: DataAnalysis,
    children: [
      { key: "profit-dashboard", label: "利润分析", route: "/profit" },
      { key: "seller-analytics", label: "数据分析", route: "/seller-analytics" },
      { key: "advertising-daily", label: "广告分析", route: "/advertising/daily" },
      { key: "ozon-actions", label: "Ozon 活动", route: "/ozon-actions" },
      { key: "reviews", label: "买家评价", route: "/reviews", icon: ChatDotRound },
      { key: "profit-aftersales", label: "售后损益", route: "/profit/aftersales" }
    ]
  },
  {
    key: "products",
    label: "运营",
    icon: Goods,
    children: [
      { key: "collector-box", label: "采集箱", route: "/collector-box" },
      { key: "selection", label: "选品池", route: "/selection" },
      { key: "listing-automation", label: "商品上架", route: "/listing-automation" },
      { key: "listing-records", label: "上架记录", route: "/listing-records" },
      { key: "online-products", label: "在线商品", route: "/online-products" },
      { key: "asset-variant-center", label: "多店铺商品", route: "/asset-variant-center" },
      { key: "main-image-vehicle-variant", label: "AI 素材优化", route: "/asset-variant-center/create" },
    ]
  },
  {
    key: "orders",
    label: "订单",
    icon: Document,
    children: [
      { key: "orders", label: "订单列表", route: "/orders" },
      { key: "outbound", label: "出库记录", route: "/outbound" }
    ]
  },
  {
    key: "inventory",
    label: "库存",
    icon: Goods,
    children: [
      { key: "inventory-products", label: "商品库存", route: "/inventory/products" },
      { key: "inventory-fbp", label: "FBP 库存", route: "/inventory/fbp" },
      { key: "inventory-fbp-opportunities", label: "备货建议", route: "/inventory/fbp-opportunities" },
      { key: "inventory-mappings", label: "SKU 绑定", route: "/inventory/mappings" },
      { key: "inventory-alerts", label: "库存预警", route: "/inventory/alerts" },
      { key: "inventory-hidden", label: "已删除商品", route: "/inventory/hidden" },
      { key: "inventory-suppliers", label: "供应商", route: "/inventory/suppliers" }
    ]
  },
  {
    key: "procurement",
    label: "采购",
    icon: ShoppingCart,
    children: [
      { key: "procurement", label: "采购需求", route: "/procurement" },
      { key: "purchase-list", label: "待采购清单", route: "/purchase-list" },
      { key: "purchase-history", label: "采购记录", route: "/purchase-history" }
    ]
  },
  {
    key: "exceptions",
    label: "异常",
    icon: WarningFilled,
    children: [
      { key: "exceptions-profit", label: "利润异常", route: "/exceptions/profit" },
      { key: "exceptions-deadline", label: "订单超时", route: "/exceptions/deadline" },
      { key: "exceptions-deadline-warning", label: "超时预警", route: "/exceptions/deadline-warning" },
      { key: "exceptions-stock", label: "库存异常", route: "/exceptions/stock" },
      { key: "exceptions-binding", label: "未绑定 SKU", route: "/exceptions/binding" }
    ]
  },
  {
    key: "tools",
    label: "工具",
    icon: Tools,
    children: [
      { key: "tools-image-cropper", label: "套图拆分", route: "/tools/ecommerce-image-splitter" },
      { key: "tools-product-video-generator", label: "商品视频", route: "/tools/product-video-generator" }
    ]
  },
  {
    key: "settings",
    label: "系统",
    icon: Setting,
    children: [
      { key: "settings", label: "基础资料", route: "/settings" },
      { key: "settings-scheduled-jobs", label: "自动任务", route: "/settings/scheduled-jobs" },
      { key: "settings-ai", label: "AI 设置", route: "/settings/ai" },
      { key: "settings-materials", label: "素材库", route: "/settings/materials" }
    ]
  }
];

export const navigationIconByRoute = navigationMenus.reduce((map, menu) => {
  if (menu.route) map.set(menu.route, menu.icon || null);
  if (menu.children?.length) {
    menu.children.forEach((child) => {
      map.set(child.route, child.icon || menu.icon || null);
    });
  }
  return map;
}, new Map());

import { canAccessPage } from "../../../src/shared/permissions.js";
import { ChatDotRound, Coin, DataAnalysis, Document, Finished, Goods, House, MagicStick, Setting, ShoppingCart, Tools, WarningFilled } from "@element-plus/icons-vue";

export const navigationMenus = [
  { key: "dashboard", label: "首页", route: "/dashboard", icon: House },
  { key: "team-plan", label: "任务系统", route: "/team-plan", icon: Finished },
  { key: "onboarding", label: "入职须知", route: "/onboarding", icon: Document },
  {
    key: "finance",
    label: "财务中心",
    icon: Coin,
    adminOnly: true,
    children: [
      { key: "finance-center", label: "财务总览", route: "/finance-center" },
      { key: "profit-monthly-billing", label: "月度账单", route: "/profit/monthly-billing" },
      { key: "finance-payroll", label: "员工工资", route: "/finance/payroll" },
    ]
  },
  {
    key: "analytics",
    label: "数据分析",
    icon: DataAnalysis,
    children: [
      { key: "seller-analytics", label: "数据分析", route: "/seller-analytics" },
      { key: "order-car-heatmap", label: "车型机会", route: "/order-car-heatmap" },
      { key: "advertising-daily", label: "广告分析", route: "/advertising/daily" }
    ]
  },
  {
    key: "products",
    label: "运营",
    icon: Goods,
    children: [
      { key: "collector-box", label: "采集箱", route: "/collector-box" },
      { key: "selection", label: "选品池", route: "/selection" },
      { key: "listing-records", label: "草稿箱", route: "/listing-records" },
      { key: "listing-automation", label: "商品上架", route: "/listing-automation" },
      { key: "listing-publish-records", label: "上架记录", route: "/listing-publish-records" },
      { key: "batch-stock-update", label: "批量改库存", route: "/batch-stock-update" },
      { key: "ozon-actions", label: "Ozon 活动", route: "/ozon-actions" }
    ]
  },
  {
    key: "ai-skills",
    label: "AI技能库",
    icon: MagicStick,
    children: [
      { key: "ai-variant-lab", label: "AI裂变", route: "/ai-variant-lab" },
      { key: "ai-variant-cases", label: "AI裂变案例库", route: "/ai-variant-cases" },
      { key: "ai-product-material-optimizer", label: "AI优化", route: "/ai-product-material-optimizer" },
      { key: "ai-ecommerce-suite", label: "AI电商套图", route: "/ai-ecommerce-suite" },
      { key: "ai-material-optimization-records", label: "素材优化记录", route: "/ai-material-optimization-records" }
    ]
  },
  {
    key: "orders",
    label: "订单",
    icon: Document,
    children: [
      { key: "orders", label: "订单列表", route: "/orders" },
      { key: "order-tracking", label: "单量追踪", route: "/order-tracking" },
      { key: "outbound", label: "出库记录", route: "/outbound" },
      { key: "customer-messages", label: "客户消息", route: "/customer-messages", icon: ChatDotRound }
    ]
  },
  {
    key: "inventory",
    label: "库存",
    icon: Goods,
    children: [
      { key: "inventory-products", label: "商品库存", route: "/inventory/products" },
      { key: "purchase-list", label: "采购清单 / 待入库", route: "/purchase-list" },
      { key: "inventory-fbp", label: "FBP库存", route: "/inventory/fbp" },
      { key: "inventory-alerts", label: "库存预警", route: "/inventory/alerts" },
      { key: "inventory-fbp-opportunities", label: "备货建议", route: "/inventory/fbp-opportunities" },
      { key: "inventory-fbp-replenishment", label: "FBP备货单", route: "/inventory/fbp-replenishment" },
      { key: "inventory-mappings", label: "SKU绑定", route: "/inventory/mappings" },
      { key: "inventory-hidden", label: "已删除商品", route: "/inventory/hidden" }
    ]
  },
  {
    key: "procurement",
    label: "采购",
    icon: ShoppingCart,
    children: [
      { key: "procurement-workspace", label: "采购工作台", route: "/procurement/workspace" },
      { key: "purchase-history", label: "入库记录", route: "/purchase-history" },
      { key: "purchase-cost-center", label: "成本预警", route: "/purchase-cost-center" },
      { key: "procurement-reconciliation", label: "采购对账", route: "/procurement/reconciliation" },
      { key: "procurement-platform-orders", label: "平台订单", route: "/procurement/platform-orders" },
      { key: "inventory-suppliers", label: "供应商", route: "/inventory/suppliers" }
    ]
  },
  {
    key: "exceptions",
    label: "异常",
    icon: WarningFilled,
    children: [
      { key: "exceptions-profit", label: "利润异常", route: "/exceptions/profit", adminOnly: true },
      { key: "exceptions-deadline", label: "订单超时", route: "/exceptions/deadline" },
      { key: "exceptions-deadline-warning", label: "超时预警", route: "/exceptions/deadline-warning" },
      { key: "exceptions-stock", label: "库存异常", route: "/exceptions/stock" },
      { key: "exceptions-binding", label: "未绑定 SKU", route: "/exceptions/binding" },
      { key: "profit-inventory-risks", label: "库存利润风险", route: "/profit/inventory-risks", adminOnly: true },
      { key: "pending-settlement-costs", label: "待结算成本", route: "/profit/pending-settlement-costs", adminOnly: true },
      { key: "profit-order-item-variances", label: "订单商品行差异", route: "/profit/order-item-variances", adminOnly: true }
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
    adminOnly: true,
    children: [
      { key: "settings", label: "基础资料", route: "/settings" },
      { key: "settings-scheduled-jobs", label: "自动任务", route: "/settings/scheduled-jobs" },
      { key: "settings-system-monitoring", label: "系统监控", route: "/settings/system-monitoring" },
      { key: "settings-ai", label: "AI 设置", route: "/settings/ai" },
      { key: "settings-prompts", label: "AI提示词库", route: "/settings/prompts" },
      { key: "asset-variant-center", label: "店铺矩阵裂变配置", route: "/asset-variant-center" },
      { key: "settings-materials", label: "素材库", route: "/settings/materials" }
    ]
  }
];

export function navigationMenusForRole(subject) {
  return navigationMenus
    .map(menu => menu.children
      ? { ...menu, children: menu.children.filter(child => canAccessPage(subject, child.route)) }
      : menu)
    .filter(menu => menu.children ? menu.children.length > 0 : canAccessPage(subject, menu.route));
}

export const navigationIconByRoute = navigationMenus.reduce((map, menu) => {
  if (menu.route) map.set(menu.route, menu.icon || null);
  if (menu.children?.length) {
    menu.children.forEach((child) => {
      map.set(child.route, child.icon || menu.icon || null);
    });
  }
  return map;
}, new Map());

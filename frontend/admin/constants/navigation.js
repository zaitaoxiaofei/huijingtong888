import { planFeatureMessage } from "../../../src/shared/subscription-plan-features.js";
import { aiSkillsAvailable } from "../../../src/shared/ai-skills-access.js";
import { canAccessPage, pagePermission, hasPermission, isPlatformAdmin, needsMembershipActivation } from "../../../src/shared/permissions.js";
import { House, ListChecks, ChartNoAxesCombined, ChartColumn, Store, Sparkles, Package, Warehouse, ShoppingCart, TriangleAlert, Wrench, Settings, MessageCircle } from "lucide-vue-next";

export const navigationMenus = [
  { key: "dashboard", label: "首页", route: "/dashboard", icon: House },
  { key: "team-plan", label: "任务系统", route: "/team-plan", icon: ListChecks },
  {
    key: "finance",
    label: "财务中心",
    icon: ChartNoAxesCombined,
    children: [
      { key: "finance-center", label: "经营总览", route: "/finance-center" },
      { key: "profit-monthly-billing", label: "月度账单", route: "/profit/monthly-billing" },
      { key: "finance-payroll", label: "工资管理", route: "/finance/payroll" },
      { key: "finance-reimbursements", label: "报销中心", route: "/finance/reimbursements" },
    ]
  },
  {
    key: "analytics",
    label: "数据分析",
    icon: ChartColumn,
    children: [
      { key: "sku-traffic-monitor", label: "SKU流量监控", route: "/sku-traffic-monitor" },
      { key: "seller-analytics", label: "数据分析", route: "/seller-analytics" },
      { key: "order-car-heatmap", label: "型号机会", route: "/order-car-heatmap" },
      { key: "advertising-daily", label: "广告分析", route: "/advertising/daily" }
    ]
  },
  {
    key: "products",
    label: "运营",
    icon: Store,
    children: [
      { key: "collector-box", label: "采集箱", route: "/collector-box" },
      { key: "selection", label: "选品池", route: "/selection" },
      { key: "listing-records", label: "草稿箱", route: "/listing-records" },
      { key: "listing-automation", platform: "ozon", label: "商品上架", route: "/listing-automation" },
      { key: "listing-publish-records", label: "上架记录", route: "/listing-publish-records" },
      { key: "wb-listing", platform: "wb", label: "商品上架", route: "/wb/listing" },
      { key: "wb-online-products", platform: "wb", label: "WB 在线商品", route: "/wb/online-products" },
      { key: "online-products", platform: "ozon", label: "在线商品", route: "/online-products" },
      { key: "batch-stock-update", label: "批量改库存", route: "/batch-stock-update" },
      { key: "ozon-actions", label: "平台活动", route: "/ozon-actions" },
      { key: "asset-variant-center", label: "店铺矩阵", route: "/asset-variant-center" }
    ]
  },
  {
    key: "ai-skills",
    label: "AI技能库",
    icon: Sparkles,
    children: [
      { key: "product-workflows", label: "AI模板工作流", route: "/product-workflows" },
      { key: "ai-variant-lab", label: "AI裂变", route: "/ai-variant-lab" },
      { key: "ai-product-material-optimizer", label: "AI优化", route: "/ai-product-material-optimizer" },
      { key: "ai-ecommerce-suite", label: "AI电商套图", route: "/ai-ecommerce-suite" },
      { key: "ai-materials", label: "AI生成记录", route: "/ai-materials" },
      { key: "ai-prompts", label: "提示词库", route: "/ai-prompts" }
    ]
  },
  {
    key: "orders",
    label: "订单",
    icon: Package,
    children: [
      { key: "orders", label: "订单处理", route: "/orders" },
      { key: "order-tracking", label: "单量追踪", route: "/order-tracking" },
      { key: "outbound", label: "出库记录", route: "/outbound" },
      { key: "customer-messages", label: "客户消息", route: "/customer-messages", icon: MessageCircle }
    ]
  },
  {
    key: "inventory",
    label: "库存",
    icon: Warehouse,
    children: [
      { key: "inventory-products", label: "商品库存", route: "/inventory/products" },
      { key: "purchase-list", label: "收货入库", route: "/purchase-list" },
      { key: "inventory-capital", label: "库存占用", route: "/finance/inventory-capital", adminOnly: true },
      { key: "inventory-fbp", label: "FBP", route: "/inventory/fbp" }
    ]
  },
  {
    key: "procurement",
    label: "采购",
    icon: ShoppingCart,
    children: [
      { key: "procurement-workspace", label: "采购工作台", route: "/procurement/workspace" },
      { key: "purchase-cost-center", label: "成本管理", route: "/purchase-cost-center" },
      { key: "procurement-reconciliation", label: "采购核对", route: "/procurement/platform-orders" },
      { key: "inventory-suppliers", label: "供应商", route: "/inventory/suppliers" }
    ]
  },
  {
    key: "exceptions",
    label: "异常",
    icon: TriangleAlert,
    children: [
      { key: "exceptions-stock", label: "库存不足", route: "/exceptions/stock" },
      { key: "exceptions-binding", label: "未绑定库存", route: "/exceptions/binding" },
      { key: "profit-inventory-risks", label: "库存利润异常", route: "/profit/inventory-risks", adminOnly: true },
      { key: "pending-settlement-costs", label: "订单结算超时", route: "/profit/pending-settlement-costs", adminOnly: true },
      { key: "profit-order-item-variances", label: "订单商品行差异", route: "/profit/order-item-variances", adminOnly: true }
    ]
  },
  {
    key: "tools",
    label: "工具",
    icon: Wrench,
    children: [
      { key: "tools-profit-calculator", label: "利润计算器", route: "/tools/profit-calculator" },
      { key: "tools-pricing", label: "定价工具", route: "/tools/pricing" },
      { key: "tools-packaging-fee-rule", label: "包装费规则", route: "/tools/packaging-fee-rule" },
      { key: "tools-17track", label: "17TRACK 全球物流查询", route: "https://www.17track.net/zh-cn" },
      { key: "tools-image-cropper", label: "套图拆分", route: "/tools/ecommerce-image-splitter" },
      { key: "tools-product-video-generator", label: "商品视频", route: "/tools/product-video-generator" }
    ]
  },
  {
    key: "tenant-shops",
    label: "企业店铺",
    icon: Settings,
    children: [
      { key: "tenant-shops", label: "店铺管理", route: "/tenant-shops" },
      { key: "ai-credits", label: "AI积分", route: "/ai-credits", icon: ChartNoAxesCombined },
      { key: "tenant-people", label: "企业人员", route: "/tenant-people" },
      { key: "logistics-settings", label: "物流设置", route: "/logistics-settings" }
    ]
  },
  {
    key: "settings",
    label: "平台管理",
    icon: Settings,
    adminOnly: true,
    children: [
      { key: "platform-accounts", label: "平台人员", route: "/platform-accounts" },
      { key: "tenant-management", label: "企业与授权", route: "/tenant-management" },
      { key: "order-cancellation-rules", label: "取消规则设置", route: "/order-cancellation-rules" },
      { key: "settings-scheduled-jobs", label: "自动任务", route: "/settings/scheduled-jobs" },
      { key: "settings-system-monitoring", label: "系统监控", route: "/settings/system-monitoring" },
      { key: "settings-ai", label: "AI 设置", route: "/settings/ai" }
    ]
  }
];

export function navigationMenusForRole(subject) {
  return navigationMenus
    .map(menu => {
      if (menu.key === "ai-skills" && subject?.tenant?.id && !aiSkillsAvailable(subject)) {
        return { ...menu, disabled: true, disabledReason: planFeatureMessage("ai"),
          children: menu.children.filter(child => !needsMembershipActivation(subject) && (pagePermission(child.route) === "platform.admin" ? isPlatformAdmin(subject) : hasPermission(subject, pagePermission(child.route)))).map(child => ({ ...child, disabled: true })) };
      }
      return menu.children ? { ...menu, children: menu.children.filter(child => canAccessPage(subject, child.route)) } : menu;
    })
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

export const navigationPlatformByRoute = new Map(navigationMenus.flatMap(menu => (menu.children || []).filter(child => child.platform).map(child => [child.route, child.platform])));

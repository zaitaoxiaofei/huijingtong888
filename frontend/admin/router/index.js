import { canAccessPage, hasPermission, isPlatformAdmin, needsMembershipActivation } from "../../../src/shared/permissions.js";
import { createRouter, createWebHashHistory } from "vue-router";
import AdminLayout from "../layouts/AdminLayout.vue";
import MobileLayout from "../layouts/MobileLayout.vue";
import LoginView from "../views/LoginView.vue";
import { useAuthStore } from "../stores/auth";
import { markRouteReadyPerf, startRoutePerf } from "../utils/performance-monitor";
import { membershipDialogRequest, requestMembershipDialog } from "../utils/membership-dialog.js";

const DashboardView = () => import("../views/DashboardView.vue");
const MembershipView = () => import("../views/MembershipView.vue");
const TeamPlanView = () => import("../views/team/ProductDevelopmentCenterView.vue");
const ProfitExceptionView = () => import("../views/exceptions/ProfitExceptionView.vue");
const DeadlineExceptionView = () => import("../views/exceptions/DeadlineExceptionView.vue");
const DeadlineWarningExceptionView = () => import("../views/exceptions/DeadlineWarningExceptionView.vue");
const StockExceptionView = () => import("../views/exceptions/StockExceptionView.vue");
const BindingExceptionView = () => import("../views/exceptions/BindingExceptionView.vue");
const InventoryView = () => import("../views/inventory/InventoryView.vue");
const InventoryProductsPage = () => import("../views/inventory/InventoryProductsPage.vue");
const InventoryFbpPage = () => import("../views/inventory/InventoryFbpPage.vue");
const InventoryFbpOpportunitiesPage = () => import("../views/inventory/InventoryFbpOpportunitiesPage.vue");
const InventoryFbpReplenishmentPage = () => import("../views/inventory/InventoryFbpReplenishmentPage.vue");
const InventoryHiddenPage = () => import("../views/inventory/InventoryHiddenPage.vue");
const InventoryMappingsPage = () => import("../views/inventory/InventoryMappingsPage.vue");
const InventorySuppliersPage = () => import("../views/inventory/InventorySuppliersPage.vue");
const InventoryAlertsPage = () => import("../views/inventory/InventoryAlertsPage.vue");
const OnlineProductsView = () => import("../views/inventory/OnlineProductsView.vue");
const ListingAutomationView = () => import("../views/listing/ListingAutomationView.vue");
const ListingPublishRecordsView = () => import("../views/listing/ListingPublishRecordsView.vue");
const CollectorBoxView = () => import("../views/listing/CollectorBoxView.vue");
const AiVariantLabView = () => import("../views/listing/AiVariantLabView.vue");
const AiVariantCaseLibraryView = () => import("../views/listing/AiVariantCaseLibraryView.vue");
const AiProductMaterialOptimizerView = () => import("../views/listing/AiProductMaterialOptimizerView.vue");
const AiEcommerceSuiteWorkbenchView = () => import("../views/listing/AiEcommerceSuiteWorkbenchView.vue");
const AiMaterialOptimizationRecordsView = () => import("../views/listing/AiMaterialOptimizationRecordsView.vue");
const ShopAssetVariantCenterView = () => import("../views/listing/ShopAssetVariantCenter.vue");
const SelectionView = () => import("../views/selection/SelectionView.vue");
const MonthlyBillingHubView = () => import("../views/profit/MonthlyBillingHubView.vue");
const ProfitInventoryRisksView = () => import("../views/profit/ProfitInventoryRisksView.vue");
const ProfitOrderItemVariancesView = () => import("../views/profit/ProfitOrderItemVariancesView.vue");
const PendingSettlementCostsView = () => import("../views/profit/PendingSettlementCostsView.vue");
const AdvertisingDailyView = () => import("../views/advertising/AdvertisingDailyView.vue");
const FinanceCenterView = () => import("../views/finance/FinanceCenterView.vue");
const PayrollView = () => import("../views/finance/PayrollView.vue");
const SellerAnalyticsView = () => import("../views/analytics/SellerAnalyticsView.vue");
const OrderCarHeatmapView = () => import("../views/analytics/OrderCarHeatmapView.vue");
const OzonActionsView = () => import("../views/marketing/OzonActionsView.vue");
const OrdersView = () => import("../views/orders/OrdersView.vue");
const OrderTrackingView = () => import("../views/orders/OrderTrackingView.vue");
const OutboundView = () => import("../views/orders/OutboundView.vue");
const CustomerMessagesView = () => import("../views/orders/CustomerMessagesView.vue");
const PurchaseListView = () => import("../views/procurement/PurchaseListView.vue");
const ProcurementWorkspaceView = () => import("../views/procurement/ProcurementWorkspaceView.vue");
const ProcurementPlatformOrdersView = () => import("../views/procurement/ProcurementPlatformOrdersView.vue");
const ProcurementReconciliationView = () => import("../views/procurement/ProcurementReconciliationView.vue");
const PurchaseHistoryView = () => import("../views/procurement/PurchaseHistoryView.vue");
const PurchaseCostCenterView = () => import("../views/procurement/PurchaseCostCenterView.vue");
const SettingsView = () => import("../views/settings/SettingsView.vue");
const PackagingFeeRuleView = () => import("../views/tools/PackagingFeeRuleView.vue");
const AiProviderSettingsView = () => import("../views/settings/AiProviderSettingsView.vue");
const MaterialCenterView = () => import("../views/settings/MaterialCenterView.vue");
const AiPromptLibraryView = () => import("../views/settings/AiPromptLibraryView.vue");
const ScheduledJobsView = () => import("../views/settings/ScheduledJobsView.vue");
const SystemMonitoringView = () => import("../views/settings/SystemMonitoringView.vue");
const TenantSubscriptionView = () => import("../views/settings/TenantSubscriptionView.vue");
const TenantShopsView = () => import("../views/settings/TenantShopsView.vue");
const EnterprisePersonnelPanel = () => import("../views/settings/EnterprisePersonnelPanel.vue");
const PlatformAccountsView = () => import("../views/settings/PlatformAccountsView.vue");
const ImageCropperView = () => import("../views/tools/ImageCropper.vue");
const EcommerceImageSplitterView = () => import("../views/tools/EcommerceImageSplitterV3.vue");
const ProductVideoGeneratorView = () => import("../views/tools/ProductVideoGenerator.vue");
const PricingToolView = () => import("../views/tools/PricingToolView.vue");
const ProfitCalculatorView = () => import("../views/tools/ProfitCalculatorView.vue");
const MobileHomeView = () => import("../views/mobile/MobileHomeView.vue");
const MobileOrdersView = () => import("../views/mobile/MobileOrdersView.vue");
const MobileOrderDetailView = () => import("../views/mobile/MobileOrderDetailView.vue");
const MobileProcurementView = () => import("../views/mobile/MobileProcurementView.vue");
const MobileInventoryView = () => import("../views/mobile/MobileInventoryView.vue");
const MobileStockAlertsView = () => import("../views/mobile/MobileStockAlertsView.vue");
const MobileOnlineProductsView = () => import("../views/mobile/MobileOnlineProductsView.vue");

const MOBILE_MODE_STORAGE_KEY = "baodanMobileMode";

function isMobileBrowser() {
  if (typeof window === "undefined") return false;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  const narrowScreen = window.matchMedia?.("(max-width: 768px)")?.matches;
  const ua = String(window.navigator?.userAgent || "").toLowerCase();
  return Boolean((coarsePointer && narrowScreen) || /iphone|ipad|ipod|android|mobile/.test(ua));
}

function prefersDesktopMode() {
  try {
    return window.localStorage?.getItem(MOBILE_MODE_STORAGE_KEY) === "desktop";
  } catch {
    return false;
  }
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true, title: "登录" } },
    {
      path: "/mobile",
      component: MobileLayout,
      meta: { mobile: true },
      children: [
        { path: "", name: "mobile-home", component: MobileHomeView, meta: { title: "手机工作台", mobile: true } },
        { path: "orders", name: "mobile-orders", component: MobileOrdersView, meta: { title: "手机订单", mobile: true } },
        { path: "orders/:id", name: "mobile-order-detail", component: MobileOrderDetailView, meta: { title: "订单详情", mobile: true } },
        { path: "inventory", name: "mobile-inventory", component: MobileInventoryView, meta: { title: "库存查询", mobile: true } },
        { path: "stock-alerts", name: "mobile-stock-alerts", component: MobileStockAlertsView, meta: { title: "库存预警", mobile: true } },
        { path: "online-products", name: "mobile-online-products", component: MobileOnlineProductsView, meta: { title: "在线商品", mobile: true } },
        { path: "procurement", name: "mobile-procurement", component: MobileProcurementView, meta: { title: "手机采购", mobile: true } }
      ]
    },
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "team-plan", name: "team-plan", component: TeamPlanView, meta: { title: "任务系统", breadcrumb: ["任务系统"] } },
        { path: "dashboard", name: "dashboard", component: DashboardView, meta: { title: "经营首页", breadcrumb: ["经营首页"] } },
        { path: "membership", name: "membership", component: MembershipView, meta: { title: "会员中心", breadcrumb: ["会员中心"] } },
        { path: "onboarding", redirect: { path: "/dashboard", query: {}, hash: "" } },
        { path: "exceptions", redirect: "/exceptions/profit", meta: { title: "待处理异常", breadcrumb: ["待处理异常"] } },
        { path: "exceptions/profit", name: "exceptions-profit", component: ProfitExceptionView, meta: { title: "利润异常", breadcrumb: ["待处理异常", "利润异常"] } },
        { path: "exceptions/deadline", name: "exceptions-deadline", component: DeadlineExceptionView, meta: { title: "订单超时", breadcrumb: ["待处理异常", "订单超时"] } },
        { path: "exceptions/deadline-warning", name: "exceptions-deadline-warning", component: DeadlineWarningExceptionView, meta: { title: "超时预警", breadcrumb: ["待处理异常", "超时预警"] } },
        { path: "exceptions/stock", name: "exceptions-stock", component: StockExceptionView, meta: { title: "库存异常", breadcrumb: ["待处理异常", "库存异常"] } },
        { path: "exceptions/binding", name: "exceptions-binding", component: BindingExceptionView, meta: { title: "未绑定 SKU", breadcrumb: ["待处理异常", "未绑定 SKU"] } },
        {
          path: "inventory",
          name: "inventory",
          component: InventoryView,
          meta: { title: "库存中心", breadcrumb: ["库存中心"] },
          children: [
            { path: "", redirect: "/inventory/products" },
            { path: "products/:productId", name: "inventory-product-detail", component: () => import('../views/inventory/InventoryProductDetailPage.vue'), meta: { title: '商品库存详情', breadcrumb: ['库存中心','商品库存'] } },
            { path: "products", name: "inventory-products", component: InventoryProductsPage, meta: { title: "商品库存", breadcrumb: ["库存中心", "商品库存"] } },
            { path: "flow-center", redirect: "/inventory/products" },
            { path: "fbp", name: "inventory-fbp", component: InventoryFbpPage, meta: { title: "FBP 库存", breadcrumb: ["库存中心", "FBP 库存"] } },
            { path: "fbp-opportunities", name: "inventory-fbp-opportunities", component: InventoryFbpOpportunitiesPage, meta: { title: "备货建议", breadcrumb: ["库存中心", "备货建议"] } },
            { path: "fbp-replenishment", name: "inventory-fbp-replenishment", component: InventoryFbpReplenishmentPage, meta: { title: "FBP备货单", breadcrumb: ["库存中心", "FBP备货单"] } },
            { path: "hidden", name: "inventory-hidden", component: InventoryHiddenPage, meta: { title: "已删除商品", breadcrumb: ["库存中心", "已删除商品"] } },
            { path: "mappings", name: "inventory-mappings", component: InventoryMappingsPage, meta: { title: "SKU 绑定", breadcrumb: ["库存中心", "SKU 绑定"] } },
            { path: "suppliers", name: "inventory-suppliers", component: InventorySuppliersPage, meta: { title: "供应商", breadcrumb: ["采购入库", "供应商"] } },
            { path: "alerts", name: "inventory-alerts", component: InventoryAlertsPage, meta: { title: "库存预警", breadcrumb: ["库存中心", "库存预警"] } }
          ]
        },
        { path: "online-products", name: "online-products", component: OnlineProductsView, meta: { title: "在线商品", breadcrumb: ["商品运营", "在线商品"] } },
        { path: "asset-variant-center", name: "asset-variant-center", component: ShopAssetVariantCenterView, meta: { title: "店铺矩阵", breadcrumb: ["AI技能库", "店铺矩阵"] } },
        { path: "asset-variant-center/create", name: "asset-variant-center-create", redirect: (to) => ({ name: "ai-variant-lab", query: to.query }) },
        { path: "asset-variant-center/wizard", name: "asset-variant-center-wizard", redirect: (to) => ({ name: "ai-variant-lab", query: to.query }), meta: { title: "AI裂变", breadcrumb: ["AI技能库", "AI裂变"], tabKey: "workbench" } },
        { path: "ai-variant-lab", name: "ai-variant-lab", component: AiVariantLabView, meta: { title: "AI裂变", breadcrumb: ["AI技能库", "AI裂变"], tabKey: "workbench" } },
        { path: "ai-variant-cases", name: "ai-variant-cases", component: AiVariantCaseLibraryView, meta: { title: "裂变案例", breadcrumb: ["AI技能库", "裂变案例"], tabKey: "workbench" } },
        { path: "ai-product-material-optimizer", name: "ai-product-material-optimizer", component: AiProductMaterialOptimizerView, meta: { title: "AI优化", breadcrumb: ["AI技能库", "AI优化"], tabKey: "workbench" } },
        { path: "ai-ecommerce-suite", name: "ai-ecommerce-suite", component: AiEcommerceSuiteWorkbenchView, meta: { title: "AI电商套图", breadcrumb: ["AI技能库", "AI电商套图"], tabKey: "workbench" } },
        { path: "ai-material-optimization-records", name: "ai-material-optimization-records", component: AiMaterialOptimizationRecordsView, meta: { title: "素材优化记录", breadcrumb: ["AI技能库", "素材优化记录"] } },
        { path: "listing-automation", name: "listing-automation", component: ListingAutomationView, meta: { title: "商品上架", breadcrumb: ["商品运营", "商品上架"], tabKey: "workbench" } },
        { path: "collector-box", name: "collector-box", component: CollectorBoxView, meta: { title: "采集箱", breadcrumb: ["商品运营", "采集箱"], tabKey: "workbench" } },
        { path: "listing-records", name: "listing-records", component: ListingPublishRecordsView, meta: { title: "草稿箱", breadcrumb: ["商品运营", "草稿箱"], recordMode: "drafts" } },
        { path: "listing-publish-records", name: "listing-publish-records", component: ListingPublishRecordsView, meta: { title: "上架记录", breadcrumb: ["商品运营", "上架记录"], recordMode: "publish" } },
        { path: "batch-stock-update", name: "batch-stock-update", component: OnlineProductsView, meta: { title: "批量改库存", breadcrumb: ["商品运营", "批量改库存"] } },
        {
          path: "listing-records/edit",
          name: "listing-record-editor",
          redirect: (to) => ({
            name: "listing-automation",
            query: {
              ...to.query,
              returnTo: String(to.query.returnTo || "/listing-publish-records")
            }
          }),
          meta: { title: "编辑上架", breadcrumb: ["商品运营", "上架记录", "编辑上架"], tabKey: "workbench" }
        },
        { path: "ozon-actions", name: "ozon-actions", component: OzonActionsView, meta: { title: "Ozon 活动", breadcrumb: ["商品运营", "Ozon 活动"] } },
        { path: "selection", name: "selection", component: SelectionView, meta: { title: "选品池", breadcrumb: ["商品运营", "选品池"], tabKey: "workbench" } },
        { path: "profit", redirect: "/profit/monthly-billing" },
        { path: "seller-analytics", name: "seller-analytics", component: SellerAnalyticsView, meta: { title: "数据分析", breadcrumb: ["数据看板", "数据分析"] } },
        { path: "order-car-heatmap", name: "order-car-heatmap", component: OrderCarHeatmapView, meta: { title: "车型机会", breadcrumb: ["数据看板", "车型机会"] } },
        { path: "profit/aftersales", redirect: (to) => ({ path: "/profit/monthly-billing", query: { ...to.query, tab: "aftersales" } }) },
        { path: "profit/monthly-billing", name: "profit-monthly-billing", component: MonthlyBillingHubView, meta: { title: "月度账单", breadcrumb: ["财务中心", "月度账单"] } },
        { path: "profit/monthly-billing/orders", redirect: (to) => ({ path: "/profit/monthly-billing", query: { ...to.query, tab: "orders" } }) },
        { path: "profit/reconciliation", redirect: "/profit/inventory-risks" },
        { path: "profit/inventory-risks", name: "profit-inventory-risks", component: ProfitInventoryRisksView, meta: { title: "库存利润风险", breadcrumb: ["财务中心", "利润分析", "库存利润风险"] } },
        { path: "profit/order-item-variances", name: "profit-order-item-variances", component: ProfitOrderItemVariancesView, meta: { title: "订单商品行差异", breadcrumb: ["财务中心", "利润分析", "订单商品行差异"] } },
        { path: "profit/pending-settlement-costs", name: "pending-settlement-costs", component: PendingSettlementCostsView, meta: { title: "待结算成本", breadcrumb: ["财务中心", "利润分析", "待结算成本"] } },
        { path: "profit/sku-ranking", redirect: "/profit/monthly-billing" },
        { path: "profit/shop-ranking", redirect: "/profit/monthly-billing" },
        { path: "advertising/daily", name: "advertising-daily", component: AdvertisingDailyView, meta: { title: "广告分析", breadcrumb: ["数据看板", "广告分析"] } },
        { path: "finance-center", name: "finance-center", component: FinanceCenterView, meta: { title: "财务中心", breadcrumb: ["财务中心"] } },
        { path: "finance/payroll", name: "finance-payroll", component: PayrollView, meta: { title: "员工工资", breadcrumb: ["财务中心", "员工工资"] } },
        { path: "orders", name: "orders", component: OrdersView, meta: { title: "订单列表", breadcrumb: ["订单履约", "订单列表"] } },
        { path: "order-tracking", name: "order-tracking", component: OrderTrackingView, meta: { title: "单量追踪", breadcrumb: ["订单履约", "单量追踪"] } },
        { path: "outbound", name: "outbound", component: OutboundView, meta: { title: "出库记录", breadcrumb: ["订单履约", "出库记录"] } },
        { path: "customer-messages", name: "customer-messages", component: CustomerMessagesView, meta: { title: "客户消息", breadcrumb: ["订单履约", "客户消息"] } },
        { path: "procurement", redirect: "/procurement/workspace" },
        { path: "procurement/workspace", name: "procurement-workspace", component: ProcurementWorkspaceView, meta: { title: "采购工作台", breadcrumb: ["采购", "采购工作台"] } },
        { path: "procurement/platform-orders", name: "procurement-platform-orders", component: ProcurementPlatformOrdersView, meta: { title: "平台订单", breadcrumb: ["采购", "平台订单"] } },
        { path: "procurement/reconciliation", name: "procurement-reconciliation", component: ProcurementReconciliationView, meta: { title: "采购对账", breadcrumb: ["采购", "采购对账"] } },
        { path: "purchase-list", name: "purchase-list", component: PurchaseListView, meta: { title: "待入库清单", breadcrumb: ["库存", "待入库清单"] } },
        { path: "purchase-history", name: "purchase-history", component: PurchaseHistoryView, meta: { title: "已入库", breadcrumb: ["采购入库", "入库记录"] } },
        { path: "purchase-cost-center", name: "purchase-cost-center", component: PurchaseCostCenterView, meta: { title: "成本与异常", breadcrumb: ["采购入库", "成本与异常"] } },
        { path: "inbound", redirect: "/purchase-list" },
        { path: "settings", name: "settings", redirect: to => ({ path: ({ profit: "/tools/packaging-fee-rule", logistics: "/logistics-settings", cancel: "/order-cancellation-rules", rates: "/dashboard" })[to.query.section || to.query.tab] || "/dashboard" }) },
        { path: "tools/packaging-fee-rule", name: "tools-packaging-fee-rule", component: PackagingFeeRuleView, meta: { title: "包装费规则", breadcrumb: ["实用工具", "包装费规则"] } },
        { path: "logistics-settings", name: "logistics-settings", component: SettingsView, props: { section: "logistics" }, meta: { title: "物流设置", breadcrumb: ["企业店铺", "物流设置"] } },
        { path: "order-cancellation-rules", name: "order-cancellation-rules", component: SettingsView, props: { section: "cancel" }, meta: { title: "取消规则", breadcrumb: ["平台管理", "取消规则"] } },
        { path: "settings/scheduled-jobs", name: "settings-scheduled-jobs", component: ScheduledJobsView, meta: { title: "自动任务", breadcrumb: ["系统管理", "自动任务"] } },
        { path: "settings/system-monitoring", name: "settings-system-monitoring", component: SystemMonitoringView, meta: { title: "系统监控", breadcrumb: ["系统管理", "系统监控"] } },
        { path: "settings/ai", name: "settings-ai", component: AiProviderSettingsView, meta: { title: "AI 设置", breadcrumb: ["系统管理", "AI 设置"] } },
        { path: "settings/materials", name: "settings-materials", redirect: "/ai-materials" },
        { path: "ai-materials", name: "ai-materials", component: MaterialCenterView, meta: { title: "AI素材", breadcrumb: ["AI技能库", "AI素材"] } },
        { path: "tenant-management", name: "tenant-management", component: TenantSubscriptionView, meta: { title: "企业与授权", breadcrumb: ["企业与授权"] } },
        { path: "tenant-shops", name: "tenant-shops", component: TenantShopsView, meta: { title: "企业店铺", breadcrumb: ["企业管理", "店铺管理"] } },
        { path: "tenant-people", name: "tenant-people", component: EnterprisePersonnelPanel, meta: { title: "企业人员", breadcrumb: ["企业管理", "企业人员"] } },
        { path: "platform-accounts", name: "platform-accounts", component: PlatformAccountsView, meta: { title: "平台人员", breadcrumb: ["平台管理", "平台人员"] } },
        { path: "settings/tenants", name: "settings-tenants", redirect: (to) => ({ path: "/tenant-management", query: to.query }) },
        { path: "settings/prompts", name: "settings-prompts", redirect: "/ai-prompts" },
        { path: "ai-prompts", name: "ai-prompts", component: AiPromptLibraryView, meta: { title: "AI提示词库", breadcrumb: ["AI技能库", "AI提示词库"] } },
        { path: "tools/product-video-generator", name: "tools-product-video-generator", component: ProductVideoGeneratorView, meta: { title: "商品视频", breadcrumb: ["实用工具", "商品视频"] } },
        { path: "tools/pricing", name: "tools-pricing", component: PricingToolView, meta: { title: "定价工具", breadcrumb: ["实用工具", "定价工具"] } },
        { path: "tools/profit-calculator", name: "tools-profit-calculator", component: ProfitCalculatorView, meta: { title: "利润计算器", breadcrumb: ["实用工具", "利润计算器"] } },
        { path: "tools/image-cropper", name: "tools-image-cropper", component: EcommerceImageSplitterView, meta: { title: "图片自动裁切工具", breadcrumb: ["实用工具", "图片自动裁切工具"] } },
        { path: "tools/ecommerce-image-splitter", name: "tools-ecommerce-image-splitter", component: EcommerceImageSplitterView, meta: { title: "套图拆分", breadcrumb: ["实用工具", "套图拆分"] } },
        { path: ":pathMatch(.*)*", redirect: "/dashboard" }
      ]
    }
  ]
});

export function prefetchRouteComponent(target) {
  const resolved = router.resolve(target);
  const loaders = [];
  for (const record of resolved.matched || []) {
    for (const component of Object.values(record.components || {})) {
      if (typeof component === "function") loaders.push(component);
    }
  }
  return Promise.allSettled(loaders.map((loader) => loader())).catch(() => {});
}

function safeRedirectTarget(target = "/dashboard") {
  const value = String(target || "/dashboard").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/dashboard";
  return value;
}


router.beforeEach(async (to, from) => {
  startRoutePerf(to);
  document.title = to.meta?.title ? `${to.meta.title} - 爆单ERP` : "爆单ERP";
  const auth = useAuthStore();
  const home = () => isPlatformAdmin(auth.user) && !auth.user?.tenant?.id ? "/platform-accounts"
    : needsMembershipActivation(auth.user) ? "/tools/profit-calculator" : "/dashboard";
  if (to.name === "login") {
    await auth.bootstrap();
    if (auth.isAuthenticated) {
      const target = safeRedirectTarget(to.query.redirect || home());
      return canAccessPage(auth.user, target.split("?")[0]) ? target : home();
    }
    return true;
  }
  if (!to.meta?.public) {
    await auth.bootstrap();
    if (!auth.isAuthenticated) return { name: "login", query: { redirect: to.fullPath } };
    if (to.path === "/membership" && canAccessPage(auth.user, to.path)) {
      requestMembershipDialog();
      if (from?.matched?.length && !from.meta?.public && !from.meta?.mobile && from.path !== "/membership" && canAccessPage(auth.user, from.path)) {
        document.title = from.meta?.title ? `${from.meta.title} - 爆单ERP` : "爆单ERP";
        return false;
      }
      return { path: home(), replace: true };
    }
    if (!canAccessPage(auth.user, to.path)) {
      if (needsMembershipActivation(auth.user)) requestMembershipDialog();
      return { path: home(), query: { denied: needsMembershipActivation(auth.user) ? "activation" : "permission" } };
    }
  }
  if (!to.meta?.mobile && !membershipDialogRequest.value && !needsMembershipActivation(auth.user) && auth.user?.tenant?.id && isMobileBrowser() && !prefersDesktopMode() && hasPermission(auth.user, "orders.read")) {
    return {
      path: "/mobile/orders",
      query: {
        ...(to.name === "orders" ? to.query : {}),
        desktopTarget: to.fullPath
      }
    };
  }
  return true;
});

router.afterEach((to) => {
  markRouteReadyPerf(to);
});

import { createRouter, createWebHashHistory } from "vue-router";
import AdminLayout from "../layouts/AdminLayout.vue";
import LoginView from "../views/LoginView.vue";
import { useAuthStore } from "../stores/auth";

const DashboardView = () => import("../views/DashboardView.vue");
const ProfitExceptionView = () => import("../views/exceptions/ProfitExceptionView.vue");
const DeadlineExceptionView = () => import("../views/exceptions/DeadlineExceptionView.vue");
const DeadlineWarningExceptionView = () => import("../views/exceptions/DeadlineWarningExceptionView.vue");
const StockExceptionView = () => import("../views/exceptions/StockExceptionView.vue");
const BindingExceptionView = () => import("../views/exceptions/BindingExceptionView.vue");
const InventoryView = () => import("../views/inventory/InventoryView.vue");
const InventoryProductsPage = () => import("../views/inventory/InventoryProductsPage.vue");
const InventoryFbpPage = () => import("../views/inventory/InventoryFbpPage.vue");
const InventoryFbpOpportunitiesPage = () => import("../views/inventory/InventoryFbpOpportunitiesPage.vue");
const InventoryHiddenPage = () => import("../views/inventory/InventoryHiddenPage.vue");
const InventoryMappingsPage = () => import("../views/inventory/InventoryMappingsPage.vue");
const InventorySuppliersPage = () => import("../views/inventory/InventorySuppliersPage.vue");
const InventoryAlertsPage = () => import("../views/inventory/InventoryAlertsPage.vue");
const OnlineProductsView = () => import("../views/inventory/OnlineProductsView.vue");
const ListingAutomationView = () => import("../views/listing/ListingAutomationView.vue");
const ListingPublishRecordsView = () => import("../views/listing/ListingPublishRecordsView.vue");
const CollectorBoxView = () => import("../views/listing/CollectorBoxView.vue");
const AssetVariantCenterView = () => import("../views/settings/PromptLibraryView.vue");
const ShopAssetVariantCenterView = () => import("../views/listing/ShopAssetVariantCenter.vue");
const SelectionView = () => import("../views/selection/SelectionView.vue");
const ProfitDashboardView = () => import("../views/profit/ProfitDashboardView.vue");
const ProfitAftersalesView = () => import("../views/profit/ProfitAftersalesView.vue");
const AdvertisingDailyView = () => import("../views/advertising/AdvertisingDailyView.vue");
const ReviewCenterView = () => import("../views/reviews/ReviewCenterView.vue");
const OzonActionsView = () => import("../views/marketing/OzonActionsView.vue");
const OrdersView = () => import("../views/orders/OrdersView.vue");
const OutboundView = () => import("../views/orders/OutboundView.vue");
const CustomerMessagesView = () => import("../views/orders/CustomerMessagesView.vue");
const ProcurementView = () => import("../views/procurement/ProcurementView.vue");
const PurchaseListView = () => import("../views/procurement/PurchaseListView.vue");
const PurchaseHistoryView = () => import("../views/procurement/PurchaseHistoryView.vue");
const SettingsView = () => import("../views/settings/SettingsView.vue");
const AiProviderSettingsView = () => import("../views/settings/AiProviderSettingsView.vue");
const MaterialCenterView = () => import("../views/settings/MaterialCenterView.vue");
const ScheduledJobsView = () => import("../views/settings/ScheduledJobsView.vue");
const ImageCropperView = () => import("../views/tools/ImageCropper.vue");
const EcommerceImageSplitterView = () => import("../views/tools/EcommerceImageSplitterV3.vue");
const ProductVideoGeneratorView = () => import("../views/tools/ProductVideoGenerator.vue");

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true, title: "登录" } },
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "dashboard", name: "dashboard", component: DashboardView, meta: { title: "经营首页", breadcrumb: ["经营首页"] } },
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
            { path: "products", name: "inventory-products", component: InventoryProductsPage, meta: { title: "商品库存", breadcrumb: ["库存中心", "商品库存"] } },
            { path: "fbp", name: "inventory-fbp", component: InventoryFbpPage, meta: { title: "FBP 库存", breadcrumb: ["库存中心", "FBP 库存"] } },
            { path: "fbp-opportunities", name: "inventory-fbp-opportunities", component: InventoryFbpOpportunitiesPage, meta: { title: "备货建议", breadcrumb: ["库存中心", "备货建议"] } },
            { path: "hidden", name: "inventory-hidden", component: InventoryHiddenPage, meta: { title: "已删除商品", breadcrumb: ["库存中心", "已删除商品"] } },
            { path: "mappings", name: "inventory-mappings", component: InventoryMappingsPage, meta: { title: "SKU 绑定", breadcrumb: ["库存中心", "SKU 绑定"] } },
            { path: "suppliers", name: "inventory-suppliers", component: InventorySuppliersPage, meta: { title: "供应商", breadcrumb: ["库存中心", "供应商"] } },
            { path: "alerts", name: "inventory-alerts", component: InventoryAlertsPage, meta: { title: "库存预警", breadcrumb: ["库存中心", "库存预警"] } }
          ]
        },
        { path: "online-products", name: "online-products", component: OnlineProductsView, meta: { title: "在线商品", breadcrumb: ["商品运营", "在线商品"] } },
        { path: "asset-variant-center", name: "asset-variant-center", component: ShopAssetVariantCenterView, meta: { title: "多店铺商品", breadcrumb: ["商品运营", "多店铺商品"] } },
        { path: "asset-variant-center/create", name: "asset-variant-center-create", component: AssetVariantCenterView, meta: { title: "AI 素材优化", breadcrumb: ["商品运营", "AI 素材优化"] } },
        { path: "listing-automation", name: "listing-automation", component: ListingAutomationView, meta: { title: "商品上架", breadcrumb: ["商品运营", "商品上架"], tabKey: "fullPath" } },
        { path: "collector-box", name: "collector-box", component: CollectorBoxView, meta: { title: "采集箱", breadcrumb: ["商品运营", "采集箱"] } },
        { path: "listing-records", name: "listing-records", component: ListingPublishRecordsView, meta: { title: "上架记录", breadcrumb: ["商品运营", "上架记录"] } },
        { path: "ozon-actions", name: "ozon-actions", component: OzonActionsView, meta: { title: "Ozon 活动", breadcrumb: ["数据看板", "Ozon 活动"] } },
        { path: "selection", name: "selection", component: SelectionView, meta: { title: "选品池", breadcrumb: ["商品运营", "选品池"] } },
        { path: "profit", name: "profit", component: ProfitDashboardView, meta: { title: "利润分析", breadcrumb: ["数据看板", "利润分析"] } },
        { path: "profit/aftersales", name: "profit-aftersales", component: ProfitAftersalesView, meta: { title: "售后损益", breadcrumb: ["数据看板", "利润分析", "售后损益"] } },
        { path: "profit/sku-ranking", name: "profit-sku-ranking", component: ProfitDashboardView, meta: { title: "SKU 排行榜", breadcrumb: ["数据看板", "利润分析", "SKU 排行榜"] } },
        { path: "profit/shop-ranking", name: "profit-shop-ranking", component: ProfitDashboardView, meta: { title: "店铺排行榜", breadcrumb: ["数据看板", "利润分析", "店铺排行榜"] } },
        { path: "advertising/daily", name: "advertising-daily", component: AdvertisingDailyView, meta: { title: "广告分析", breadcrumb: ["数据看板", "广告分析"] } },
        { path: "reviews", name: "reviews", component: ReviewCenterView, meta: { title: "买家评价", breadcrumb: ["数据看板", "买家评价"] } },
        { path: "orders", name: "orders", component: OrdersView, meta: { title: "订单列表", breadcrumb: ["订单履约", "订单列表"] } },
        { path: "outbound", name: "outbound", component: OutboundView, meta: { title: "出库记录", breadcrumb: ["订单履约", "出库记录"] } },
        { path: "customer-messages", name: "customer-messages", component: CustomerMessagesView, meta: { title: "客户消息", breadcrumb: ["订单履约", "客户消息"] } },
        { path: "procurement", name: "procurement", component: ProcurementView, meta: { title: "采购需求", breadcrumb: ["采购入库", "采购需求"] } },
        { path: "purchase-list", name: "purchase-list", component: PurchaseListView, meta: { title: "待采购清单", breadcrumb: ["采购入库", "待采购清单"] } },
        { path: "purchase-history", name: "purchase-history", component: PurchaseHistoryView, meta: { title: "采购记录", breadcrumb: ["采购入库", "采购记录"] } },
        { path: "inbound", redirect: "/purchase-list" },
        { path: "settings", name: "settings", component: SettingsView, meta: { title: "基础资料", breadcrumb: ["系统管理", "基础资料"] } },
        { path: "settings/scheduled-jobs", name: "settings-scheduled-jobs", component: ScheduledJobsView, meta: { title: "自动任务", breadcrumb: ["系统管理", "自动任务"] } },
        { path: "settings/ai", name: "settings-ai", component: AiProviderSettingsView, meta: { title: "AI 设置", breadcrumb: ["系统管理", "AI 设置"] } },
        { path: "settings/materials", name: "settings-materials", component: MaterialCenterView, meta: { title: "素材库", breadcrumb: ["系统管理", "素材库"] } },
        { path: "tools/product-video-generator", name: "tools-product-video-generator", component: ProductVideoGeneratorView, meta: { title: "商品视频", breadcrumb: ["实用工具", "商品视频"] } },
        { path: "tools/image-cropper", name: "tools-image-cropper", component: EcommerceImageSplitterView, meta: { title: "图片自动裁切工具", breadcrumb: ["实用工具", "图片自动裁切工具"] } },
        { path: "tools/ecommerce-image-splitter", name: "tools-ecommerce-image-splitter", component: EcommerceImageSplitterView, meta: { title: "套图拆分", breadcrumb: ["实用工具", "套图拆分"] } },
        { path: "settings/prompts", redirect: "/asset-variant-center/create" },
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

router.beforeEach(async (to) => {
  document.title = to.meta?.title ? `${to.meta.title} - 爆单ERP` : "爆单ERP";
  const auth = useAuthStore();
  if (to.name === "login") {
    await auth.bootstrap();
    if (auth.isAuthenticated) return String(to.query.redirect || "/dashboard").split("?")[0];
    return true;
  }
  if (!to.meta?.public) {
    await auth.bootstrap();
    if (!auth.isAuthenticated) return { name: "login", query: { redirect: to.fullPath } };
  }
  return true;
});

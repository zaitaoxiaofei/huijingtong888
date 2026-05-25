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
const InventoryHiddenPage = () => import("../views/inventory/InventoryHiddenPage.vue");
const InventoryMappingsPage = () => import("../views/inventory/InventoryMappingsPage.vue");
const InventorySuppliersPage = () => import("../views/inventory/InventorySuppliersPage.vue");
const InventoryAlertsPage = () => import("../views/inventory/InventoryAlertsPage.vue");
const OnlineProductsView = () => import("../views/inventory/OnlineProductsView.vue");
const ListingAutomationView = () => import("../views/listing/ListingAutomationView.vue");
const MultiShopPublishView = () => import("../views/listing/MultiShopPublish.vue");
const AssetVariantCenterView = () => import("../views/listing/AssetVariantCenter.vue");
const SelectionView = () => import("../views/selection/SelectionView.vue");
const ProfitDashboardView = () => import("../views/profit/ProfitDashboardView.vue");
const ProfitAftersalesView = () => import("../views/profit/ProfitAftersalesView.vue");
const AdvertisingDailyView = () => import("../views/advertising/AdvertisingDailyView.vue");
const OrdersView = () => import("../views/orders/OrdersView.vue");
const OutboundView = () => import("../views/orders/OutboundView.vue");
const ProcurementView = () => import("../views/procurement/ProcurementView.vue");
const PurchaseListView = () => import("../views/procurement/PurchaseListView.vue");
const PurchaseHistoryView = () => import("../views/procurement/PurchaseHistoryView.vue");
const SettingsView = () => import("../views/settings/SettingsView.vue");
const AiProviderSettingsView = () => import("../views/settings/AiProviderSettingsView.vue");
const AiImageGeneratorView = () => import("../views/tools/AiImageGenerator.vue");
const ImageCropperView = () => import("../views/tools/ImageCropper.vue");
const EcommerceImageSplitterView = () => import("../views/tools/EcommerceImageSplitterV3.vue");
const ProductVideoGeneratorView = () => import("../views/tools/ProductVideoGenerator.vue");

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: LoginView,
      meta: { public: true, title: "登录" }
    },
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "dashboard", name: "dashboard", component: DashboardView, meta: { title: "首页看板", breadcrumb: ["首页看板"] } },
        { path: "exceptions", redirect: "/exceptions/profit", meta: { title: "异常工作台", breadcrumb: ["经营分析", "异常工作台"] } },
        { path: "exceptions/profit", name: "exceptions-profit", component: ProfitExceptionView, meta: { title: "利润异常", breadcrumb: ["经营分析", "异常工作台", "利润异常"] } },
        { path: "exceptions/deadline", name: "exceptions-deadline", component: DeadlineExceptionView, meta: { title: "订单超时异常", breadcrumb: ["经营分析", "异常工作台", "订单超时异常"] } },
        { path: "exceptions/deadline-warning", name: "exceptions-deadline-warning", component: DeadlineWarningExceptionView, meta: { title: "超时预警", breadcrumb: ["经营分析", "异常工作台", "超时预警"] } },
        { path: "exceptions/stock", name: "exceptions-stock", component: StockExceptionView, meta: { title: "库存异常", breadcrumb: ["经营分析", "异常工作台", "库存异常"] } },
        { path: "exceptions/binding", name: "exceptions-binding", component: BindingExceptionView, meta: { title: "未绑定仓库", breadcrumb: ["经营分析", "异常工作台", "未绑定仓库"] } },
        {
          path: "inventory",
          name: "inventory",
          component: InventoryView,
          meta: { title: "库存管理", breadcrumb: ["库存管理"] },
          children: [
            { path: "", redirect: "/inventory/products" },
            { path: "products", name: "inventory-products", component: InventoryProductsPage, meta: { title: "产品库存表", breadcrumb: ["库存管理", "产品库存表"] } },
            { path: "fbp", name: "inventory-fbp", component: InventoryFbpPage, meta: { title: "FBP 库存表", breadcrumb: ["库存管理", "FBP 库存表"] } },
            { path: "hidden", name: "inventory-hidden", component: InventoryHiddenPage, meta: { title: "已隐藏产品", breadcrumb: ["库存管理", "已隐藏产品"] } },
            { path: "mappings", name: "inventory-mappings", component: InventoryMappingsPage, meta: { title: "库存-SKU映射表", breadcrumb: ["库存管理", "库存-SKU映射表"] } },
            { path: "suppliers", name: "inventory-suppliers", component: InventorySuppliersPage, meta: { title: "供应商配置", breadcrumb: ["库存管理", "供应商配置"] } },
            { path: "alerts", name: "inventory-alerts", component: InventoryAlertsPage, meta: { title: "库存预警", breadcrumb: ["库存管理", "库存预警"] } }
          ]
        },
        { path: "online-products", name: "online-products", component: OnlineProductsView, meta: { title: "在线商品", breadcrumb: ["商品管理", "在线商品"] } },
        { path: "asset-variant-center", name: "asset-variant-center", component: AssetVariantCenterView, meta: { title: "素材裂变中心", breadcrumb: ["工具中心", "素材裂变中心"] } },
        { path: "listing-automation", name: "listing-automation", component: ListingAutomationView, meta: { title: "多店铺上架自动化", breadcrumb: ["工具中心", "多店铺上架自动化"] } },
        { path: "multi-shop-publish", name: "multi-shop-publish", component: MultiShopPublishView, meta: { title: "多店铺商品发布中台", breadcrumb: ["商品管理", "多店铺商品发布中台"] } },
        { path: "selection", name: "selection", component: SelectionView, meta: { title: "选品计价表", breadcrumb: ["工具中心", "选品计价表"] } },
        { path: "profit", name: "profit", component: ProfitDashboardView, meta: { title: "利润看板", breadcrumb: ["经营分析", "利润看板"] } },
        { path: "profit/aftersales", name: "profit-aftersales", component: ProfitAftersalesView, meta: { title: "售后损失", breadcrumb: ["经营分析", "利润看板", "售后损失"] } },
        { path: "profit/sku-ranking", name: "profit-sku-ranking", component: ProfitDashboardView, meta: { title: "SKU 排行榜", breadcrumb: ["经营分析", "利润看板", "SKU 排行榜"] } },
        { path: "profit/shop-ranking", name: "profit-shop-ranking", component: ProfitDashboardView, meta: { title: "店铺排行榜", breadcrumb: ["经营分析", "利润看板", "店铺排行榜"] } },
        { path: "advertising/daily", name: "advertising-daily", component: AdvertisingDailyView, meta: { title: "广告系统", breadcrumb: ["经营分析", "广告系统"] } },
        { path: "orders", name: "orders", component: OrdersView, meta: { title: "订单中心", breadcrumb: ["订单中心", "订单列表"] } },
        { path: "outbound", name: "outbound", component: OutboundView, meta: { title: "出库记录", breadcrumb: ["订单中心", "出库记录"] } },
        { path: "procurement", name: "procurement", component: ProcurementView, meta: { title: "采购请求", breadcrumb: ["采购管理", "采购请求"] } },
        { path: "purchase-list", name: "purchase-list", component: PurchaseListView, meta: { title: "采购清单", breadcrumb: ["采购管理", "采购清单"] } },
        { path: "purchase-history", name: "purchase-history", component: PurchaseHistoryView, meta: { title: "采购历史", breadcrumb: ["采购管理", "采购历史"] } },
        { path: "inbound", redirect: "/purchase-list" },
        { path: "settings", name: "settings", component: SettingsView, meta: { title: "系统设置", breadcrumb: ["系统设置", "配置中心"] } },
        { path: "settings/ai", name: "settings-ai", component: AiProviderSettingsView, meta: { title: "AI 配置", breadcrumb: ["系统设置", "AI 配置"] } },
        { path: "tools/ai-image-generator", name: "tools-ai-image-generator", component: AiImageGeneratorView, meta: { title: "AI 套图生成中心", breadcrumb: ["工具中心", "AI 套图生成中心"] } },
        { path: "tools/product-video-generator", name: "tools-product-video-generator", component: ProductVideoGeneratorView, meta: { title: "一键生成视频", breadcrumb: ["工具中心", "一键生成视频"] } },
        { path: "tools/image-cropper", name: "tools-image-cropper", component: EcommerceImageSplitterView, meta: { title: "图片自动裁切工具", breadcrumb: ["工具中心", "图片自动裁切工具"] } },
        { path: "tools/ecommerce-image-splitter", name: "tools-ecommerce-image-splitter", component: EcommerceImageSplitterView, meta: { title: "电商套图拆分器", breadcrumb: ["工具中心", "电商套图拆分器"] } },
        { path: ":pathMatch(.*)*", redirect: "/dashboard" }
      ]
    }
  ]
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  if (!authStore.bootstrapped) {
    await authStore.bootstrap();
  }

  if (to.meta.public) {
    if (authStore.isAuthenticated && to.path === "/login") return "/dashboard";
    return true;
  }

  if (!authStore.isAuthenticated) {
    return `/login?redirect=${encodeURIComponent(to.fullPath)}`;
  }

  return true;
});


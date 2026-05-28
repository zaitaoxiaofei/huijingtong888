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
const ListingPublishRecordsView = () => import("../views/listing/ListingPublishRecordsView.vue");
const MultiShopPublishView = () => import("../views/listing/MultiShopPublish.vue");
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
const ProcurementView = () => import("../views/procurement/ProcurementView.vue");
const PurchaseListView = () => import("../views/procurement/PurchaseListView.vue");
const PurchaseHistoryView = () => import("../views/procurement/PurchaseHistoryView.vue");
const SettingsView = () => import("../views/settings/SettingsView.vue");
const AiProviderSettingsView = () => import("../views/settings/AiProviderSettingsView.vue");
const MaterialCenterView = () => import("../views/settings/MaterialCenterView.vue");
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
            { path: "products", name: "inventory-products", component: InventoryProductsPage, meta: { title: "本地库存", breadcrumb: ["库存管理", "本地库存"] } },
            { path: "fbp", name: "inventory-fbp", component: InventoryFbpPage, meta: { title: "Ozon FBP库存", breadcrumb: ["库存管理", "Ozon FBP库存"] } },
            { path: "hidden", name: "inventory-hidden", component: InventoryHiddenPage, meta: { title: "隐藏商品", breadcrumb: ["库存管理", "隐藏商品"] } },
            { path: "mappings", name: "inventory-mappings", component: InventoryMappingsPage, meta: { title: "SKU库存映射", breadcrumb: ["库存管理", "SKU库存映射"] } },
            { path: "suppliers", name: "inventory-suppliers", component: InventorySuppliersPage, meta: { title: "供应商", breadcrumb: ["库存管理", "供应商"] } },
            { path: "alerts", name: "inventory-alerts", component: InventoryAlertsPage, meta: { title: "库存预警", breadcrumb: ["库存管理", "库存预警"] } }
          ]
        },
        { path: "online-products", name: "online-products", component: OnlineProductsView, meta: { title: "在线商品", breadcrumb: ["商品中心", "在线商品"] } },
        { path: "asset-variant-center", name: "asset-variant-center", component: ShopAssetVariantCenterView, meta: { title: "店铺矩阵列表", breadcrumb: ["商品中心", "店铺矩阵列表"] } },
        { path: "asset-variant-center/create", name: "asset-variant-center-create", component: AssetVariantCenterView, meta: { title: "AI内容优化", breadcrumb: ["商品中心", "AI内容优化"] } },
        { path: "listing-automation", name: "listing-automation", component: ListingAutomationView, meta: { title: "编辑上架", breadcrumb: ["商品中心", "编辑上架"] } },
        { path: "listing-records", name: "listing-records", component: ListingPublishRecordsView, meta: { title: "上架记录", breadcrumb: ["商品中心", "上架记录"] } },
        { path: "multi-shop-publish", name: "multi-shop-publish", component: MultiShopPublishView, meta: { title: "多店铺发布", breadcrumb: ["商品中心", "多店铺发布"] } },
        { path: "ozon-actions", name: "ozon-actions", component: OzonActionsView, meta: { title: "活动管理", breadcrumb: ["商品中心", "活动管理"] } },
        { path: "selection", name: "selection", component: SelectionView, meta: { title: "选品上架", breadcrumb: ["商品中心", "选品上架"] } },
        { path: "profit", name: "profit", component: ProfitDashboardView, meta: { title: "利润看板", breadcrumb: ["经营分析", "利润看板"] } },
        { path: "profit/aftersales", name: "profit-aftersales", component: ProfitAftersalesView, meta: { title: "售后损益", breadcrumb: ["经营分析", "利润看板", "售后损益"] } },
        { path: "profit/sku-ranking", name: "profit-sku-ranking", component: ProfitDashboardView, meta: { title: "SKU 排行榜", breadcrumb: ["经营分析", "利润看板", "SKU 排行榜"] } },
        { path: "profit/shop-ranking", name: "profit-shop-ranking", component: ProfitDashboardView, meta: { title: "店铺排行榜", breadcrumb: ["经营分析", "利润看板", "店铺排行榜"] } },
        { path: "advertising/daily", name: "advertising-daily", component: AdvertisingDailyView, meta: { title: "广告数据", breadcrumb: ["经营分析", "广告数据"] } },
        { path: "reviews", name: "reviews", component: ReviewCenterView, meta: { title: "评价中心", breadcrumb: ["经营分析", "评价中心"] } },
        { path: "orders", name: "orders", component: OrdersView, meta: { title: "Ozon订单", breadcrumb: ["订单中心", "Ozon订单"] } },
        { path: "outbound", name: "outbound", component: OutboundView, meta: { title: "出库记录", breadcrumb: ["订单中心", "出库记录"] } },
        { path: "procurement", name: "procurement", component: ProcurementView, meta: { title: "采购需求", breadcrumb: ["采购管理", "采购需求"] } },
        { path: "purchase-list", name: "purchase-list", component: PurchaseListView, meta: { title: "采购清单", breadcrumb: ["采购管理", "采购清单"] } },
        { path: "purchase-history", name: "purchase-history", component: PurchaseHistoryView, meta: { title: "采购历史", breadcrumb: ["采购管理", "采购历史"] } },
        { path: "inbound", redirect: "/purchase-list" },
        { path: "settings", name: "settings", component: SettingsView, meta: { title: "系统设置", breadcrumb: ["系统设置", "配置中心"] } },
        { path: "settings/ai", name: "settings-ai", component: AiProviderSettingsView, meta: { title: "AI 配置", breadcrumb: ["系统设置", "AI 配置"] } },
        { path: "settings/materials", name: "settings-materials", component: MaterialCenterView, meta: { title: "素材中心", breadcrumb: ["系统设置", "素材中心"] } },
        { path: "tools/product-video-generator", name: "tools-product-video-generator", component: ProductVideoGeneratorView, meta: { title: "视频生成", breadcrumb: ["工具中心", "视频生成"] } },
        { path: "tools/image-cropper", name: "tools-image-cropper", component: EcommerceImageSplitterView, meta: { title: "图片自动裁切工具", breadcrumb: ["工具中心", "图片自动裁切工具"] } },
        { path: "tools/ecommerce-image-splitter", name: "tools-ecommerce-image-splitter", component: EcommerceImageSplitterView, meta: { title: "套图拆分", breadcrumb: ["工具中心", "套图拆分"] } },
        { path: "settings/prompts", redirect: "/asset-variant-center/create" },
        { path: ":pathMatch(.*)*", redirect: "/dashboard" }
      ]
    }
  ]
});

router.beforeEach(async (to) => {
  document.title = to.meta?.title ? `${to.meta.title} - Ozon ERP` : "Ozon ERP";
  const auth = useAuthStore();
  if (!to.meta?.public) {
    await auth.bootstrap();
    if (!auth.isAuthenticated) return { name: "login", query: { redirect: to.fullPath } };
  }
  return true;
});

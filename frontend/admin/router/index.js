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
const SelectionView = () => import("../views/selection/SelectionView.vue");
const ProfitDashboardView = () => import("../views/profit/ProfitDashboardView.vue");
const ProfitRankingView = () => import("../views/profit/ProfitRankingView.vue");
const OrdersView = () => import("../views/orders/OrdersView.vue");
const OutboundView = () => import("../views/orders/OutboundView.vue");
const ProcurementView = () => import("../views/procurement/ProcurementView.vue");
const PurchaseListView = () => import("../views/procurement/PurchaseListView.vue");
const PurchaseHistoryView = () => import("../views/procurement/PurchaseHistoryView.vue");
const InboundView = () => import("../views/procurement/InboundView.vue");
const SettingsView = () => import("../views/settings/SettingsView.vue");

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
        {
          path: "dashboard",
          name: "dashboard",
          component: DashboardView,
          meta: { title: "首页看板", breadcrumb: ["首页看板"] }
        },
        { path: "exceptions", redirect: "/exceptions/profit", meta: { title: "异常工作台", breadcrumb: ["经营分析", "异常工作台"] } },
        { path: "exceptions/profit", name: "exceptions-profit", component: ProfitExceptionView, meta: { title: "利润异常", breadcrumb: ["经营分析", "异常工作台", "利润异常"] } },
        { path: "exceptions/deadline", name: "exceptions-deadline", component: DeadlineExceptionView, meta: { title: "订单超时异常", breadcrumb: ["经营分析", "异常工作台", "订单超时异常"] } },
        { path: "exceptions/deadline-warning", name: "exceptions-deadline-warning", component: DeadlineWarningExceptionView, meta: { title: "超时预警", breadcrumb: ["经营分析", "异常工作台", "超时预警"] } },
        { path: "exceptions/stock", name: "exceptions-stock", component: StockExceptionView, meta: { title: "库存异常", breadcrumb: ["经营分析", "异常工作台", "库存异常"] } },
        { path: "exceptions/binding", name: "exceptions-binding", component: BindingExceptionView, meta: { title: "未绑定库存", breadcrumb: ["经营分析", "异常工作台", "未绑定库存"] } },
        {
          path: "inventory",
          name: "inventory",
          component: InventoryView,
          meta: { title: "库存管理", breadcrumb: ["库存管理"] },
          children: [
            { path: "", redirect: "/inventory/products" },
            {
              path: "products",
              name: "inventory-products",
              component: InventoryProductsPage,
              meta: { title: "产品库存表", breadcrumb: ["库存管理", "产品库存表"] }
            },
            {
              path: "fbp",
              name: "inventory-fbp",
              component: InventoryFbpPage,
              meta: { title: "FBP 库存表", breadcrumb: ["库存管理", "FBP 库存表"] }
            },
            {
              path: "hidden",
              name: "inventory-hidden",
              component: InventoryHiddenPage,
              meta: { title: "已隐藏产品", breadcrumb: ["库存管理", "已隐藏产品"] }
            },
            {
              path: "mappings",
              name: "inventory-mappings",
              component: InventoryMappingsPage,
              meta: { title: "SKU 绑定配置", breadcrumb: ["库存管理", "SKU 绑定配置"] }
            },
            {
              path: "suppliers",
              name: "inventory-suppliers",
              component: InventorySuppliersPage,
              meta: { title: "供应商配置", breadcrumb: ["库存管理", "供应商配置"] }
            },
            {
              path: "alerts",
              name: "inventory-alerts",
              component: InventoryAlertsPage,
              meta: { title: "库存预警", breadcrumb: ["库存管理", "库存预警"] }
            }
          ]
        },
        {
          path: "online-products",
          name: "online-products",
          component: OnlineProductsView,
          meta: { title: "在线商品", breadcrumb: ["商品管理", "在线商品"] }
        },
        {
          path: "selection",
          name: "selection",
          component: SelectionView,
          meta: { title: "选品中心", breadcrumb: ["商品管理", "选品中心"] }
        },
        {
          path: "profit",
          name: "profit",
          component: ProfitDashboardView,
          meta: { title: "利润看板", breadcrumb: ["经营分析", "利润看板"] }
        },
        {
          path: "profit/sku-ranking",
          name: "profit-sku-ranking",
          component: ProfitRankingView,
          props: { dimension: "sku" },
          meta: { title: "SKU 排行榜", breadcrumb: ["经营分析", "SKU 排行榜"] }
        },
        {
          path: "profit/shop-ranking",
          name: "profit-shop-ranking",
          component: ProfitRankingView,
          props: { dimension: "shop" },
          meta: { title: "店铺排行榜", breadcrumb: ["经营分析", "店铺排行榜"] }
        },
        {
          path: "orders",
          name: "orders",
          component: OrdersView,
          meta: { title: "订单中心", breadcrumb: ["订单中心", "订单列表"] }
        },
        {
          path: "outbound",
          name: "outbound",
          component: OutboundView,
          meta: { title: "出库记录", breadcrumb: ["订单中心", "出库记录"] }
        },
        {
          path: "procurement",
          name: "procurement",
          component: ProcurementView,
          meta: { title: "采购请求", breadcrumb: ["采购管理", "采购请求"] }
        },
        {
          path: "purchase-list",
          name: "purchase-list",
          component: PurchaseListView,
          meta: { title: "采购清单", breadcrumb: ["采购管理", "采购清单"] }
        },
        {
          path: "purchase-history",
          name: "purchase-history",
          component: PurchaseHistoryView,
          meta: { title: "采购历史", breadcrumb: ["采购管理", "采购历史"] }
        },
        {
          path: "inbound",
          name: "inbound",
          component: InboundView,
          meta: { title: "入库管理", breadcrumb: ["采购管理", "入库管理"] }
        },
        {
          path: "settings",
          name: "settings",
          component: SettingsView,
          meta: { title: "系统设置", breadcrumb: ["系统设置", "配置中心"] }
        },
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

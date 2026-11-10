# 官网产品展示素材

`public/website/erp-dashboard-demo.png` 为本地渲染系统真实组件的截图，不是另画的产品界面。

- 来源：`frontend/admin/views/DashboardView.vue`，包含原有 `DashboardInventoryRanking.vue` 和 `DailyExchangeRateCard.vue`。
- 样式：组件原有样式及后台 `index.css`、`erp-theme.css`，未为截图重画卡片或调整产品样式。
- 数据：`test/fixtures/self-service-commerce-preview.mjs` 的本地演示接口；金额、店铺、商品均为演示值，无生产数据。
- 拍摄：本地 8788 的 `/admin.html#/product-preview`，2400 × 1120 视口，截取 `.operating-card` 经营区域。排除浏览器扩展浮层、测试外壳和模拟付款按钮。
- 图片：2305 × 954，官网标注“系统真实界面 · 演示数据”，可点击放大。

以后更新此素材时，继续从实际组件截图。可以更换演示数据，不另造导航、指标卡片或产品界面。该本地演示路由不属于生产路由。

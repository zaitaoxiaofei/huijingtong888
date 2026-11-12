# 平台官方头像

所有页面通过 `frontend/admin/components/MarketplaceBadge.vue` 使用此处唯一素材，仅通过 `size` 调整尺寸。不要在页面重画字母徽标、改变品牌颜色或单独保存其他版本。未知平台保留“待识别”文字，不自动显示 Ozon。

- `ozon.png`：Ozon 官方 Brandlab 图标包 RGB 原件的 PNG 导出，513×512。品牌指南：https://brandlab.ozon.ru/en/guide/icon_guide 。原始包：https://cdn.ozone.ru/s3/ozon-disk-api/Brand_Ozon/Design_Team/Web_Design/Guides_Files/Icon_Ozon_vector_1730446339.zip 。使用包内 `Icon_Ozon_vector/RGB/icon_rgb.pdf`，完整页面等比渲染，不重画、不改色。
- `wb.png`：Wildberries 官网原始 Apple Touch 图标，192×192，未改变内容：https://www.wildberries.ru/apple-touch-icon.png 。不是 WB API 开发者站点的绿色 API 图标。

素材在构建时通过 Vite 导入，形成共享的内容哈希 URL，明暗主题不反色。平台切换、导航、订单、商品、店铺和库存用量复用同一组件；图像保留可访问名称。

# Ozon ERP

当前系统已经统一切换到 `Vue 3 + Element Plus` 后台架构。旧版静态页面和旧版挂载入口不再作为运行时的一部分维护。

## 当前入口

- 后端入口: [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- 静态分发: [src/http/static.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/static.js)
- 前端宿主页: [public/admin.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/admin.html)
- Vue 管理端源码: [frontend/admin](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin)

说明:

- `/` 和 `/index.html` 现在都进入新的管理端。
- 新系统只维护当前 Vue 页面，不再渲染旧版利润页、异常页、采购旧页面等历史页面。
- `public/vue-apps/` 是当前前端构建产物目录。

## 技术栈

- Node.js
- SQLite
- Vue 3
- Element Plus
- Vite

## 启动

```powershell
npm start
```

开发模式:

```powershell
npm run dev
```

前端构建:

```powershell
npm run build:frontend
```

## 主要业务模块

- 经营分析
- 选品中心
- 订单中心
- 库存管理
- 采购管理
- 系统设置

## 文档入口

- [docs/PROJECT_GUIDE.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/PROJECT_GUIDE.md)
- [docs/ARCHITECTURE.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/ARCHITECTURE.md)
- [docs/UI_DESIGN_SYSTEM.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/UI_DESIGN_SYSTEM.md)
- [docs/DEVELOPMENT_TRACKER.md](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/DEVELOPMENT_TRACKER.md)

## 维护原则

- 以当前代码实际运行结构为准，不以历史页面和旧迁移方案为准。
- 新页面统一落在 `frontend/admin/views`。
- 后端 API 变更属于系统级变更，必须同步更新 API 文档。

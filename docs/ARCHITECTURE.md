# Architecture

## 1. Runtime Shape

```text
Browser
  -> public/admin.html
  -> public/vue-apps/assets/*
  -> src/server.js
  -> src/services.js / src/services/*
  -> MySQL
  -> Ozon API / PDF / deployment scripts
```

当前系统已经统一到 `Vue 3 + Element Plus` 管理端，旧版 SQLite 运行链路不再属于当前生产事实。

## 2. Layers

### Frontend

- `public/admin.html`
- `frontend/admin`
- `public/vue-apps`

说明：

- `frontend/admin` 是前端源码目录
- 运行时真正被后端托管的是 `public/admin.html` 和 `public/vue-apps/*`
- 本地与线上都应使用同一套构建产物

### HTTP

- `src/http/request.js`
- `src/http/response.js`
- `src/http/static.js`

### Server

- `src/server.js`
- `src/server/session.js`
- `src/server/access.js`
- `src/server/maintenance.js`
- `src/server/notifications.js`
- `src/server/routes/*`

当前已拆分的路由组包括：

- orders
- profit
- sync
- catalog
- operations

### Services

- `src/services.js`
- `src/services/*`
- `src/services/dashboard.js`
- `src/services/finance-sync.js`
- `src/services/historical-profit-review-entry.js`
- `src/services/online-products-entry.js`
- `src/services/order-sync.js`
- `src/services/order-profit-recalculation.js`
- `src/services/profit-maintenance.js`

### Data

- `src/db.js`
- MySQL runtime connection configured through `src/config.js` and `.env`

## 3. Current Rules

- 新页面统一放在 `frontend/admin/views`
- 旧静态页面不再作为当前系统说明依据
- 旧利润页、异常页、采购旧页不再在新后台显示
- 页面搜索区、表格区、分页区统一对齐当前管理端规范

## 4. Deployment

- 本地：`npm start`
- 开发：`npm run dev`
- 前端构建：`npm run build:frontend`
- 部署产物：`npm run package:deploy`

部署规则：

- `npm start` 会先构建前端再启动服务
- `npm run package:deploy` 会生成 `dist/deploy`
- 线上只应部署 `dist/deploy`，不要直接把源码目录作为运行目录
- `dist/deploy/package.json` 内的 `npm start` 只负责启动服务，不再重复构建前端

## 5. Current Concern

- `src/services.js` 仍然偏大
- `src/server.js` 还在继续下沉路由分发到 `src/server/routes/*`
- 新功能继续优先拆到 `src/services/*`

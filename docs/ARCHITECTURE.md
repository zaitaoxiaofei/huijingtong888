# Architecture

## 1. Runtime Shape

```text
Browser
  -> public/admin.html
  -> public/vue-apps/assets/*
  -> frontend/admin/*
  -> src/server.js
  -> src/services.js / src/services/*
  -> SQLite
  -> Ozon API / PDF / backup scripts
```

当前系统已统一到 Vue 3 + Element Plus 管理端，不再维护旧版静态工作台运行链路。

## 2. Layers

### Frontend

- `public/admin.html`
- `frontend/admin`
- `public/vue-apps`

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

Current route groups already being pulled out:

- orders
- profit
- sync
- catalog
- operations

### Services

- `src/services.js`
- `src/services/*`
- `src/services/dashboard.js`
- `src/services/historical-profit-review-entry.js`
- `src/services/online-products-entry.js`
- `src/services/profit-maintenance.js`

### Data

- `src/db.js`
- `data/ozon-profit-hub.sqlite`

## 3. Current Rules

- 新页面统一放在 `frontend/admin/views`
- 旧静态页面不再作为当前系统说明依据
- 旧利润页、异常页、采购旧页不再在新后台显示
- 页面搜索区、表格区、分页区统一对齐当前管理端规范

## 4. Deployment

- 本地: `npm start`
- 开发: `npm run dev`
- 前端构建: `npm run build:frontend`

## 5. Current Concern

- `src/services.js` 仍然较大
- `src/server.js` 正在继续下沉路由分发到 `src/server/routes/*`
- 新功能继续优先拆到 `src/services/*`

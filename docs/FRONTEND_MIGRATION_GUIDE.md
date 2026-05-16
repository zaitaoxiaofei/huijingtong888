# Frontend Migration Guide

## Goal

把当前 ERP 前端统一收敛到 `Vue 3 + Element Plus` 管理端，并停止继续维护旧版静态工作台页面。

## Current Strategy

- 新入口使用 `public/admin.html`
- 新页面集中在 `frontend/admin`
- 构建产物输出到 `public/vue-apps`
- 旧页面不再作为新系统的一部分展示

## Structure

- `frontend/admin/layouts`: 后台壳层
- `frontend/admin/views`: 路由级页面
- `frontend/admin/components`: 可复用业务组件
- `frontend/admin/stores`: Pinia 状态
- `frontend/admin/utils`: API 与通用工具
- `frontend/admin/styles`: 全局样式基线

## Migration Rules

- 优先把高频页面做成 Vue 页面
- 搜索区、表格区、分页区统一
- 页面滚动时顶部筛选区保持可见
- 分页固定在表格底部，不让长列表把分页顶到页面最底部
- 旧页面如有兼容跳转，只保留跳转，不保留渲染

## Current Ownership

- 订单、库存、采购、利润、异常、设置都以 `frontend/admin` 里的新页面为准
- 旧版静态入口不再作为当前说明

## Acceptance

- 根路径进入新后台
- 新页面一致采用 Vue 3 + Element Plus 风格
- 不再显示旧版利润页、异常页和采购旧页

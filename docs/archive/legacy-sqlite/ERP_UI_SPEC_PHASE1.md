# ERP UI Spec Phase 1

> Historical note: this phase spec was written during the old SQLite era. The current runtime baseline is MySQL.

## Goal

定义当前 ERP 新后台的统一壳层标准，并明确系统已经完成到 `Vue 3 + Element Plus` 管理端的主入口切换。

## Scope

- Vue 3 是前端应用框架
- Element Plus 是基础组件库
- 新后台负责布局、导航、登录态、路由和页面渲染
- 旧版业务页面不再作为新系统的渲染目标
- 后端 API 和 SQLite 结构在本阶段继续复用

## Layout Standard

- 左侧主导航
- 顶部页头展示面包屑、标题和账号操作
- 主内容区按页面卡片和表格结构组织
- 搜索区和关键工具条需要保持置顶

## Visual Standard

- 基础变量来自 `frontend/admin/styles/index.css`
- 页面卡片使用统一圆角、边框和轻阴影
- 表格、分页、按钮、筛选器保持统一视觉密度
- 不再为单独页面加入装饰型总览头图

## Routing Standard

- 新后台使用 Vue Router
- 新页面全部作为一等 Vue 视图维护
- 历史旧地址不再作为新系统路由的一部分维护

## Migration Standard

- 新页面实现目录: `frontend/admin/views`
- 公共布局目录: `frontend/admin/layouts`
- 公共组件目录: `frontend/admin/components`
- 旧版静态宿主页、旧版 iframe 页面、旧版多入口脚本不再继续扩展

## File Ownership

- `public/admin.html`: 当前管理端宿主页
- `frontend/admin/layouts/AdminLayout.vue`: 共享壳层
- `frontend/admin/constants/navigation.js`: 导航结构
- `frontend/admin/router/index.js`: 路由契约
- `frontend/admin/styles/index.css`: 全局样式基线

## Acceptance

- 根路径打开新后台
- 登录流程可用
- 当前 Vue 页面正常运行
- 新系统内不再显示旧版利润页、异常页和采购旧页

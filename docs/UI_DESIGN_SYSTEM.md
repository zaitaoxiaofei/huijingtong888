# Ozon ERP UI Design System

产品和开发进度统一记录在 `docs/DEVELOPMENT_TRACKER.md`。本文件定义当前 Vue 管理端必须遵守的 UI 规范。

## 1. 当前前端栈

- 框架: Vue 3
- 组件库: Element Plus
- 构建工具: Vite
- 宿主页: `public/admin.html`
- 源码目录: `frontend/admin`
- 运行时产物目录: `public/vue-apps`

说明:

- 新系统不再维护旧版静态页面体系
- 新页面必须直接落在 Vue 管理端
- 公共布局、分页、表格、搜索区优先复用现有管理端组件和样式

## 2. 目标风格

- ERP 优先: 紧凑、稳定、可连续操作
- 统一优先: 相同类型页面使用相同的搜索区、表格区、分页区结构
- 粘性优先: 搜索区和关键工具条置顶，不因滚动丢失
- 数据优先: 不使用夸张总览卡、装饰型 hero、大面积无业务价值模块

## 3. 布局规则

- 页面主体使用卡片化分区，但避免层级过深
- 搜索区固定在页面顶部，和内容区分离
- 表格区单独滚动，不让分页被内容无限向下撑开
- 分页固定在表格区底部，样式与订单中心分页保持一致
- 弹窗头部固定，弹窗内容区滚动

## 4. 采购模块规则

- 采购中心页只承担“创建采购请求”和“请求列表管理”
- 不再保留采购总览页
- 采购页面顶部不展示采购汇总、待入库等概览块
- 非必要的旧采购表单字段不在采购请求页渲染
- 采购清单页面才承担汇总视角

## 5. 组件优先级

- 优先使用 Element Plus 原生组件
- 公共分页统一使用 [frontend/admin/components/PageFooterPagination.vue](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/components/PageFooterPagination.vue)
- 共享布局和全局色板统一来自 [frontend/admin/styles/index.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/frontend/admin/styles/index.css)
- 页面级结构优先对齐订单中心、库存、采购当前实现

## 6. 视觉规则

- 主色使用当前管理端蓝色体系
- 背景跟随当前浅色或深色主题，保持低噪音
- 卡片圆角、边框、阴影使用统一系统值
- 不新增随机色、不引入旧页面残留配色
- 危险和警告只标记在标签、文字、边框上，不整块高饱和铺底

## 7. 开发规则

- 新页面放在 `frontend/admin/views`
- 共享组件放在 `frontend/admin/components`
- 不新增旧静态页面入口
- 不重新引入 iframe 挂载旧业务页
- 如果已有新页面能承接业务，不再保留旧页面并行实现

## 8. 验收重点

- 页面滚动时搜索区保持可见
- 分页始终位于可预期的底部区域
- 同类页面的筛选器、按钮、间距、分页交互一致
- 旧版利润页、异常页、采购旧页不在新系统出现

## 9. 深色主题

- 全局色板由 `frontend/admin/styles/erp-theme.css` 的主题变量维护，页面不能用固定白底或深灰字覆盖深色主题。
- 普通背景、浮层、文字、边框分别使用 `--erp-surface` / `--erp-surface-alt`、`--erp-text-*`、`--erp-border-*`；成功、警告和危险状态分别使用对应的 `--erp-*-bg` / `--erp-*-text` / `--erp-*-border`。
- 实色主按钮使用 `--erp-primary-fill` 与 `--erp-primary-contrast` 配对，避免只改背景或只改文字。禁用态、悬停、键盘焦点和选中态必须能辨认。
- 页面私有色板可在深色根节点下映射共享变量，浅色保留现有颜色回退值；主题修复不改变布局尺寸、业务行为或接口。
- 下拉菜单、日期选择器、弹窗等传送到 `body` 的浮层也必须跟随主题，不能仅依赖页面容器内的变量。
- 验收需实际切换浅色 → 深色 → 浅色，并检查跨页导航、状态标签、按钮、输入框及浮层。抽查普通文字对比度至少 4.5:1，不能只检查页面背景。

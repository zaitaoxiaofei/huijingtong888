# Ozon ERP 项目总览与交接文档

## 1. 文档目的

这份文档用于说明当前 `ozon-system` 项目的真实结构、核心业务模型、主要接口、前后端分工、部署运行方式，以及后续维护时应该优先关注的文件和风险点。

它的定位是“交接主文档”。如果后续只看一份文档来理解项目，应优先看这里。

## 1.1 文档治理原则

后续所有项目文档统一采用以下口径：

- 当前事实以代码为准
- 运行入口以当前文件引用关系为准
- 接口行为以 `src/server.js` 和对应服务实现为准
- 数据结构以 `src/db.js` 与实际数据库迁移结果为准
- 规划、评审、优化方案属于“目标状态”，不是“当前实现”

如果文档与代码不一致，应优先修正文档，而不是按旧文档推断代码行为。

## 2. 项目定位

当前项目是一个本地部署的单体 ERP 系统，服务于 Ozon 店铺运营，覆盖以下核心业务：

- 选品与计价
- 在线商品同步与 SKU 绑定
- 采购申请与采购单合并
- 入库与出库流水
- 订单同步与履约处理
- 利润汇总与利润明细
- 库存预警、异常任务、物流规则、供应商配置

技术上，它不是前后端分离的多服务架构，而是一个 Node.js 单体应用：

- 后端：原生 Node `http` 服务
- 前端：静态 HTML + 原生 JavaScript
- 数据库：SQLite
- 外部集成：Ozon API、备份/恢复 PowerShell 脚本

## 3. 实际入口与关键文件

### 3.1 后端入口

- [src/server.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)

职责：

- 启动 HTTP 服务
- 处理登录态与 Session 校验
- 提供静态文件服务
- 分发 API 路由
- 调用 `src/services.js` 中的业务函数
- 触发备份/恢复脚本

### 3.2 前端入口

- [public/index.html](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- [public/app.repair.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)

当前 `index.html` 实际加载的是：

```html
<script src="/app.repair.js?v=20260512-mainfix"></script>
```

这意味着当前真实前端主入口是 `public/app.repair.js`，不是 `public/app.js`。

说明：

- `public/app.repair.js`：当前运行中的前端逻辑文件
- `public/app.js`：较早版本，仍有参考价值，但不是当前浏览器实际加载入口
- `public/app.js.broken-20260512-restore-bak`：历史损坏备份，不应作为运行入口

后续如果前端入口再次变更，必须先更新这里，再更新其他专题文档。

### 3.3 主要业务实现文件

- [src/services.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
- [src/db.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
- [src/ozonClient.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/ozonClient.js)
- [src/profit.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/profit.js)
- [src/celRates.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/celRates.js)
- [src/pricingFormula.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/pricingFormula.js)
- [src/config.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)

## 4. 技术栈与运行方式

### 4.1 技术栈

- Node.js 22+
- 原生 Node HTTP 服务
- SQLite
- 原生前端 JavaScript
- `pdf-lib`：用于面单等 PDF 处理

### 4.2 启动命令

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

### 4.3 默认配置

配置文件来自 [src/config.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/config.js)：

- `HOST`：监听地址，默认空字符串
- `PORT`：默认 `8787`
- `DATABASE_PATH`：默认 `./data/ozon-profit-hub.sqlite`
- `APP_BASE_URL`：默认 `http://localhost:8787`

### 4.4 数据文件位置

默认数据库文件：

- `data/ozon-profit-hub.sqlite`
- `data/ozon-profit-hub.sqlite-wal`
- `data/ozon-profit-hub.sqlite-shm`

注意：

- 业务数据主要保存在 SQLite，不在前端文件里
- 迁移系统时不能只复制 `public/` 或 `src/`，还需要带上 `data/`

## 5. 系统架构

当前系统的运行链路可以概括为：

```text
浏览器
  -> public/index.html + public/app.repair.js
  -> src/server.js
  -> src/services.js
  -> SQLite
  -> Ozon API / 备份恢复脚本 / PDF 处理
```

分层职责如下：

### 5.1 前端层

由 `public/index.html` + `public/app.repair.js` 组成，负责：

- 页面布局与弹窗
- 筛选、分页、搜索、切换标签页
- 表单提交
- 调用 `/api/*`
- 渲染订单、利润、库存、采购等模块

### 5.2 路由层

`src/server.js` 负责：

- 处理登录接口
- 对其余 `/api/*` 请求做 Session 校验
- 将请求分发给 `services.js`
- 对部分 REST 风格路径做参数解析
- 提供静态资源

### 5.3 业务层

`src/services.js` 是核心业务文件，承载绝大多数业务逻辑，包括：

- 商品、店铺、人员 CRUD
- 在线 SKU 绑定
- 订单同步、订单状态、发货
- 采购请求和采购单
- 入库与库存流水
- 利润汇总和利润重算
- 异常任务、库存预警、物流规则、供应商管理

### 5.4 数据层

`src/db.js` 负责：

- SQLite 初始化
- 表结构创建
- 密码哈希与校验

## 6. 核心业务模型

项目最重要的建模思路是把“真实产品”和“平台在线 SKU”分开。

### 6.1 `products`

真实产品表，代表内部实际采购、入库、持有库存的货品。

典型字段：

- `id`
- `selection_id`
- `code`
- `name`
- `purchase_cost`
- `domestic_shipping`
- `package_weight_g`
- `shipping_method`
- `owner_person_id`

作用：

- 采购、入库、库存、利润归因的核心对象

### 6.2 `online_products`

在线商品表，代表 Ozon 店铺中的实际在线 SKU。

典型字段：

- `shop_id`
- `ozon_sku`
- `offer_id`
- `name`
- `sale_price`
- `stocks_json`
- `attributes_json`
- `raw_json`

作用：

- 承接 Ozon 同步结果
- 作为平台视角的商品池

### 6.3 `sku_mappings`

SKU 绑定表，用于将 Ozon SKU 绑定到真实产品。

典型字段：

- `shop_id`
- `product_id`
- `person_id`
- `online_product_id`
- `ozon_sku`

作用：

- 把平台销售行为映射到内部产品
- 决定订单成本、库存扣减、负责人归属

### 6.4 `orders` 与 `order_items`

- `orders`：订单主表
- `order_items`：订单明细

重要特点：

- `order_items` 中冻结了成本快照
- 这样即使后续修改产品采购价，也不会直接污染历史订单利润

### 6.5 `inventory_movements`

库存流水表，而不是“只维护一个当前库存字段”。

作用：

- 记录入库、出库、调整、取消回滚等库存变化
- 当前库存由流水汇总而来
- 便于审计和历史重算

### 6.6 `procurement_requests`

采购请求表，面向产品发起采购需求，而不是面向店铺 SKU。

这意味着多个不同店铺 SKU，只要绑定到同一个真实产品，就能在采购侧合并。

### 6.7 `order_profit_items`

利润拆解表，用于保存更细颗粒度的利润明细，例如：

- 销售额
- 采购成本
- 国内运费
- 国际运费
- 佣金
- Ozon 服务费
- 退货损失
- 其他费用

## 7. 关键业务流程

### 7.1 选品与定价

流程：

1. 运营创建真实产品
2. 录入采购成本、重量、尺寸、运费、目标利润
3. 调用计价逻辑计算建议售价和利润
4. 后续再与在线商品绑定

相关文件：

- [public/app.repair.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)
- [src/celRates.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/celRates.js)
- [src/pricingFormula.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/pricingFormula.js)

### 7.2 在线商品同步与 SKU 绑定

流程：

1. 从 Ozon 拉取在线商品
2. 写入 `online_products`
3. 用户选择在线 SKU
4. 绑定到内部 `products`
5. 指定负责人

结果：

- 后续订单同步时可识别该 SKU 属于哪个真实产品
- 利润和库存可归集到正确产品上

### 7.3 采购流程

流程：

1. 运营或采购提交采购请求
2. 请求进入需求池
3. 多条请求可按 `product_id` 合并为采购单
4. 采购单确认后进入待入库阶段
5. 到货后生成或更新入库记录

设计重点：

- 采购对象是“真实产品”
- 不是“店铺 SKU”

### 7.4 入库流程

流程：

1. 采购完成后创建入库记录
2. 入库通过后写入 `inventory_movements`
3. 库存增加
4. 库存页面和利润页面读取最新库存汇总

### 7.5 订单同步与出库

流程：

1. 从 Ozon 同步订单
2. 写入 `orders`、`order_items`、`ozon_orders_raw`
3. 若 SKU 已绑定产品，则可关联成本与负责人
4. 生成出库流水或库存扣减逻辑
5. 若取消、退货或异常，按规则修正利润和库存状态

### 7.6 利润统计

当前利润统计主要围绕三个层次：

- 店铺维度
- SKU 维度
- 产品维度

`profitSummary(from, to)` 以 `orders.ordered_at` 作为时间口径。

这表示当前报表更偏“经营发生口径”，而不是纯财务到账口径。

### 7.7 异常任务与库存预警

系统会识别并聚合以下风险：

- 待绑定 SKU
- 库存不足
- 发货超时风险
- 利润异常
- 仓库规则异常

## 8. 前端页面结构

根据 [public/index.html](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)，当前主要页面包括：

- 异常任务中心
- 利润看板
- 选品计价表
- 订单系统
- 出库流水
- 库存系统
- 采购系统
- 在线商品
- 系统设置

系统设置内又包含：

- 计价公式
- 利润规则
- 店铺配置
- 人员配置
- 汇率设置

前端状态集中维护在 `public/app.repair.js` 的 `state` 对象中，主要包含：

- 当前视图
- 当前登录状态
- 店铺、产品、人员、在线商品缓存
- 订单筛选条件
- 库存筛选条件
- 采购筛选条件
- 分页状态
- 利润筛选与排序状态

## 9. 后端 API 概览

下面不是逐行穷举所有接口细节，而是按业务域整理主要接口组。

### 9.1 系统与认证

- `GET /api/system/info`
- `POST /api/system/backup`
- `POST /api/system/restore`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`

### 9.2 仪表盘与汇率

- `GET /api/dashboard`
- `GET /api/exchange-rate/current`
- `GET /api/exchange-rates`
- `POST /api/exchange-rate`
- `POST /api/pricing/cel-fbs`

### 9.3 产品与在线商品

- `GET /api/products`
- `GET /api/products/hidden`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `POST /api/products/:id/restore`
- `POST /api/products/import-preview`
- `POST /api/products/import-commit`
- `GET /api/online-products`
- `POST /api/online-products`
- `PUT /api/online-products/:id`
- `POST /api/online-products/bind`
- `POST /api/online-products/create-product`
- `POST /api/online-products/action`

### 9.4 订单与发货

- `GET /api/orders`
- `GET /api/orders/:id`
- `PUT /api/orders/:id/mark`
- `POST /api/orders/package-label`
- `POST /api/orders/package-label-printed`
- `POST /api/orders/ship`
- `POST /api/orders/recalculate-profits`
- `POST /api/orders/:id/recalculate-profit`

### 9.5 采购、入库、出库

- `GET /api/procurement/summary`
- `GET /api/procurement/requests`
- `POST /api/procurement/requests`
- `PUT /api/procurement/requests/:id`
- `DELETE /api/procurement/requests/:id`
- `POST /api/procurement/requests/submit`
- `GET /api/procurement/purchase-orders`
- `GET /api/procurement/purchase-orders/:id`
- `POST /api/procurement/purchase-orders`
- `PUT /api/procurement/purchase-orders/:id`
- `DELETE /api/procurement/purchase-orders/:id`
- `POST /api/procurement/purchase-orders/:id/confirm-purchased`
- `POST /api/procurement/purchase-orders/:id/cancel`
- `GET /api/procurement/pending-inbound`
- `GET /api/inbound-records`
- `POST /api/inbound-records`
- `PUT /api/inbound-records/:id`
- `DELETE /api/inbound-records/:id`
- `GET /api/outbound-records`
- `POST /api/inventory/movements`

### 9.6 配置与规则

- `GET /api/shops`
- `POST /api/shops`
- `PUT /api/shops/:id`
- `DELETE /api/shops/:id`
- `GET /api/people`
- `POST /api/people`
- `PUT /api/people/:id`
- `DELETE /api/people/:id`
- `GET /api/mappings`
- `PUT /api/mappings/:id`
- `DELETE /api/mappings/:id`
- `GET /api/logistics-rules`
- `POST /api/logistics-rules`
- `PUT /api/logistics-rules/:id`
- `DELETE /api/logistics-rules/:id`
- `GET /api/stock-warehouse-rules`
- `POST /api/stock-warehouse-rules`
- `PUT /api/stock-warehouse-rules/:id`
- `DELETE /api/stock-warehouse-rules/:id`
- `GET /api/suppliers`
- `POST /api/suppliers`
- `PUT /api/suppliers/:id`
- `DELETE /api/suppliers/:id`

### 9.7 同步与报表

- `POST /api/sync/ozon`
- `POST /api/sync/ozon/incremental`
- `POST /api/sync/online-products`
- `POST /api/sync/ozon-stocks`
- `POST /api/sync/ozon-finance`
- `GET /api/ozon-finance/summary`
- `GET /api/profit-summary`
- `GET /api/erp/profit-items`
- `GET /api/erp/raw-orders`
- `GET /api/erp/inventory-current`
- `GET /api/erp/order-exceptions`

## 10. 登录与权限机制

认证逻辑在 [src/server.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)。

特点：

- Session 存 SQLite，不是纯内存
- 登录成功后返回 token
- 前端通过 `Authorization: Bearer <token>` 调用受保护接口
- `/api/auth/*` 外的接口默认需要登录
- 过期 Session 会被清理

相关表：

- `people`
- `sessions`

## 11. 备份与恢复

### 11.1 命令

备份：

```powershell
npm run backup:data
```

或：

```powershell
.\backup-data.bat
```

恢复：

```powershell
npm run restore:data
```

或：

```powershell
.\restore-data.bat
```

### 11.2 相关文件

- [scripts/backup-data.ps1](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/backup-data.ps1)
- [scripts/restore-data.ps1](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/scripts/restore-data.ps1)
- [backup-data.bat](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/backup-data.bat)
- [restore-data.bat](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/restore-data.bat)

### 11.3 恢复机制说明

恢复动作不是简单地“在当前进程内覆盖数据库”。

`server.js` 中的恢复流程会：

1. 启动 PowerShell 恢复脚本
2. 停掉当前 Node 进程
3. 执行数据恢复
4. 自动重新拉起服务

因此恢复后需要等待几秒再刷新页面。

## 12. 健康检查与辅助脚本

已有命令：

- `npm run check:health`
- `npm run check:ui`

主要脚本目录：

- `scripts/health-check.mjs`
- `scripts/check-ui-design-system.mjs`
- `scripts/checkpoint-db.mjs`
- `scripts/cleanup-demo-orders.mjs`

用途：

- 检查服务和登录态
- 验证关键接口是否可用
- 做数据库检查点或演示数据清理

## 13. 当前代码现状与风险

### 13.1 文档现状不一致

仓库内已有文档和当前实际实现并不完全一致，尤其：

- 旧 README 中对前端主入口的说明与当前结构存在历史信息
- 多处中文注释和提示存在乱码历史
- 文档存在英文、中文、旧设计稿并存的情况

后续统一规则：

- 总览文档负责记录当前事实
- 设计文档负责记录目标方案
- 历史审查文档保留背景，但不再作为当前实现说明
- 任何功能优化与升级都应先核对当前代码，再修改文档

### 13.2 前端主文件存在历史修复痕迹

`public/app.repair.js` 已经承载大量业务逻辑，文件较大，后续维护风险较高：

- 单文件过大
- 视图状态、请求逻辑、渲染逻辑耦合
- 历史修复痕迹较多

建议后续逐步拆分：

- 订单模块
- 采购模块
- 库存模块
- 利润模块
- 通用 UI / API / 工具函数

### 13.3 `src/services.js` 是业务集中点

该文件是当前系统的最大业务入口，优点是集中，缺点是：

- 修改范围容易相互影响
- 回归验证成本高
- 新人理解门槛高

后续建议按域拆分：

- `services/orders.js`
- `services/procurement.js`
- `services/inventory.js`
- `services/profit.js`
- `services/configuration.js`

### 13.4 SQLite 适合当前阶段，但要注意单机边界

当前单机部署、轻并发团队场景下 SQLite 足够实用。

但如果以后出现：

- 多人高频并发操作
- 更复杂报表
- 多实例部署

则需要评估迁移到更完整的数据库方案。

## 14. 建议阅读顺序

如果是新接手这个项目，建议按以下顺序阅读：

1. [docs/PROJECT_GUIDE.md](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/PROJECT_GUIDE.md)
2. [src/server.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
3. [src/services.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
4. [src/db.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
5. [public/index.html](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
6. [public/app.repair.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)
7. [docs/ARCHITECTURE.md](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/ARCHITECTURE.md)
8. [docs/order-sync-strategy.md](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/docs/order-sync-strategy.md)

## 15. 下一步建议

如果继续完善项目文档，建议按下面顺序推进：

1. 补一份“数据库表结构详解”，逐表说明字段和业务含义
2. 补一份“API 接口说明”，按请求参数和响应结构细化
3. 补一份“前端页面与操作手册”，面向运营/采购/管理员
4. 清理核心文件中的乱码注释和乱码提示文案
5. 逐步拆分 `public/app.repair.js` 和 `src/services.js`

## 16. 当前已完成的结构拆分

为了降低耦合、提高可读性，并给后续功能升级留出空间，当前代码已经完成一轮“低风险结构重构”。

这轮重构的目标不是改业务规则，而是把高耦合入口层拆开，先建立稳定的模块边界。

### 16.1 后端入口层拆分

`src/server.js` 已从“超大入口文件”调整为组合式入口，当前主要负责：

- 启动服务
- 做统一鉴权
- 调用静态资源处理器
- 调用 REST 路由分发
- 调用基础路由表

已拆出的配套模块：

- [src/http/request.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/request.js)
- [src/http/response.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/response.js)
- [src/http/static.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/http/static.js)
- [src/server/session.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/session.js)
- [src/server/maintenance.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/maintenance.js)
- [src/server/notifications.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server/notifications.js)

这样做的意义是：

- 会话逻辑不再和路由逻辑混在一起
- 静态资源处理与 JSON 响应职责分离
- 备份恢复逻辑从主入口剥离
- 后续可继续把 REST 路由再下沉为独立模块

### 16.2 服务导出层拆分

虽然 `src/services.js` 仍然保留了现有业务实现，但已经新增了按业务域组织的导出层：

- [src/services/index.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/index.js)
- [src/services/analytics.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/analytics.js)
- [src/services/catalog.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/catalog.js)
- [src/services/configuration.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/configuration.js)
- [src/services/inventory.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/inventory.js)
- [src/services/orders.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/orders.js)
- [src/services/procurement.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/procurement.js)
- [src/services/sync.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services/sync.js)

当前这些文件的作用是：

- 先建立清晰的业务域边界
- 让 `server.js` 不再直接从巨型 `services.js` 引入几十个函数
- 为后续把具体实现逐步迁移出 `services.js` 做过渡层

### 16.3 当前阶段的重构策略

当前采取的是“兼容式重构”而不是“推倒重写”。

原则如下：

- API 路径不变
- 前端调用方式不变
- 数据库结构不因这轮拆分而变
- 先拆入口层和导出层
- 再逐步把内部实现迁出老文件

这样能降低一次性大改带来的回归风险。

## 17. 下一阶段建议拆分顺序

当前项目最大的两个高耦合文件仍然是：

- [src/services.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
- [public/app.repair.js](C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)

建议后续按下面顺序继续拆分。

### 17.1 后端继续拆分顺序

建议优先把 `src/services.js` 内部实现依次迁出：

1. 订单域
2. 采购域
3. 库存域
4. 商品与 SKU 绑定域
5. 配置域
6. 同步域
7. 分析报表域

原因：

- 订单、采购、库存是最重业务链路
- 这些模块变动频率高，先拆最能降低后续维护成本

### 17.2 前端继续拆分顺序

前端当前真实入口仍是 `public/app.repair.js`，不建议一次性大拆。

建议下一阶段按“功能块”拆成多个文件，然后仍由入口文件统一初始化：

1. `auth`
2. `orders`
3. `procurement`
4. `stock`
5. `online-products`
6. `profit`
7. `selection`
8. `shared ui / utils / api`

### 17.3 高可用与高扩展性的重点

如果目标是高可用、高扩展，后续不仅要拆文件，还要把下面这些能力补齐：

- 统一输入校验
- 更稳定的错误码体系
- 路由层与服务层的参数边界约束
- 更细的日志和操作审计
- 核心查询索引优化
- 关键同步与重算任务的可追踪状态
- 前端模块化后的局部刷新机制

仅仅把大文件拆成小文件，不足以自动得到高可用；真正的提升来自结构边界清晰后，继续补强这些基础能力。

## 18. 数据库后续演进方向

当前数据库仍以 SQLite 为准。

这一阶段的重点仍然是：

- 先优化代码结构
- 先降低耦合
- 先稳定业务模块边界

不建议在当前高频重构阶段直接切换数据库，否则会把“代码重构风险”和“数据层迁移风险”叠加在一起。

### 18.1 后续迁移方向

当代码结构稳定后，下一阶段可以正式进入数据库演进设计：

- 从 SQLite 迁移到 MySQL
- 同步评估接入 TypeORM

### 18.2 TypeORM 的建议定位

TypeORM 不是当前阶段的立即任务，而是后续数据库升级阶段的候选方案。

它适合放入后续设计任务的原因是：

- 可以统一实体映射
- 可以减少分散的数据访问代码
- 更适合后续 MySQL 化、多环境配置和迁移脚本管理
- 有利于后续测试和领域边界进一步清晰化

但在真正引入前，仍然要评估：

- 现有报表与聚合 SQL 是否适合 ORM 化
- 同步写入和利润重算链路是否需要保留部分手写 SQL
- 迁移期是否采用混合模式

### 18.3 后续任务清单

等当前代码优化完成后，再单独开启以下任务：

1. MySQL 目标表结构设计
2. SQLite 到 MySQL 的迁移脚本和校验方案
3. TypeORM PoC 验证
4. 数据访问层分层方案
5. 新旧数据库切换策略

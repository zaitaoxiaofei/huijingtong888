# Ozon Profit Hub — 代码审查报告

> 审查时间：2026-05-01  
> 审查范围：全系统（server.js / services.js / celRates.js / profit.js / app.js / index.html / styles.css）

---

## 一、关键 Bug（需立即修复）

### BUG 1：`app.js` — `columnDialog` 仍用原生 `showModal()`，与编辑弹窗方案不一致
- **文件**：`app.js` → `bindColumnDialog()`
- **问题**：编辑弹窗已改为 class 控制显示，但"字段显示"对话框仍用原生 `showModal()`，在某些浏览器下可能有同样的关闭问题
- **修复方向**：统一用 class 控制，或至少保留一种方案

### BUG 2：`app.js` — `fillSelects()` 中 `setDefaults()` 触发时机过早
- **文件**：`app.js` → `fillSelects()` / `setDefaults()`
- **问题**：`setDefaults()` 在 `fillSelects()` 末尾调用，此时 `updateRecommendation()` 会读取新增表单的 DOM 值，但如果新增表单尚未渲染完成，可能读到旧值
- **严重程度**：低（功能上影响很小）

### BUG 3：`services.js` — `updateProduct` SQL 参数顺序错误
- **文件**：`services.js` → `updateProduct(id, body)`
- **问题**：`SET` 子句中的字段顺序与 `run()` 的参数顺序必须一一对应。当前 `product_type` 在 SET 中排在 `owner_person_id` 之后，但 run() 参数中 `body.product_type || "main"` 排在 `Number(body.return_rate || 0.05)` 之前——**顺序不匹配**，会导致 `product_type` 被写入 `return_rate` 的值，`return_rate` 被写入错误值。
- **修复方向**：仔细核对 SET 字段与 run() 参数的顺序，确保一一对应

### BUG 4：`services.js` — `createProduct` 中 `target_margin` 被写入 `desired_profit_value`
- **文件**：`services.js` → `createProduct(body)`
- **问题**：INSERT 语句中包含 `target_margin` 字段，但数据库 `products` 表可能没有 `target_margin` 字段（根据 `db.js` 的建表语句，字段应为 `desired_profit_mode` 和 `desired_profit_value`）。如果 `target_margin` 字段不存在，INSERT 会报错。
- **修复方向**：确认 `db.js` 中的建表语句，确保 INSERT/UPDATE 字段名完全一致

### BUG 5：`profit.js` — `estimateItemProfit` 使用 `mapping.commission_low/mapping.commission_high` 但未定义
- **文件**：`profit.js` → `commissionRate(price, mapping)`
- **问题**：函数读取 `mapping.commission_low` 和 `mapping.commission_high`，但 `sku_mappings` 表中并没有这两个字段（佣金率是在 `celRates.js` 中根据 `listing_price_rub` 动态计算的）。这会导致 `commissionRate` 始终返回 `undefined * qty = NaN`。
- **影响**：所有订单利润预估都是错的
- **修复方向**：`profit.js` 的佣金计算应与 `celRates.js` 保持一致，用 `price < 1500 ? 0.12 : 0.17`（或改成从 products 表读取）

---

## 二、逻辑问题（功能正确但设计不合理）

### 问题 1：`celRates.js` — `suggestRub()` 中 `exchangeRate` 在循环内使用但未随 `rub` 变化
- `suggestRub(freightRmb)` 内循环两个佣金率，但 `exchangeRate` 是外层传入的常量，没有根据反推出来的 `rub` 重新判断佣金档位。当前用 `correctCommRate` 验证了档位，但验证逻辑与 `saleRmb` 的计算分离，可能导致轻微误差。
- **严重程度**：低（误差通常在 1% 以内）

### 问题 2：`services.js` — `products()` 对每个产品调用 `calculateSelectionPricing()`，数据量大时性能差
- 每次刷新页面都要对全量产品做运费匹配和利润计算，产品数 > 500 时前端会卡顿
- **优化方向**：后端增加缓存，或 pagination

### 问题 3：`app.js` — 编辑弹窗打开时创建多个 backdrop DOM
- `openEditDialog()` 每次调用都 `document.createElement("div")` 创建新的 backdrop，旧 backdrop 虽被移除但频繁打开会有短暂闪烁
- **优化方向**：backdrop 作为固定 DOM 元素放在 HTML 中，显示/隐藏用 class 控制

### 问题 4：数据库缺少索引
- `inventory_movements(product_id, status)`、`order_items(order_id)`、`sku_mappings(product_id, shop_id)` 等关联查询字段没有索引，数据量大时查询会慢
- **优化方向**：在 `db.js` 的建表语句后增加 `CREATE INDEX`

---

## 三、代码规范问题

1. **`services.js` 行尾逗号不一致**：部分 SQL 模板字符串中逗号后有换行，部分没有，影响可读性
2. **`app.js` 中 `escape()` 函数与内置方法重名**：自定义 `escape()` 与 `window.escape()` 重名，虽然后者已废弃，但仍建议改名（如 `escapeHtml()`）
3. **`celRates.js` 中 `OZON_RFBS_RULES` 硬编码**：运费规则应可从数据库或配置文件读取，当前改规则需要改代码
4. **缺少输入校验**：`services.js` 中 `createProduct`/`updateProduct` 对 `exchange_rate`、`return_rate` 等数值字段没有校验范围（如 `exchange_rate > 0`），异常情况会导致 `calculateSelectionPricing` 除零或输出 `Infinity`

---

## 四、优先级排序

| 优先级 | 问题 | 影响 |
|:---|:---|:---|
| P0 | BUG 3：`updateProduct` 参数顺序错误 | 数据写入错误，可能导致数据损坏 |
| P0 | BUG 5：`profit.js` 佣金计算引用不存在的字段 | 所有订单利润预估错误 |
| P1 | BUG 4：`createProduct` 中 `target_margin` 字段名可能错误 | 新增产品时报错 |
| P1 | BUG 1：`columnDialog` 关闭不一致 | 用户体验问题 |
| P2 | 逻辑问题 1-4 | 性能/可维护性 |
| P3 | 代码规范问题 | 可读性/可维护性 |

---

## 五、下一步行动

1. [ ] 修复 P0 Bug（`updateProduct` 参数顺序 + `profit.js` 佣金计算）
2. [ ] 修复 P1 Bug（`createProduct` 字段名 + `columnDialog` 一致性）
3. [ ] 增加数据库索引
4. [ ] 增加输入校验
5. [ ] 优化 `products()` 查询性能
6. [ ] 统一弹窗显示/隐藏方案
7. [ ] 更新 README.md

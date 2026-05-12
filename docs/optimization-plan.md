# Ozon Profit Hub — 优化方案

> 生成时间：2026-05-01  
> 基于完整代码审查，按优先级排列

---

## P0 — 数据写入错误（立即修复）

### 1. `services.js` — `updateProduct` SET 字段与参数顺序不匹配

**位置**：`services.js` 第 264–298 行

**问题**：`UPDATE ... SET` 子句中的字段顺序，与 `.run()` 的参数顺序必须完全一致。当前 `target_margin` 在 SET 中排在 `exchange_rate` 之后，但 `.run()` 参数中 `Number(body.target_margin || 0.2)` 却排在 `Number(body.exchange_rate || 11.32)` 之前，顺序错位，导致写入错误数据。

**修复**：逐项核对 SET 字段与 run() 参数，确保顺序一一对应。

---

### 2. `services.js` — `createProduct` 读取了不存在的 `body.target_margin`

**位置**：`services.js` 第 254 行

**问题**：INSERT 语句中包含 `target_margin` 字段（对应 `db.js` 建表中的列），但读取值时用的是 `Number(body.target_margin || 0.2)`。前端 POST 过来的字段名是 `desired_profit_mode` 和 `desired_profit_value`，`body.target_margin` 始终为 `undefined`，导致 `target_margin` 列始终被写入默认值 `0.2`，用户在表单中设置的目标利润率被忽略。

**修复**：`createProduct` 和 `updateProduct` 中涉及 `target_margin` 的读取逻辑，应统一改为从 `desired_profit_mode` / `desired_profit_value` 计算，或直接移除 `target_margin` 列（既然已经有 `desired_profit_mode` 和 `desired_profit_value` 两个字段）。

**建议方案**：`products` 表保留 `desired_profit_mode` 和 `desired_profit_value`，删除 `target_margin` 列（迁移脚本自动处理），`createProduct` / `updateProduct` 不再读写 `target_margin`。

---

## P1 — 功能 Bug（尽快修复）

### 3. `app.js` — `columnDialog` 仍用原生 `showModal()`，关闭逻辑不一致

**位置**：`app.js` 第 570 行（原位置，需确认当前实际行号）

**问题**：编辑弹窗已改为 class 控制显示/隐藏，但"字段显示"对话框仍调用原生 `showModal()`，两处弹窗行为不一致，可能导致新的兼容性问题。

**修复**：将 `columnDialog` 也改为与编辑弹窗一致的 class 控制方案，或统一回归原生 `showModal()`/`close()`。

---

### 4. `celRates.js` 与 `profit.js` 佣金率计算方式不一致

**位置**：`celRates.js` 第 141 行 / `profit.js` 第 2 行

**问题**：
- `celRates.js`（选品计价表用）：佣金率按 `listingPriceRub <= 1500` 固定用 12% / 17%
- `profit.js`（订单利润用）：佣金率从 `sku_mappings.commission_low/high` 读取（默认值也是 12%/17%）

两者逻辑等价，但维护了两套实现。若未来修改佣金规则，需同步改两处。

**修复**：将佣金率计算抽取为共享函数，或统一由 `celRates.js` 提供 `getCommissionRate(price)` 供 `profit.js` 调用。

---

## P2 — 性能与体验优化

### 5. `services.js` — `products()` 对每个产品调用 `calculateSelectionPricing()`

**位置**：`services.js` 第 98 行

**问题**：每次 GET `/api/products` 都对全量产品做运费匹配和利润计算，产品数 > 500 时前端卡顿。

**修复方案**（二选一）：
- **方案 A**：后端增加缓存，`calculateSelectionPricing` 结果缓存至产品记录更新时失效
- **方案 B**：前端分页加载，后端支持 `?limit=50&offset=0`

---

### 6. 数据库缺少索引

**问题**：以下查询字段缺少索引，数据量大时查询缓慢：
- `inventory_movements(product_id, status)`
- `order_items(order_id)`
- `sku_mappings(product_id, shop_id)`
- `orders(shop_id, tracking_stage)`

**修复**：在 `db.js` 的 `migrateDb()` 中增加：
```sql
CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory_movements(product_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
--  etc.
```

---

### 7. `app.js` — 编辑弹窗每次打开创建新 backdrop DOM

**位置**：`app.js` `openEditDialog()` 函数

**问题**：每次点编辑都 `document.createElement("div")` 创建新 backdrop，旧 backdrop 移除时有短暂闪烁。

**修复**：backdrop 作为固定 DOM 元素写在 `index.html` 中，显示/隐藏用 class 控制。

---

## P3 — 代码规范

### 8. `app.js` — 自定义 `escape()` 与废弃的 `window.escape()` 重名

**修复**：改名为 `escapeHtml()`。

### 9. `celRates.js` — `OZON_RFBS_RULES` 硬编码

**修复**：迁移至数据库表 `shipping_rules`，支持后台配置。

### 10. 缺少输入校验

**修复**：`services.js` 的 `createProduct`/`updateProduct` 中对 `exchange_rate`、`return_rate` 等数值字段增加 `> 0` 校验，防止 `calculateSelectionPricing` 除零。

---

## 修复顺序建议

```
第一批（P0）：修复数据写入错误 → 重启服务器 → 验证新增/编辑选品是否正常
第二批（P1）：统一弹窗方案 → 统一佣金计算
第三批（P2）：加分页/缓存 → 加索引 → 优化 backdrop
第四批（P3）：改名 escape → 规则配置化 → 加输入校验
```

---

## README 更新要点

1. 补充"弹窗操作说明"（编辑选品、字段显示均用 ESC 或点击遮罩关闭）
2. 补充"利润计算说明"（佣金率 12%/17% 的触发条件）
3. 补充"数据库索引说明"（新增索引提升查询性能）
4. 补充"开发中注意事项"（前端硬刷新 Ctrl+Shift+R）

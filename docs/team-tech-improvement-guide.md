# Ozon Profit Hub 团队技术提升指导方案

> 基于对现有代码库的全面审查，从架构、安全、代码质量、前端工程化四个维度给出可执行的改进路线

---

## 一、现状诊断：代码库健康度评估

### 做得好的地方

1. **零依赖策略** — 不依赖 Express/Koa 等框架，直接用 Node.js 原生 http 模块，启动快、攻击面小，对内网工具来说是合理选择
2. **SQLite + WAL 模式** — 单文件数据库配 WAL 日志，对小型业务系统来说是正确选择
3. **数据库迁移机制** — `addColumn()` + `migrateDb()` 模式，虽简陋但有意识做版本演进
4. **业务逻辑完整** — 从选品、采购、入库、出库到利润核算的完整闭环已经跑通

### 核心问题清单

| 严重度 | 问题 | 影响 |
|--------|------|------|
| P0 | Session 存内存，重启丢失 | 服务重启所有用户需要重新登录 |
| P0 | 密码哈希用 SHA-256 无迭代 | 暴力破解成本极低 |
| P1 | services.js 2100行巨型文件 | 无法维护、无法测试、认知负担过重 |
| P1 | 前端 app.js 单文件 SPA | 同上，几千行无模块化 |
| P1 | 无输入校验层 | SQL 注入风险低（参数化查询）但业务校验缺失 |
| P2 | 无日志系统 | 问题排查靠 console.error |
| P2 | 无错误码体系 | 前端只能靠字符串匹配判断错误类型 |
| P2 | 无测试覆盖 | 重构信心为零 |

---

## 二、架构改进路线图

### 阶段一：基础加固（1-2周）

#### 1.1 Session 持久化

当前 `sessions = new Map()` 存内存，重启全丢。改为 SQLite 存储：

```javascript
// db.js 中新建 sessions 表
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

// server.js 改造
function createSession(personId, name, role, username) {
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7天
  db.prepare(`
    INSERT INTO sessions (token, person_id, name, role, username, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, personId, name, role, username, now, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
  ).get(token, Date.now());
  if (!session) return null;
  return { personId: session.person_id, name: session.name, role: session.role, username: session.username };
}
```

#### 1.2 密码哈希升级

当前 `SHA-256(salt + password)` 无迭代，GPU 一秒可试数十亿次。改用 Node.js 内置的 `scrypt`：

```javascript
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password, storedHash) {
  if (storedHash.startsWith("scrypt:")) {
    const [, , , , saltHex, hashHex] = storedHash.split(":");
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(derived, expected);
  }
  // 兼容旧 SHA-256 格式，登录成功后自动升级
  const [salt, hash] = storedHash.split(":");
  const inputHash = createHash("sha256").update(salt + password).digest("hex");
  return inputHash === hash;
}
```

登录时检测到旧格式哈希，自动用新格式重写，用户无感知迁移。

#### 1.3 请求日志中间件

```javascript
// 在 server.js 的 createServer 回调最前面加
function logRequest(req, res, duration) {
  const session = req._session;
  const user = session ? session.username : "anonymous";
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms user=${user}`
  );
}

// 在路由处理前后计时
const start = Date.now();
// ... 处理逻辑 ...
logRequest(req, res, Date.now() - start);
```

### 阶段二：代码拆分（2-3周）

#### 2.1 后端 services.js 拆分

当前 2100+ 行的 services.js 是最大的维护障碍。按业务域拆分：

```
src/
  services/
    products.js      — 产品 CRUD + 选品计价
    orders.js        — 订单同步 + 利润计算
    inventory.js     — 入库/出库/库存变动
    procurement.js   — 采购请求/采购单/合并
    people.js        — 人员管理
    shops.js         — 店铺管理
    online-products.js — 在线商品同步
    exchange-rates.js — 汇率管理
    shared.js        — all()/get()/nullable() 等公共工具
```

拆分原则：
- 每个文件 200-400 行
- 共享的 `all()`, `get()`, `nullable()` 等提到 `shared.js`
- 有依赖关系的函数通过参数注入，不循环引用
- 路由注册保持 server.js 中不变，只 import 来源变了

```javascript
// 示例：products.js
import { all, get, nullable } from "./shared.js";
import { db } from "../db.js";
import { calculateSelectionPricing } from "../celRates.js";

export function products() {
  syncOutboundForOpenOrders(); // 这个会有循环依赖，需要抽到 events 模块
  const rows = all(`SELECT ...`);
  return rows.map((row) => ({ ...row, pricing: calculateSelectionPricing(row) }));
}

export function createProduct(body) { ... }
export function updateProduct(id, body) { ... }
export function deleteProduct(id) { ... }
```

#### 2.2 前端模块化（不改框架）

不引入打包工具，用原生 ES Module 拆分：

```html
<!-- index.html -->
<script type="module" src="/app.js"></script>
```

```javascript
// app.js — 入口，只做初始化和路由
import { state } from "./state.js";
import { bindNavigation, showView } from "./navigation.js";
import { loadAll } from "./api.js";
import { renderSelection } from "./views/selection.js";
import { renderOrders } from "./views/orders.js";
// ...

document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  const isAuth = await checkAuthSession();
  if (isAuth) {
    await loadAll();
    restoreCurrentView();
  }
});
```

```
public/
  app.js              — 入口
  state.js            — 全局状态
  api.js              — 统一 API 调用层
  utils.js            — money(), date(), image() 等
  views/
    selection.js      — 选品页渲染和交互
    orders.js         — 订单页
    stock.js          — 库存页
    procurement.js    — 采购页
    config.js         — 配置页
    profit.js         — 利润页
  components/
    table.js          — 通用表格渲染
    dialog.js         — 对话框
    form.js           — 表单处理
```

### 阶段三：工程化提升（3-4周）

#### 3.1 API 调用层标准化

当前前端散落着各种 `fetch()` 调用，错误处理不统一。抽一个 `api.js`：

```javascript
// public/api.js
const API_BASE = "";

export async function api(path, options = {}) {
  const token = localStorage.getItem("authToken");
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers
  };

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    // Token 过期，跳转登录
    localStorage.removeItem("authToken");
    location.reload();
    throw new Error("登录已过期");
  }

  const data = await response.json();

  if (!response.ok) {
    // 统一错误格式
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.code = data.code || response.status;
    error.status = response.status;
    throw error;
  }

  return data;
}

// 便捷方法
export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
export const del = (path) => api(path, { method: "DELETE" });
```

#### 3.2 后端错误码体系

```javascript
// src/errors.js
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  // 通用
  NOT_FOUND: (resource) => new AppError("NOT_FOUND", `${resource}不存在`, 404),
  UNAUTHORIZED: () => new AppError("UNAUTHORIZED", "未登录或登录已过期", 401),
  FORBIDDEN: () => new AppError("FORBIDDEN", "权限不足", 403),
  VALIDATION: (msg) => new AppError("VALIDATION", msg, 422),

  // 业务
  SKU_ALREADY_BOUND: () => new AppError("SKU_ALREADY_BOUND", "该SKU已绑定产品"),
  INSUFFICIENT_STOCK: (name) => new AppError("INSUFFICIENT_STOCK", `${name}库存不足`),
  INVALID_STATUS_TRANSITION: (from, to) => new AppError("INVALID_STATUS", `不能从 ${from} 变为 ${to}`),
};

// server.js 统一错误处理
server.on("request", async (req, res) => {
  try {
    // ... 路由处理
  } catch (error) {
    if (error instanceof AppError) {
      json(res, { error: error.message, code: error.code }, error.status);
    } else {
      console.error(error);
      json(res, { error: "服务器内部错误", code: "INTERNAL" }, 500);
    }
  }
});
```

#### 3.3 输入校验层

当前唯一校验是 `if (!name) throw new Error("Product name is required")`。用轻量 schema 校验：

```javascript
// src/validate.js
export function validate(schema, data) {
  const errors = [];
  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];
    for (const rule of rules) {
      if (rule === "required" && (!value && value !== 0)) {
        errors.push({ field, message: `${field} 是必填项` });
      }
      if (rule === "number" && value !== undefined && !Number.isFinite(Number(value))) {
        errors.push({ field, message: `${field} 必须是数字` });
      }
      if (rule === "positive" && Number(value) <= 0) {
        errors.push({ field, message: `${field} 必须大于0` });
      }
    }
  }
  if (errors.length) throw Errors.VALIDATION(errors.map((e) => e.message).join("; "));
}

// 使用
export function createProduct(body) {
  validate({
    name: ["required"],
    purchase_cost: ["number", "positive"],
    package_weight_g: ["number"],
  }, body);
  // ...
}
```

### 阶段四：质量保障（持续进行）

#### 4.1 测试金字塔

对当前项目来说，最值得投资的是集成测试：

```javascript
// tests/api.test.js — 用 Node.js 内置 test runner
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("产品 API", () => {
  beforeEach(() => {
    // 用内存数据库，每次测试全新状态
  });

  it("创建产品需要 name", async () => {
    const res = await fetch("http://localhost:8787/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.match(data.error, /必填/);
  });

  it("正常创建产品", async () => {
    const res = await fetch("http://localhost:8787/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "测试产品", purchase_cost: 10 })
    });
    assert.equal(res.status, 200);
  });
});
```

#### 4.2 数据库备份增强

当前 backup-data.bat 做的是文件拷贝，但 SQLite 在写入时拷贝可能拿到不一致的状态。改用 SQLite 内置备份 API：

```javascript
// scripts/backup.js
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const sourcePath = process.argv[2] || "./data/ozon-profit-hub.sqlite";
const backupDir = process.argv[3] || "./backups";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `ozon-profit-hub-${timestamp}.sqlite`);

fs.mkdirSync(backupDir, { recursive: true });

const source = new DatabaseSync(sourcePath, { readOnly: true });
const backup = new DatabaseSync(backupPath);

source.backup(backup); // SQLite 内置的在线备份，保证一致性

backup.close();
source.close();

console.log(`Backup created: ${backupPath}`);
```

---

## 三、编码规范与最佳实践

### 3.1 命名规范

| 类别 | 当前 | 建议 | 理由 |
|------|------|------|------|
| 数据库列 | snake_case | snake_case | 保持，SQL 惯例 |
| JS 变量/函数 | camelCase | camelCase | 保持，JS 惯例 |
| JS 文件 | kebab-case 或 camelCase | kebab-case | 统一 |
| API 路径 | kebab-case | kebab-case | 保持 |
| 常量 | OZON_RFBS_RULES | 保持大写 | 全大写表示不可变配置 |

### 3.2 函数设计原则

**当前问题**：很多函数做了太多事。`syncOutboundForOpenOrders()` 一个函数 130 行，混合了查询、判断、插入、更新。

**改进**：

```javascript
// 拆成清晰的步骤函数
function syncOutboundForOpenOrders() {
  cancelOutboundForCancelledOrders();
  createOutboundForUnprocessedOrders();
}

function cancelOutboundForCancelledOrders() {
  const cancelled = findCancelledOrderItems();
  for (const item of cancelled) {
    markOutboundCancelled(item);
    cancelInventoryMovement(item);
    rebuildInventoryCurrentForProduct(item.product_id);
  }
}

function createOutboundForUnprocessedOrders() {
  const unprocessed = findUnprocessedOrderItems();
  for (const item of unprocessed) {
    if (!item.mapping_id) { recordException(item, "OUTBOUND_UNBOUND_SKU"); continue; }
    ensureInventoryMovement(item);
    ensureOutboundRecord(item);
    resolveException(item);
  }
}
```

### 3.3 事务使用规范

当前事务使用不一致：`mergeProcurementRequests` 有事务，但很多多步操作没有。

**规则**：凡是涉及 2 步以上写操作的业务方法，必须包裹事务：

```javascript
export function bindOnlineProduct(body) {
  // 当前代码：3个写操作没有事务，中间失败会导致数据不一致
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE online_products SET product_id = ? WHERE id = ?").run(...);
    if (existingMapping) {
      db.prepare("UPDATE sku_mappings SET ... WHERE id = ?").run(...);
    } else {
      db.prepare("INSERT INTO sku_mappings ...").run(...);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // 事务后做非关键操作
  recalculateOrderItemsForMapping(mapping.id);
  syncOutboundForOpenOrders();
}
```

### 3.4 错误处理三原则

1. **不要吞错误** — 当前 `catch {}` 空块要消除（如 `parseJson`），至少 `console.debug`
2. **业务错误 vs 系统错误** — `AppError` 给用户看，`Error` 只记日志
3. **失败快速反馈** — 函数开头校验参数，不合法立即抛出，别写到一半才失败

```javascript
// 好的做法
export function createInboundRecord(body) {
  const quantity = Number(body.quantity || 0);
  if (quantity <= 0) throw Errors.VALIDATION("入库数量必须大于0");
  const product = get("SELECT id FROM products WHERE id = ? AND active = 1", [body.product_id]);
  if (!product) throw Errors.NOT_FOUND("产品");
  // ... 继续业务逻辑
}
```

---

## 四、前端改进指南

### 4.1 当前前端架构问题

1. **全局 state 巨型对象** — 所有页面数据混在一起
2. **DOM 操作命令式** — 大量 `innerHTML` 拼接，XSS 风险 + 难以维护
3. **事件绑定散乱** — `bindXxxControls()` 函数十几个，每个都在 document 上绑事件
4. **无组件复用** — 表格、对话框、表单每个页面各写一遍

### 4.2 不改框架的渐进改进

#### 统一表格渲染器

当前每个页面的表格渲染逻辑都是手写的 HTML 拼接。抽一个通用组件：

```javascript
// public/components/table.js
export function renderTable({ columns, data, containerId, onRowAction }) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const headerHtml = `<tr>${columns.map((col) => `<th>${col.label}</th>`).join("")}</tr>`;
  const bodyHtml = data.map((row, index) =>
    `<tr data-row-index="${index}">${columns.map((col) => `<td>${col.render(row)}</td>`).join("")}</tr>`
  ).join("");

  container.innerHTML = `<table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table>`;

  if (onRowAction) {
    container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const rowIndex = Number(btn.closest("tr")?.dataset.rowIndex);
      const row = data[rowIndex];
      onRowAction(btn.dataset.action, row, rowIndex);
    });
  }
}
```

#### XSS 防护

当前大量 `innerHTML` 直接拼接用户数据（如产品名称、备注）。至少需要一个转义函数：

```javascript
// public/utils.js
export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 使用：所有用户输入渲染前都要转义
function strong(title, subtitle) {
  return `<strong>${escapeHtml(title)}</strong>${subtitle ? `<br><small>${escapeHtml(subtitle)}</small>` : ""}`;
}
```

### 4.3 状态管理简化

不引入状态管理库，但把状态和渲染分离：

```javascript
// public/state.js — 只管数据，不管渲染
export const state = {
  currentView: "selection",
  // ...
};

export function setState(updates) {
  Object.assign(state, updates);
  // 发布-订阅：通知注册的渲染器
  for (const [key, renderers] of Object.entries(subscribers)) {
    if (key in updates) renderers.forEach((fn) => fn(state));
  }
}

const subscribers = {};
export function subscribe(keys, renderer) {
  for (const key of keys) {
    if (!subscribers[key]) subscribers[key] = [];
    subscribers[key].push(renderer);
  }
}
```

---

## 五、安全加固清单

| 项目 | 当前状态 | 改进措施 | 优先级 |
|------|---------|---------|--------|
| 密码哈希 | SHA-256 无迭代 | scrypt 或 bcrypt | P0 |
| Session | 内存 Map | SQLite 持久化 | P0 |
| CORS | 无限制 | 限制局域网来源 | P1 |
| 输入校验 | 稀疏 | schema 校验层 | P1 |
| XSS | innerHTML 无转义 | 统一 escapeHtml | P1 |
| API Key 存储 | 明文 api_key_hint | 环境变量 + 加密存储 | P1 |
| 速率限制 | 无 | 登录接口加限制 | P2 |
| HTTPS | 无 | 局域网可暂缓，公网必须 | P2 |

---

## 六、团队技术成长建议

### 6.1 代码评审清单

每次提交 PR / 合并代码前，过一遍这个清单：

- [ ] 函数是否超过 40 行？超过则拆分
- [ ] 是否有 2 步以上写操作不在事务中？
- [ ] 用户输入渲染前是否调了 `escapeHtml()`？
- [ ] 新 API 是否有输入校验？
- [ ] 错误是否用了 `AppError` 而非裸 `Error`？
- [ ] 前端 API 调用是否走统一的 `api()` 函数？
- [ ] SQL 是否用了参数化查询（`?` 占位符）？
- [ ] 有没有 `console.log` 调试代码残留？

### 6.2 渐进式重构节奏

**不要试图一次重写**。正确的节奏是：

1. 每次修 bug 或加新功能时，顺手改善附近的代码
2. "童子军原则"：让代码比你发现时更好一点
3. 优先改 P0 安全问题，其余按改动频率排序 — 改得越多的文件越值得重构
4. 拆分 services.js 时，先抽最独立的模块（如 exchange-rates、people、shops），再处理有依赖的

### 6.3 推荐学习资源

| 主题 | 资源 | 理由 |
|------|------|------|
| Node.js 原生能力 | Node.js 官方文档 > API Reference | 项目零依赖，必须精通原生 API |
| SQLite 最佳实践 | SQLite 官方文档 > Write-Ahead Logging | 理解 WAL、事务、并发 |
| 重构技术 | 《重构：改善既有代码的设计》Martin Fowler | 渐进式重构方法论 |
| 安全基础 | OWASP Top 10 | Web 安全入门必读 |
| JS 模块化 | MDN > JavaScript modules | 理解 ES Module 原生用法 |

---

## 七、执行优先级总结

```
第1周：Session 持久化 + 密码哈希升级 + XSS 防护
       ↓
第2周：API 统一调用层 + 错误码体系 + 输入校验
       ↓
第3周：services.js 拆分（products / orders / inventory）
       ↓
第4周：前端模块化（state.js + api.js + utils.js）
       ↓
持续：测试覆盖 + 代码评审 + 按需重构
```

每周投入约 8-12 小时（1.5-2 个工作日），4 周后代码库健康度会有质的飞跃。

---

*本文档由资深开发工程师审查代码库后编写，基于项目实际情况给出针对性建议，不追求大而全，只追求可执行、有收益。*

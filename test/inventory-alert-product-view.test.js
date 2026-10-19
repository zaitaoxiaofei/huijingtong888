import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { applyStockAlertQuery, completedBeijingSalesWindow } from "../src/services/inventory-alert-utils.js";

const page = readFileSync(new URL("../frontend/admin/views/inventory/InventoryAlertsPage.vue", import.meta.url), "utf8");
const requestDialog = readFileSync(new URL("../frontend/admin/components/procurement/WarehouseProcurementRequestDialog.vue", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const productDialog = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");

function product(productId, sales7, available, leadDays, incoming = 0) {
  return {
    product_id: productId,
    product_name: `库存 ${productId}`,
    inventory_number: `1-${productId}`,
    physical_stock: available + 2,
    available_stock: available,
    incoming_stock: incoming,
    recent_7d_qty: sales7,
    recent_15d_qty: sales7 + 2,
    production_lead_days: leadDays
  };
}

test("库存预警以库存为一行，按七日销量降序并计算生产周期阈值", () => {
  const payload = applyStockAlertQuery([
    product(1, 70, 69, 7),
    product(2, 14, 0, 10, 20),
    product(3, 35, 200, 3),
    product(4, 28, 8, null)
  ], { mode: "inventory-alerts", paged: "1", pageSize: 2 });

  assert.deepEqual(payload.rows.map((row) => row.product_id), [1, 3]);
  assert.equal(payload.total, 4);
  assert.equal(payload.rows[0].alert_quantity, 70);
  assert.equal(payload.rows[0].suggested_purchase_qty, 1);
  assert.equal(payload.rows[0].alert_type, "low_stock");
  assert.equal(payload.rows[0].physical_stock, 71);
  assert.equal(payload.meta.out_of_stock, 1);
  assert.equal(payload.meta.low_stock, 1);
  assert.equal(payload.meta.in_transit, 1);
  assert.equal(payload.meta.healthy, 1);
  assert.equal(payload.meta.lead_time_missing, 1);
});

test("断货与采购在途状态可重叠，在途足额时不再建议采购", () => {
  const rows = [product(1, 14, 0, 10, 20), product(2, 14, 1, 10, 0)];
  const transit = applyStockAlertQuery(rows, { mode: "inventory-alerts", alertType: "in_transit" });
  assert.deepEqual(transit.rows.map((row) => row.product_id), [1]);
  assert.equal(transit.rows[0].alert_type, "out_of_stock");
  assert.equal(transit.rows[0].suggested_purchase_qty, 0);
  assert.deepEqual(applyStockAlertQuery(rows, { mode: "inventory-alerts", alertType: "low_stock" }).rows.map((row) => row.product_id), [2]);
});

test("七日与十五日销量窗口只包含昨天及之前的完整北京时间日", () => {
  const window = completedBeijingSalesWindow(new Date("2026-10-18T16:30:00.000Z"));
  assert.deepEqual(window, { from15: "2026-10-04", from7: "2026-10-12", through: "2026-10-18" });
  assert.match(service, /profitOrderedAtUtcRangeMysql\("o", salesWindow\.from15, salesWindow\.through\)/);
  assert.match(service, /\[salesWindow\.from7, \.+\(tenantPk/);
});

test("页面默认库存视角并保留 SKU 切换、状态筛选、主图预览与采购预填", () => {
  assert.match(page, /view: "inventory"/);
  assert.match(page, /changeView\('sku'\)/);
  assert.match(page, /inventoryAlertFilters/);
  assert.match(page, /<ProductImagePreview :src="row\.image_url" :preview-list="row\.image_url \? \[row\.image_url\] : \[\]" size="portrait"/);
  assert.match(page, /suggested_purchase_qty: Math\.max\(1, Number\(row\.suggested_purchase_qty \|\| 0\)\)/);
  assert.match(page, /:disabled="row\.suggested_purchase_qty <= 0"/);
  assert.match(requestDialog, /quantity: Math\.max\(1, Math\.floor\(Number\(product\.suggested_purchase_qty \|\| 1\)\)\)/);
});

test("库存预警按企业隔离接口、缓存与持久快照，库存视角跳过旧快照", () => {
  assert.match(server, /services\.stockAlerts\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
  assert.match(service, /const cacheScope = tenantPk \|\| "admin"/);
  assert.match(service, /const snapshotKey = `alerts-v5-\$\{cacheScope\}`/);
  assert.match(service, /stock-alerts:fbp-base:v2:\$\{cacheScope\}/);
  const inventoryBranch = service.indexOf('if (mode === "inventory-alerts")', service.indexOf("export async function stockAlertsMysql"));
  const snapshotRead = service.indexOf("const persistedBase = forceRefresh ? null", inventoryBranch);
  assert.ok(inventoryBranch > 0 && inventoryBranch < snapshotRead);
  assert.match(service.slice(inventoryBranch, snapshotRead), /stockedInventoryAlertProductsMysql\(tenantPk\)/);
  assert.match(service, /AND im\.tenant_id = \?/);
  assert.match(service, /AND cp\.tenant_id = \?/);
});

test("库存销量查询计入组合配件，并将企业与完整日边界参数送入 SQL", async () => {
  const queries = [];
  const context = vm.createContext({
    completedBeijingSalesWindow: () => ({ from15: "2026-10-04", from7: "2026-10-12", through: "2026-10-18" }),
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?", params: ["from-utc", "to-utc"] }),
    chinaDateSqlMysql: (field) => `DATE(${field})`,
    localStockLocationPredicateMysql: (alias) => `${alias}.stock_location = 'LOCAL'`,
    compactProductImageUrlForListMysql: (row) => row.image_url,
    mysqlQuery: async (sql, params) => { queries.push({ sql, params }); return []; }
  });
  const start = service.indexOf("async function inventoryAlertProductSalesMysql");
  const end = service.indexOf("export async function stockAlertsMysql", start);
  vm.runInContext(service.slice(start, end), context);
  await context.inventoryAlertProductSalesMysql(12);
  await context.stockedInventoryAlertProductsMysql(12);
  await context.purchasedInventoryInTransitMysql(12);
  assert.match(queries[0].sql, /oi\.quantity \* COALESCE\(ri\.quantity, pc\.quantity, 1\)/);
  assert.match(queries[0].sql, /JOIN products cp ON cp\.id = CASE WHEN recipe\.id IS NOT NULL THEN ri\.product_id/);
  assert.equal((queries[0].sql.match(/\?/g) || []).length, queries[0].params.length);
  assert.equal(queries[0].params[0], "2026-10-12");
  assert.equal(queries[0].params.at(-2), "from-utc");
  assert.equal(queries[0].params.at(-1), "to-utc");
  assert.match(queries[1].sql, /im\.quantity_delta > 0/);
  assert.equal(queries[1].params.length, 2);
  assert.match(queries[2].sql, /ir\.status = 'pending_arrival'/);
  assert.match(queries[2].sql, /po\.purchased_at IS NOT NULL/);
});

test("生产周期只接受固定选项，旧库存保持待设置且创建编辑均写入字段", () => {
  const start = service.indexOf("function normalizeProductionLeadDaysMysql");
  const end = service.indexOf("function normalizeProductComponentItemsMysql", start);
  const context = vm.createContext({});
  vm.runInContext(service.slice(start, end), context);
  assert.equal(context.normalizeProductionLeadDaysMysql(null), null);
  assert.equal(context.normalizeProductionLeadDaysMysql(""), null);
  for (const days of [3, 5, 7, 10, 15, 30]) assert.equal(context.normalizeProductionLeadDaysMysql(days), days);
  assert.throws(() => context.normalizeProductionLeadDaysMysql(14), /生产周期/);
  assert.match(schema, /production_lead_days INT NULL/);
  assert.match(productDialog, /PRODUCTION_LEAD_DAY_OPTIONS = \[3, 5, 7, 10, 15, 30\]/);
  assert.match(service, /normalizeProductionLeadDaysMysql\(body\.production_lead_days\)/);
  assert.match(service, /normalizeProductionLeadDaysMysql\(body\.production_lead_days === undefined \? existing\.production_lead_days : body\.production_lead_days\)/);
});

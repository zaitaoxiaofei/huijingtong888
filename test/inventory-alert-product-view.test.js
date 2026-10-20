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

function product(productId, sales7, available, leadDays, incoming = 0, sales30 = sales7) {
  return {
    product_id: productId,
    product_name: `库存 ${productId}`,
    inventory_number: `1-${productId}`,
    physical_stock: available + 2,
    available_stock: available,
    incoming_stock: incoming,
    recent_7d_qty: sales7,
    recent_15d_qty: sales7 + 2,
    recent_30d_qty: sales30,
    production_lead_days: leadDays
  };
}

test("库存预警以库存为一行，按近三十日销量降序并计算生产周期阈值", () => {
  const payload = applyStockAlertQuery([
    product(1, 70, 69, 7, 0, 70),
    product(2, 14, 0, 10, 20, 20),
    product(3, 35, 200, 3, 0, 90),
    product(4, 28, 8, null, 0, 30)
  ], { mode: "inventory-alerts", paged: "1", pageSize: 2 });

  assert.deepEqual(payload.rows.map((row) => row.product_id), [3, 1]);
  assert.equal(payload.total, 4);
  assert.equal(payload.rows[1].alert_quantity, 90);
  assert.equal(payload.rows[1].warehouse_logistics_days, 2);
  assert.equal(payload.rows[1].suggested_purchase_qty, 21);
  assert.equal(payload.rows[1].alert_type, "low_stock");
  assert.equal(payload.rows[1].physical_stock, 71);
  assert.equal(payload.meta.out_of_stock, 1);
  assert.equal(payload.meta.low_stock, 2);
  assert.equal(payload.meta.in_transit, 1);
  assert.equal(payload.meta.healthy, 1);
  assert.equal(payload.meta.lead_time_missing, 0);
  assert.equal(applyStockAlertQuery([product(4, 28, 8, null)], { mode: "inventory-alerts" }).rows[0].production_lead_days, 7);
});

test("断货与采购在途状态可重叠，在途足额时不再建议采购", () => {
  const rows = [product(1, 14, 0, 10, 24), product(2, 14, 1, 10, 0)];
  const transit = applyStockAlertQuery(rows, { mode: "inventory-alerts", alertType: "in_transit" });
  assert.deepEqual(transit.rows.map((row) => row.product_id), [1]);
  assert.equal(transit.rows[0].alert_type, "out_of_stock");
  assert.equal(transit.rows[0].suggested_purchase_qty, 0);
  assert.deepEqual(applyStockAlertQuery(rows, { mode: "inventory-alerts", alertType: "low_stock" }).rows.map((row) => row.product_id), [2]);
});

test("七日、十五日与三十日销量窗口只包含昨天及之前的完整北京时间日", () => {
  const window = completedBeijingSalesWindow(new Date("2026-10-18T16:30:00.000Z"));
  assert.deepEqual(window, { from30: "2026-09-19", from15: "2026-10-04", from7: "2026-10-12", through: "2026-10-18" });
  assert.match(service, /profitOrderedAtUtcRangeMysql\("o", salesWindow\.from30, salesWindow\.through\)/);
  assert.ok(service.includes("[salesWindow.from7, salesWindow.from15, ...Array(7).fill(tenantPk), ...range.params]"));
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
  assert.match(service.slice(inventoryBranch, snapshotRead), /stockedInventoryAlertProductsMysql\(inventoryTenantPk, inventoryDefaultTenant\)/);
  assert.match(service, /const inventoryTenantPk = await resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(service, /stockedInventoryAlertProductsMysql\(inventoryTenantPk, inventoryDefaultTenant\)/);
  assert.match(service, /tenantShopPredicateMysql\("im", defaultTenant\)/);
  assert.match(service, /tenantShopPredicateMysql\("cp", defaultTenant\)/);
});

test("库存销量查询计入组合配件，并将企业与完整日边界参数送入 SQL", async () => {
  const queries = [];
  const context = vm.createContext({
    completedBeijingSalesWindow: () => ({ from30: "2026-09-19", from15: "2026-10-04", from7: "2026-10-12", through: "2026-10-18" }),
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?", params: ["from-utc", "to-utc"] }),
    chinaDateSqlMysql: (field) => `DATE(${field})`,
    localStockLocationPredicateMysql: (alias) => `${alias}.stock_location = 'LOCAL'`,
    compactProductImageUrlForListMysql: (row) => row.image_url,
    mysqlQuery: async (sql, params) => { queries.push({ sql, params }); return []; }
  });
  const start = service.indexOf("async function inventoryAlertProductSalesMysql");
  const end = service.indexOf("export async function updateInventoryProductLeadTimesMysql", start);
  const predicateStart = service.indexOf("function tenantShopPredicateMysql");
  const predicateEnd = service.indexOf("async function activeShopForTenantMysql", predicateStart);
  vm.runInContext(service.slice(predicateStart, predicateEnd), context);
  vm.runInContext(service.slice(start, end), context);
  await context.inventoryAlertProductSalesMysql(12, true);
  await context.stockedInventoryAlertProductsMysql(12, true);
  await context.purchasedInventoryInTransitMysql(12, true);
  await context.inventoryAlertProductSkusMysql([1, 2], 12, true);
  assert.match(queries[0].sql, /oi\.quantity \* COALESCE\(ri\.quantity, pc\.quantity, 1\)/);
  assert.match(queries[0].sql, /JOIN products cp ON cp\.id = CASE WHEN recipe\.id IS NOT NULL THEN ri\.product_id/);
  assert.equal((queries[0].sql.match(/\?/g) || []).length, queries[0].params.length);
  assert.equal(queries[0].params[0], "2026-10-12");
  assert.equal(queries[0].params[1], "2026-10-04");
  assert.equal(queries[0].params.at(-2), "from-utc");
  assert.equal(queries[0].params.at(-1), "to-utc");
  for (const alias of ["sh", "direct_mapping", "fallback_source", "sm", "p", "pc", "cp"]) {
    assert.match(queries[0].sql, new RegExp(`${alias}\\.tenant_id = \\? OR ${alias}\\.tenant_id IS NULL`));
  }
  assert.match(queries[1].sql, /im\.quantity_delta > 0/);
  assert.equal(queries[1].params.length, 2);
  assert.match(queries[1].sql, /p\.tenant_id = \? OR p\.tenant_id IS NULL/);
  assert.match(queries[1].sql, /im\.tenant_id = \? OR im\.tenant_id IS NULL/);
  assert.match(queries[2].sql, /ir\.status = 'pending_arrival'/);
  assert.match(queries[2].sql, /po\.purchased_at IS NOT NULL/);
  assert.match(queries[2].sql, /pr\.tenant_id = \? OR pr\.tenant_id IS NULL/);
  assert.match(queries[3].sql, /JOIN products cp ON cp\.id = CASE WHEN recipe\.id IS NOT NULL THEN ri\.product_id/);
  assert.match(queries[3].sql, /sm\.tenant_id = \? OR sm\.tenant_id IS NULL/);
  assert.match(queries[3].sql, /cp\.id IN \(\?,\?\)/);
  assert.equal((queries[3].sql.match(/\?/g) || []).length, queries[3].params.length);
  await context.inventoryAlertProductSalesMysql(44, false);
  assert.doesNotMatch(queries[4].sql, /tenant_id IS NULL/);
  assert.deepEqual(Array.from(queries[4].params.slice(2, 9)), Array(7).fill(44));
  await context.inventoryAlertProductSkusMysql([1, 2], 44, false);
  assert.match(queries[5].sql, /sm\.tenant_id = \?/);
  assert.doesNotMatch(queries[5].sql, /tenant_id IS NULL/);
  assert.deepEqual(Array.from(queries[5].params.slice(0, 5)), Array(5).fill(44));
  assert.equal((queries[5].sql.match(/\?/g) || []).length, queries[5].params.length);
});

test("默认企业库存视角解析真实企业 PK，聚合同库存的多店铺 SKU 且避免重复", async () => {
  const calls = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureProductNamingSchemaMysql: async () => {},
    ensureOzonStockStorageSchemaMysql: async () => {},
    ensureStockLocationSchemaMysql: async () => {},
    ensureProfitAnalyticsSchemaMysql: async () => {},
    ensureSkuInventoryRecipeSchemaMysql: async () => {},
    ensureProductCompositionSchemaMysql: async () => {},
    mysqlSchemaColumnExists: async () => true,
    resolveShopTenantIdMysql: async (tenantId) => { calls.push(["resolve", tenantId]); return 4; },
    isDefaultShopTenantMysql: async (tenantPk) => { calls.push(["default", tenantPk]); return true; },
    stockedInventoryAlertProductsMysql: async (tenantPk, legacy) => { calls.push(["products", tenantPk, legacy]); return [{ product_id: 1, production_lead_days: 7 }]; },
    inventoryAlertProductSalesMysql: async (tenantPk, legacy) => { calls.push(["sales", tenantPk, legacy]); return [
      { product_id: 1, mapping_id: 10, shop_id: 2, shop_name: "甲店", ozon_sku: "SKU-A", recent_7d_qty: 2, recent_15d_qty: 3, recent_30d_qty: 5 },
      { product_id: 1, mapping_id: 20, shop_id: 3, shop_name: "乙店", ozon_sku: "SKU-B", recent_7d_qty: 1, recent_15d_qty: 2, recent_30d_qty: 10 },
      { product_id: 1, mapping_id: 40, shop_id: 3, shop_name: "乙店", ozon_sku: "SKU-D", recent_7d_qty: 0, recent_15d_qty: 1, recent_30d_qty: 1 }
    ]; },
    purchasedInventoryInTransitMysql: async (tenantPk, legacy) => { calls.push(["incoming", tenantPk, legacy]); return []; },
    orderProcurementCoverageMysql: async (options) => { calls.push(["availability", options]); return { product_availability: new Map([[1, { product_id: 1, physical_stock: 4, available_stock: 3 }]]) }; },
    inventoryAlertProductSkusMysql: async (ids, tenantPk, legacy, summaryOnly) => { calls.push(["skus", ids, tenantPk, legacy, summaryOnly]); return [
      { product_id: 1, mapping_id: 10, shop_id: 2, shop_name: "甲店", ozon_sku: "SKU-A" },
      { product_id: 1, mapping_id: 11, shop_id: 2, shop_name: "甲店", ozon_sku: "SKU-A" },
      { product_id: 1, mapping_id: 20, shop_id: 3, shop_name: "乙店", ozon_sku: "SKU-B" },
      { product_id: 1, mapping_id: 30, shop_id: 3, shop_name: "乙店", ozon_sku: "SKU-C" }
    ]; },
    getCachedMasterData: async (_, loader) => loader(),
    applyStockAlertQuery: (rows) => ({ rows, total: rows.length })
  });
  const start = service.indexOf("export async function stockAlertsMysql");
  const end = service.indexOf("async function loadFbpStockAlertBaseMysql", start);
  vm.runInContext(service.slice(start, end).replace("export ", ""), context);
  const { rows } = await context.stockAlertsMysql({ mode: "inventory-alerts" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["resolve", "admin"], ["default", 4],
    ["products", 4, true], ["sales", 4, true], ["incoming", 4, true],
    ["availability", { productIds: [1], tenantId: 4, includeLegacyTenantNull: true }],
    ["skus", [1], 4, true, true], ["skus", [1], 4, true, null]
  ]);
  assert.equal(rows[0].available_stock, 3);
  assert.equal(rows[0].recent_30d_qty, 16);
  assert.equal(rows[0].sku_count, 4);
  assert.equal(rows[0].shop_count, 2);
  assert.deepEqual(Array.from(rows[0].skus, (sku) => [sku.ozon_sku, sku.recent_30d_qty]), [["SKU-B", 10], ["SKU-A", 5], ["SKU-D", 1], ["SKU-C", 0]]);
});

test("超过 200 个库存只核算一次企业库存占用，SKU 搜索后只展开当前页完整关系", async () => {
  const calls = [];
  const products = Array.from({ length: 401 }, (_, index) => ({ product_id: index + 1, product_name: `库存 ${index + 1}`, production_lead_days: 7 }));
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureProductNamingSchemaMysql: async () => {},
    ensureOzonStockStorageSchemaMysql: async () => {},
    ensureStockLocationSchemaMysql: async () => {},
    ensureProfitAnalyticsSchemaMysql: async () => {},
    ensureSkuInventoryRecipeSchemaMysql: async () => {},
    ensureProductCompositionSchemaMysql: async () => {},
    mysqlSchemaColumnExists: async () => true,
    resolveShopTenantIdMysql: async () => 7,
    isDefaultShopTenantMysql: async () => false,
    stockedInventoryAlertProductsMysql: async () => products,
    inventoryAlertProductSalesMysql: async () => [],
    purchasedInventoryInTransitMysql: async () => [],
    orderProcurementCoverageMysql: async (options) => { calls.push(["coverage", options.productIds.length, options.tenantId]); return { product_availability: new Map() }; },
    inventoryAlertProductSkusMysql: async (ids, tenantPk, legacy, summaryOnly) => {
      calls.push(["skus", ids.length, tenantPk, legacy, summaryOnly]);
      return ids.map((id) => ({ product_id: id, mapping_id: id, shop_id: 11, shop_name: "甲店", ozon_sku: `SKU-${id}`, offer_id: `OFFER-${id}` }));
    },
    getCachedMasterData: async (_, loader) => loader(),
    applyStockAlertQuery
  });
  const start = service.indexOf("export async function stockAlertsMysql");
  const end = service.indexOf("async function loadFbpStockAlertBaseMysql", start);
  vm.runInContext(service.slice(start, end).replace("export ", ""), context);
  const result = await context.stockAlertsMysql({ mode: "inventory-alerts", paged: "1", pageSize: 20, query: "SKU-401" }, "tenant-seven");
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].product_id, 401);
  assert.equal(result.rows[0].shop_count, 1);
  assert.equal(result.rows[0].sku_count, 1);
  assert.equal(result.rows[0].skus[0].mapping_id, 401);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["coverage", 401, 7], ["skus", 401, 7, false, true], ["skus", 1, 7, false, null]
  ]);
});

test("已解绑但仍有销量的 SKU 在库存预警明细中保留", async () => {
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureProductNamingSchemaMysql: async () => {},
    ensureOzonStockStorageSchemaMysql: async () => {},
    ensureStockLocationSchemaMysql: async () => {},
    ensureProfitAnalyticsSchemaMysql: async () => {},
    ensureSkuInventoryRecipeSchemaMysql: async () => {},
    ensureProductCompositionSchemaMysql: async () => {},
    mysqlSchemaColumnExists: async () => true,
    resolveShopTenantIdMysql: async () => 7,
    isDefaultShopTenantMysql: async () => false,
    stockedInventoryAlertProductsMysql: async () => [{ product_id: 1, product_name: "库存 1", production_lead_days: 7 }],
    inventoryAlertProductSalesMysql: async () => [{ product_id: 1, mapping_id: 5, shop_id: 11, shop_name: "甲店",
      ozon_sku: "HISTORY-SKU", recent_7d_qty: 2, recent_15d_qty: 3, recent_30d_qty: 4 }],
    purchasedInventoryInTransitMysql: async () => [],
    orderProcurementCoverageMysql: async () => ({ product_availability: new Map() }),
    inventoryAlertProductSkusMysql: async () => [],
    getCachedMasterData: async (_, loader) => loader(),
    applyStockAlertQuery
  });
  const start = service.indexOf("export async function stockAlertsMysql");
  const end = service.indexOf("async function loadFbpStockAlertBaseMysql", start);
  vm.runInContext(service.slice(start, end).replace("export ", ""), context);
  const result = await context.stockAlertsMysql({ mode: "inventory-alerts", paged: "1", query: "HISTORY-SKU" }, "tenant-seven");
  assert.equal(result.total, 1);
  assert.deepEqual(Array.from(result.rows[0].skus, (sku) => [sku.ozon_sku, sku.recent_30d_qty]), [["HISTORY-SKU", 4]]);
});

test("生产周期只接受固定选项，新建库存默认七天且旧库存预警按七天计算", () => {
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
  assert.ok(service.includes('normalizeProductionLeadDaysMysql(body.production_lead_days ?? (body.product_type === "selection" ? null : 7))'));
  assert.match(service, /normalizeProductionLeadDaysMysql\(body\.production_lead_days === undefined \? existing\.production_lead_days : body\.production_lead_days\)/);
});

test("旧 product_components 表升级时补齐 tenant_id 后才允许租户查询", async () => {
  const alters = [];
  const context = vm.createContext({
    productCompositionSchemaReadyMysql: false,
    mysqlExecute: async () => {},
    ensureMysqlColumns: async (table, statements) => { alters.push([table, ...statements]); }
  });
  const start = service.indexOf("async function ensureProductCompositionSchemaMysql");
  const end = service.indexOf("let productNamingSchemaReadyMysql", start);
  vm.runInContext(service.slice(start, end), context);
  await context.ensureProductCompositionSchemaMysql();
  assert.ok(alters.some(([table, ...statements]) => table === "product_components"
    && statements.some((sql) => sql.includes("ADD COLUMN tenant_id BIGINT UNSIGNED NULL"))));
});

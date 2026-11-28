import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import mysql from "mysql2/promise";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export async function procurementRequestsMysql("), source.indexOf("function workflowFbpCandidateMysql("))
  .replace(/^export /, "");

async function detailQuery(query = { grouped: "1" }) {
  const calls = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {}, resolveInventoryTenantScope: async () => ({ id: 42 }),
    requireProcurementTenantSchemaMysql: async () => {}, ensureProcurementRequestTimestampSchemaMysql: async () => {},
    ensureProcurementFlexibleRequestSchemaMysql: async () => {}, ensureStockLocationSchemaMysql: async () => {},
    ensureFbpTransferRecordsSchemaMysql: async () => {}, inventoryScopeCoverageMysql: async () => new Map(),
    readDemandCancellationEvents: async () => [], activeDemandCancellations: () => new Map(),
    procurementGroupedPageIdsMysql: async () => ({ productIds: [101, 102], page: 1, pageSize: 30, total: 2 }),
    inventoryTenantSql: (_scope, alias = "") => `${alias ? alias + "." : ""}tenant_id = 42`,
    workflowFbpCandidateMysql: () => "0", localStockLocationPredicateMysql: (alias = "") => `${alias ? alias + "." : ""}stock_location = 'LOCAL'`,
    fbpTransferInTransitWhereMysql: () => "1 = 1", chinaDateSqlMysql: value => `DATE(CONVERT_TZ(${value}, '+00:00', '+08:00'))`,
    buildOrderOutcomeSql: () => ({ cancelledPreFulfillment: "0", rejectedUnclaimed: "0", afterDeliveryReturn: "0" }),
    mysqlQuery: async (sql, params) => { calls.push({ sql, params }); return []; },
    createInventoryWorkflowService: () => ({ batch: async () => [] }), supplementLiveProcurementRows: rows => rows,
    groupProcurementRequestsMysql: rows => ({ rows }), filterProcurementRequestsMysql: rows => rows
  });
  vm.runInContext(`${body}\nglobalThis.subject = procurementRequestsMysql;`, context);
  await context.subject(query, 42);
  assert.equal(calls.length, 1);
  return calls[0];
}

test("grouped procurement binds both child aggregations to the selected parent page", async () => {
  const { sql, params } = await detailQuery();
  assert.equal((sql.match(/\?/g) || []).length, params.length, "every aggregate filter must bind its page IDs");
  assert.deepEqual(Array.from(params), Array.from({ length: 12 }, () => [101, 102]).flat());
  const childScopes = [...sql.matchAll(/AND (inventory_movements\.product_id|product_id) IN \(\s*SELECT page_component\.component_product_id FROM product_components page_component\s*WHERE page_component\.tenant_id = 42\s*AND page_component\.product_id IN \(\?, \?\)\s*\)/g)];
  assert.equal(childScopes.length, 2, "stock and incoming must select direct children rather than parent IDs");
  assert.deepEqual(childScopes.map(match => match[1]), ["inventory_movements.product_id", "product_id"]);
});

test("legacy ungrouped procurement retains all component aggregates without page bindings", async () => {
  const { sql, params } = await detailQuery({ paged: "1" });
  assert.deepEqual(Array.from(params), []);
  assert.doesNotMatch(sql, /page_component|\?/);
  assert.match(sql, /component_stock ON component_stock\.product_id = pc\.component_product_id/);
  assert.match(sql, /component_incoming ON component_incoming\.product_id = pc\.component_product_id/);
});

test("the sales lower bound preserves calendar boundaries, future rows, mappings and tenant filtering in MySQL", async t => {
  const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
  if (!socketPath) return t.skip("TENANT_TEST_MYSQL_SOCKET is required for isolated MySQL checks");
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  try {
    const [[server]] = await connection.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(server.disabled), 1, "this fixture may only use the isolated server with TCP disabled");
    // Keep the original OR-join compatibility path's date-window oracle. The
    // bounded mapping CTE is compared against the full baseline in the reader
    // and mapping-join MySQL suites, including both session time zones.
    const { sql } = await detailQuery({ paged: "1" });
    const aggregate = sql.match(/LEFT JOIN \(\s*(SELECT sales_mapping\.product_id,[\s\S]*?)\s*\) sales ON/)[1];
    const bound = "AND sales_order.ordered_at >= CONVERT_TZ(DATE_SUB(CURRENT_DATE, INTERVAL 29 DAY), '+08:00', '+00:00')";
    assert.ok(aggregate.includes(bound));
    const legacy = aggregate.replace(bound, "");
    const fixtures = `WITH shops AS (SELECT 1 id,42 tenant_id UNION ALL SELECT 2,99),
      dates AS (SELECT CONVERT_TZ(DATE_SUB(CURRENT_DATE, INTERVAL 29 DAY), '+08:00', '+00:00') cutoff),
      orders AS (
        SELECT 1 id,1 shop_id,'delivered' status,'' tracking_stage,cutoff-INTERVAL 1 SECOND ordered_at FROM dates
        UNION ALL SELECT 2,1,'delivered','',cutoff FROM dates
        UNION ALL SELECT 3,1,'delivered','',cutoff+INTERVAL 1 SECOND FROM dates
        UNION ALL SELECT 4,1,'delivered','',CONVERT_TZ(DATE_SUB(CURRENT_DATE,INTERVAL 6 DAY),'+08:00','+00:00')
        UNION ALL SELECT 5,1,'delivered','',CONVERT_TZ(CURRENT_DATE+INTERVAL 2 DAY,'+08:00','+00:00')
        UNION ALL SELECT 6,1,'cancelled','',cutoff FROM dates
        UNION ALL SELECT 7,1,'delivered',NULL,cutoff FROM dates
        UNION ALL SELECT 8,1,NULL,'',cutoff FROM dates
        UNION ALL SELECT 9,2,'delivered','',cutoff FROM dates
        UNION ALL SELECT 10,1,'delivered','cancelled',cutoff FROM dates
      ), order_items AS (
        SELECT id, id order_id,10 sku_mapping_id,'fixture-sku' ozon_sku,id quantity FROM orders
      ), sku_mappings AS (
        SELECT 10 id,1 shop_id,'fixture-sku' ozon_sku,101 product_id,1 active,42 tenant_id
        UNION ALL SELECT 11,1,'fixture-sku',102,1,42
        UNION ALL SELECT 12,2,'fixture-sku',101,1,42
      ) `;
    for (const zone of ["+00:00", "+08:00"]) {
      await connection.query("SET time_zone = ?", [zone]);
      await connection.query("SET timestamp = ?", [Date.parse("2026-11-26T18:05:00Z") / 1000]);
      const [before] = await connection.query(`${fixtures}${legacy} ORDER BY sales_mapping.product_id`);
      const [after] = await connection.query(`${fixtures}${aggregate} ORDER BY sales_mapping.product_id`);
      assert.deepEqual(after, before, `the original CURRENT_DATE semantics must remain intact in ${zone}`);
      assert.equal(after.length, 2, "both eligible mappings must still participate");
      assert.equal(Number(after[0].recent_30d_qty), 21, "include cutoff, future and null tracking; exclude old, cancelled and foreign rows");
    }
  } finally { await connection.end(); }
});

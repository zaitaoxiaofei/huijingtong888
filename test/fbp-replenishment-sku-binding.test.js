import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const bindingStart = service.indexOf("async function currentFbpSkuBindingMysql");
const createStart = service.indexOf("export async function createFbpReplenishmentOrdersMysql", bindingStart);
const createEnd = service.indexOf("export async function updateFbpReplenishmentOrderItemsMysql", createStart);
const reserveStart = service.indexOf("async function reserveFbpReplenishmentApprovedStockMysql");
const reserveEnd = service.indexOf("async function fbpReplenishmentCompletionStateMysql", reserveStart);

function createContext(overrides = {}) {
  const writes = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureFbpReplenishmentSchemaMysql: async () => {},
    resolveShopTenantIdMysql: async () => 7,
    isDefaultShopTenantMysql: async () => false,
    activeShopForTenantMysql: async () => ({ id: 5 }),
    tenantShopPredicateMysql: (alias) => `${alias}.tenant_id = ?`,
    todayDateKeyMysql: () => "2026-10-20",
    fbpReplenishmentOrderNo: () => "FBP-100",
    mysqlQuery: async () => [{ mapping_id: 22, product_id: 2, offer_id: "O-2", product_name: "库存2", inventory_id: "P-2" }],
    mysqlQueryOne: async () => null,
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return { insertId: 100 }; },
    ...overrides
  });
  vm.runInContext(service.slice(bindingStart, createEnd).replace("export ", ""), context);
  return { context, writes };
}

test("创建 FBP 备货单核对企业店铺及当前 SKU 绑定，拒绝过期库存 ID", async () => {
  const { context, writes } = createContext();
  await assert.rejects(() => context.createFbpReplenishmentOrdersMysql({ rows: [{
    shop_id: 5, ozon_sku: "S-1", mapping_id: 11, product_id: 1, requested_qty: 5
  }] }, 3, "tenant-seven"), /本地库存绑定.*已变化/);
  assert.equal(writes.length, 0, "绑定错误时不能先写草稿");
});

test("创建 FBP 备货单用服务端当前 SKU 绑定写入库存商品", async () => {
  const queries = [];
  const { context, writes } = createContext({
    mysqlQuery: async (sql, params) => {
      queries.push({ sql, params });
      return [{ mapping_id: 22, product_id: 2, offer_id: "O-2", product_name: "库存2", inventory_id: "P-2" }];
    }
  });
  const result = await context.createFbpReplenishmentOrdersMysql({ rows: [{
    shop_id: 5, ozon_sku: "S-1", mapping_id: 22, product_id: 2, offer_id: "old", requested_qty: 5
  }] }, 3, "tenant-seven");
  assert.equal(result.ok, true);
  assert.match(queries[0].sql, /sm\.shop_id = \? AND sm\.ozon_sku = \? AND sm\.active = 1/);
  assert.deepEqual(Array.from(queries[0].params), [7, 5, "S-1", 7]);
  const inserted = writes.find(({ sql }) => sql.includes("INSERT INTO fbp_replenishment_order_items"));
  assert.ok(inserted);
  assert.deepEqual(Array.from(inserted.params.slice(0, 6)), [100, 5, 2, 22, "S-1", "O-2"]);
});

test("审核预留前重新核对 SKU 绑定，变化后不写库存流水", async () => {
  let movementCount = 0;
  const { context } = createContext({
    resolvePersonIdOrFirstMysql: async () => 3,
    postInventoryMysql: async () => { movementCount += 1; }
  });
  vm.runInContext(service.slice(reserveStart, reserveEnd), context);
  const connection = {
    execute: async (sql) => {
      if (sql.includes("FROM fbp_replenishment_order_items i")) return [[{
        id: 8, order_id: 100, shop_id: 5, ozon_sku: "S-1", product_id: 1, mapping_id: 11, approved_qty: 5
      }]];
      if (sql.includes("FROM sku_mappings sm")) return [[{
        mapping_id: 22, product_id: 2, offer_id: "O-2"
      }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  await assert.rejects(() => context.reserveFbpReplenishmentApprovedStockMysql(connection, 100, 3, 7, false, 5), /本地库存绑定.*已变化/);
  assert.equal(movementCount, 0);
});

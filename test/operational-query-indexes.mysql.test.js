import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql from "mysql2/promise";
import { LEGACY_FINANCE_DAY_SQL, inspectOperationalQueryIndexes, ensureOperationalQueryIndexes } from "../src/services/operational-query-indexes.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const options = { skip: !socketPath };
async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", dateStrings: true });
  const database = `ozon_resource_test_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created = true;
    await db.changeUser({ database });
    await db.query("SET SESSION lock_wait_timeout=2");
    const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
    for (const table of ["ozon_finance_items", "online_products"]) {
      await db.query(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*;`))[0]);
    }
    await body(db, database);
  } finally {
    if (created) await db.query(`DROP DATABASE ${database}`);
    await db.end();
  }
}

test("online migration is idempotent, preserves rows and refuses a conflicting named index", options, () => fixture(async (db, database) => {
  assert.equal((await inspectOperationalQueryIndexes(db)).ready, true);
  await db.query("ALTER TABLE ozon_finance_items DROP INDEX idx_finance_shop_legacy_day");
  await db.query("ALTER TABLE online_products DROP INDEX idx_online_products_shop_ozon_product");
  await db.query("ALTER TABLE ozon_finance_items DROP COLUMN legacy_operation_date");
  const before = await inspectOperationalQueryIndexes(db);assert.equal(before.ready, false);
  await db.query("INSERT INTO ozon_finance_items(shop_id,operation_id,service_type,amount) VALUES(1,'old','sale',7)");
  const [rows] = await db.query("SELECT * FROM ozon_finance_items");
  const execute = promisify(execFile);
  const args = [new URL("../scripts/migrate-operational-query-indexes.mjs", import.meta.url).pathname, `--database=${database}`, `--mysql-admin-socket=${socketPath}`];
  const dryRun = JSON.parse((await execute(process.execPath,args)).stdout);
  assert.equal(dryRun.ready,false);assert.equal(dryRun.changes_database,false);
  assert.deepEqual(await inspectOperationalQueryIndexes(db),before);
  await execute(process.execPath,[...args,"--apply"]);
  assert.deepEqual((await db.query("SELECT * FROM ozon_finance_items"))[0].map(({ legacy_operation_date, ...row }) => row), rows);
  assert.equal((await ensureOperationalQueryIndexes(db)).before.ready, true);
  await db.query("ALTER TABLE online_products DROP INDEX idx_online_products_shop_ozon_product, ADD INDEX idx_online_products_shop_ozon_product(ozon_product_id)");
  await assert.rejects(ensureOperationalQueryIndexes(db), /incompatible/);
}));

test("indexed finance day probe preserves date/source/shop semantics and takes an indexed gap lock", options, () => fixture(async (db, database) => {
  const entries = [
    [1,"old-1","2026-11-05 00:00:00"],[1,"old-2","2026-11-05 23:59:59"],
    [1,"old-3","2026-11-06 00:00:00"],[2,"other-shop","2026-11-05 12:00:00"],
    [1,"accrual_by_day:1","2026-11-05 12:00:00"],[1,"ACCRUAL_BY_DAY:2","2026-11-05 12:00:00"],
    [1,"unknown-date",null],[1,"accrual_by_dayX","2026-11-05 12:00:00"]
  ];
  await db.query("INSERT INTO ozon_finance_items(shop_id,operation_id,operation_date,service_type) VALUES ?", [entries.map(row => [...row,"sale"])]);
  for (const shop of [1,2]) for (const day of ["2026-11-05","2026-11-06","2026-11-07"]) {
    const [old] = await db.query("SELECT id FROM ozon_finance_items WHERE shop_id=? AND operation_date>=? AND operation_date<DATE_ADD(?,INTERVAL 1 DAY) AND LEFT(operation_id,15)<>'accrual_by_day:' ORDER BY id", [shop,day,day]);
    const [indexed] = await db.query(`SELECT id FROM ozon_finance_items WHERE shop_id=? AND legacy_operation_date=? ORDER BY id`, [shop,day]);
    assert.deepEqual(indexed, old);
  }
  const values = Array.from({ length: 3000 }, (_, i) => [1,`accrual_by_day:${100+i}`,"2026-11-07 00:00:00","sale"]);
  await db.query("INSERT INTO ozon_finance_items(shop_id,operation_id,operation_date,service_type) VALUES ?", [values]);
  const [[plan]] = await db.query(`EXPLAIN SELECT id FROM ozon_finance_items WHERE shop_id=? AND legacy_operation_date=? LIMIT 1 FOR UPDATE`, [1,"2026-11-07"]);
  assert.equal(plan.key, "idx_finance_shop_legacy_day");assert.ok(plan.rows <= 2, JSON.stringify(plan));
  const concurrent = await mysql.createConnection({ socketPath, database, user:"root" });
  try {
    await concurrent.query("SET SESSION innodb_lock_wait_timeout=1");
    await db.beginTransaction();
    await db.query(`SELECT id FROM ozon_finance_items WHERE shop_id=? AND legacy_operation_date=? LIMIT 1 FOR UPDATE`, [1,"2026-11-07"]);
    await assert.rejects(concurrent.query("INSERT INTO ozon_finance_items(shop_id,operation_id,operation_date,service_type) VALUES(1,'concurrent-legacy','2026-11-07 01:00:00','sale')"), { code: "ER_LOCK_WAIT_TIMEOUT" });
    await db.rollback();
  } finally { await db.rollback();await concurrent.end(); }
}));

test("actual aftersale sales query retains amounts and tenant scope with indexed product lookup", options, () => fixture(async db => {
  await db.query("CREATE TABLE shops(id BIGINT PRIMARY KEY,name VARCHAR(50),tenant_id BIGINT)");
  await db.query("INSERT INTO shops VALUES(1,'A',10),(2,'B',20)");
  await db.query("CREATE TABLE orders(id BIGINT PRIMARY KEY,shop_id BIGINT,tenant_id BIGINT,ordered_at DATETIME,status VARCHAR(30))");
  await db.query("CREATE TABLE order_items(id BIGINT PRIMARY KEY,order_id BIGINT,ozon_sku VARCHAR(128),ozon_name VARCHAR(255),ozon_image_url TEXT,ozon_product_id VARCHAR(128),sku_mapping_id BIGINT,quantity INT,sale_price DECIMAL(18,4),KEY(order_id))");
  await db.query("CREATE TABLE sku_mappings(id BIGINT PRIMARY KEY,shop_id BIGINT,tenant_id BIGINT,product_id BIGINT)");
  await db.query("CREATE TABLE products(id BIGINT PRIMARY KEY,tenant_id BIGINT,name VARCHAR(255),image_url TEXT)");
  const products = Array.from({ length: 2000 }, (_, i) => [1,`sku-${i}`,`product-${i}`,`Product ${i}`]);
  await db.query("INSERT INTO online_products(shop_id,ozon_sku,ozon_product_id,name) VALUES ?", [products]);
  await db.query("INSERT INTO orders VALUES(1,1,10,'2026-11-05 12:00:00','delivered'),(2,2,20,'2026-11-05 12:00:00','delivered')");
  await db.query("INSERT INTO order_items VALUES ?", [Array.from({ length: 80 }, (_, i) => [i+1,1,`sku-${i}`,null,null,`product-${i}`,null,2,15]).concat([[100,2,"b-sku","B",null,"b-prod",null,999,100]])]);
  const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url),"utf8");
  const fn = source.match(/async function aftersaleSalesBaseRowsMysql\([\s\S]*?\n\}/)[0];
  let sql;
  const query = runInNewContext(`(${fn})`, {
    mysqlQuery: async (statement, params) => { sql=statement;return (await db.query(statement,params))[0]; },
    orderListTenantScopeMysql: async () => ({ id: 10 }),
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: " AND o.ordered_at>='2026-11-01' AND o.ordered_at<'2026-12-01'", params: [] }),
    buildOrderOutcomeSql: () => ({ effectiveSale:"o.status='delivered'", afterDeliveryReturn:"FALSE", rejectedUnclaimed:"FALSE" }),
    orderTenantPredicateMysql: alias => `${alias}.tenant_id=10`, dashboardShopPredicateMysql: alias => `${alias}.tenant_id=10`
  });
  const before = await query({},10);
  assert.equal(before.length,80);assert.equal(before.reduce((sum,row) => sum+Number(row.sales_quantity),0),160);
  const [plan] = await db.query(`EXPLAIN ${sql}`);
  assert.equal(plan.find(row => row.table === "op_by_product").key,"idx_online_products_shop_ozon_product");
  await db.query("ALTER TABLE online_products DROP INDEX idx_online_products_shop_ozon_product");
  const unindexed = await query({},10);
  const sorted = rows => rows.map(row => JSON.stringify(row)).sort();
  assert.deepEqual(sorted(before), sorted(unindexed));
}));

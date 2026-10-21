import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { createOrderProfitCalculationTables } from "../src/services/order-profit-calculation-schema.js";
import { ensureOrderProfitCalculationState, recordOrderProfitCalculation } from "../src/services/order-profit-calculation-versions.js";
import { profitCalculationBaselineAudit } from "../src/services/order-profit-calculation-baseline.js";

// Opt-in only. Never imports the application's config or reads production .env.
// The supplied local test account must have CREATE/DROP DATABASE permission.
const testUrl = process.env.OZON_PROFIT_VERSION_TEST_MYSQL_URL;
const testSocket = process.env.OZON_PROFIT_VERSION_TEST_MYSQL_SOCKET;
test("isolated MySQL transactions serialize retries, isolate tenants and roll back projection failures", { skip: !testUrl && !testSocket }, async () => {
  let options;
  if (testSocket) {
    assert.equal(testSocket, "/var/run/mysqld/mysqld.sock", "only the explicit local MySQL socket is permitted");
    options = { socketPath: testSocket, user: "root", multipleStatements: false };
  } else {
    const url = new URL(testUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "integration test only accepts a local MySQL host");
    options = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), multipleStatements: false };
  }
  const database = `ozon_profit_versions_test_${process.pid}_${randomBytes(5).toString("hex")}`;
  assert.match(database, /^ozon_profit_versions_test_[0-9]+_[a-f0-9]{10}$/);
  const admin = await mysql.createConnection(options);
  const connections = [];
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    for (let i = 0; i < 4; i++) connections.push(await mysql.createConnection({ ...options, database }));
    await createOrderProfitCalculationTables(connections[0]);
    await connections[0].query("CREATE TABLE projection (id BIGINT PRIMARY KEY, amount DECIMAL(18,4), is_locked TINYINT NOT NULL DEFAULT 0)");
    await connections[0].execute("INSERT INTO projection (id, amount, is_locked) VALUES (1, 12.34, 1)");
    const input = { tenantId: 7, orderId: 10, orderItemId: 1, layer: "estimate", formulaVersion: "V1", inputs: { price: 100 }, outputs: { amount: 12.34 } };
    const transaction = async (connection, callback) => {
      await connection.beginTransaction();
      try { const result = await callback(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
    };
    // Separate connections represent real concurrent sync workers.
    await Promise.all(connections.map((connection) => transaction(connection, (tx) => recordOrderProfitCalculation(tx, input))));
    const [[count]] = await connections[0].query("SELECT COUNT(*) AS count FROM order_profit_calc_revisions");
    assert.equal(Number(count.count), 1);
    await transaction(connections[0], (tx) => recordOrderProfitCalculation(tx, { ...input, tenantId: 8 }));
    const [[tenants]] = await connections[0].query("SELECT COUNT(*) AS count FROM order_profit_calc_state");
    assert.equal(Number(tenants.count), 2);
    await assert.rejects(transaction(connections[0], (tx) => recordOrderProfitCalculation(tx, { ...input, inputs: { price: 101 }, project: async ({ connection }) => {
      await connection.execute("UPDATE projection SET amount = 999, is_locked = 0 WHERE id = 1");
      throw new Error("injected projection failure");
    } })), /injected projection failure/);
    const [[projection]] = await connections[0].query("SELECT amount, is_locked FROM projection WHERE id = 1");
    assert.equal(Number(projection.amount), 12.34);
    assert.equal(projection.is_locked, 1);
    const [[current]] = await connections[0].query("SELECT revision_count FROM order_profit_calc_state WHERE tenant_key = '7' AND order_item_id = 1");
    assert.equal(Number(current.revision_count), 1);
    // Baseline insertion preserves the exact pre-existing finance lock and zero.
    await transaction(connections[0], (tx) => ensureOrderProfitCalculationState(tx, {
      tenantId: 7, orderId: 10, orderItemId: 2, legacy: true,
      baselineEstimate: { amount: "0.0000", is_locked: 1 }, baselineActual: { amount: "0.0000", is_locked: 1 }
    }));
    const [baseline] = await connections[0].query("SELECT input_completeness, outputs_json FROM order_profit_calc_revisions WHERE tenant_key = '7' AND order_item_id = 2");
    assert.equal(baseline.length, 2);
    assert.ok(baseline.every((row) => row.input_completeness === "legacy_unknown" && JSON.parse(row.outputs_json).amount === "0.0000"));
    // Legacy installations use general_ci while new version tables use 0900.
    // CAST/CASE tenant keys must compare explicitly without changing old tables.
    await connections[0].query("SET NAMES utf8mb4 COLLATE utf8mb4_general_ci");
    await connections[0].query("CREATE TABLE shops (id INT PRIMARY KEY, tenant_id BIGINT) COLLATE utf8mb4_general_ci");
    await connections[0].query("CREATE TABLE orders (id INT PRIMARY KEY, shop_id INT) COLLATE utf8mb4_general_ci");
    await connections[0].query("CREATE TABLE order_items (id INT PRIMARY KEY,order_id INT,estimated_profit DECIMAL(18,4),actual_profit DECIMAL(18,4)) COLLATE utf8mb4_general_ci");
    await connections[0].query("CREATE TABLE order_profit_items (order_item_id INT PRIMARY KEY,is_locked TINYINT) COLLATE utf8mb4_general_ci");
    await connections[0].query("INSERT INTO shops VALUES (1,7)");
    await connections[0].query("INSERT INTO orders VALUES (10,1)");
    await connections[0].query("INSERT INTO order_items VALUES (1,10,12.34,0),(2,10,0,0)");
    await connections[0].query("INSERT INTO order_profit_items VALUES (1,1),(2,1)");
    const audit = await profitCalculationBaselineAudit(connections[0]);
    assert.equal(Number(audit.state_count), 2);
    assert.equal(Number(audit.missing_count), 0);
  } finally {
    await Promise.all(connections.map((connection) => connection.end()));
    // Only this freshly generated, checked test database is ever removed.
    assert.match(database, /^ozon_profit_versions_test_[0-9]+_[a-f0-9]{10}$/);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});

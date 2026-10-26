import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import mysql from "mysql2/promise";
import { createOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";
import { eligibleForDailyOrderFx } from "../src/services/order-profit-fx-policy.js";
import { migrateOrderProfitFxPolicy } from "../scripts/migrate-order-profit-fx-policy.mjs";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;

test("policy CLI rejects hidden activation, ambiguous flags and remote/implicit connections", () => {
  for (const args of [[], ["--activate"], ["--apply=false"], ["--activate=true"], ["--apply", "--apply"], ["--database=test", "--mysql-admin-socket=remote:3306", "--apply"]]) {
    const result = spawnSync(process.execPath, ["scripts/migrate-order-profit-fx-policy.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);assert.doesNotMatch(result.stderr, /password|ECONNREFUSED|DB_PASSWORD/);
  }
});

async function fixture(body) {
  const db = await mysql.createConnection({ socketPath, user: "root", timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const name = "ozon_fx_policy_test_" + randomBytes(8).toString("hex");let created = false;
  try {
    const [[guard]] = await db.query("SELECT @@skip_networking disabled");assert.equal(Number(guard.disabled), 1);
    await db.query("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");created = true;
    await db.changeUser({ database: name });await db.query("SET SESSION time_zone='+00:00'");
    await db.query("CREATE TABLE system_settings (`key` VARCHAR(191) PRIMARY KEY,value_json LONGTEXT NOT NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await db.query("CREATE TABLE orders(id BIGINT UNSIGNED PRIMARY KEY,ordered_at DATETIME NOT NULL,profit DECIMAL(12,2)) ENGINE=InnoDB");
    await db.query("INSERT INTO orders VALUES(100,'2026-10-20 00:00:00',19.80),(200,'2099-01-01 00:00:00',20.80)");
    await db.query("CREATE TABLE exchange_rates(id INT PRIMARY KEY,rate DECIMAL(12,4)) ENGINE=InnoDB");await db.query("INSERT INTO exchange_rates VALUES(1,11.32)");
    await db.query("INSERT INTO system_settings (`key`,value_json) VALUES('unrelated','{\"keep\":true}')");
    await body({ db, name });
  } finally { if (created) { assert.match(name, /^ozon_fx_policy_test_[a-f0-9]{16}$/);await db.query("DROP DATABASE `" + name + "`"); }await db.end(); }
}

test("read-only audit and schema apply never activate; explicit activation pins first cutoff without touching history", { skip: !socketPath }, () => fixture(async ({ db }) => {
  await db.query("START TRANSACTION READ ONLY");const audit = await migrateOrderProfitFxPolicy(db);await db.rollback();
  assert.equal(audit.schema.available, false);assert.equal(audit.policy, null);
  const before = (await db.query("SELECT * FROM orders ORDER BY id"))[0];
  assert.equal((await migrateOrderProfitFxPolicy(db, { apply: true })).policy, null);
  await assert.rejects(migrateOrderProfitFxPolicy(db, { activate: true }), { code: "ORDER_PROFIT_FX_POLICY_MIGRATION_REFUSED" });
  await assert.rejects(migrateOrderProfitFxPolicy(db, { apply: true, activate: true }), { code: "ORDER_PROFIT_DAILY_FX_SCHEMA_PENDING" });
  await createOrderProfitDailyFxSchema(db);
  const enabled = await migrateOrderProfitFxPolicy(db, { apply: true, activate: true });
  assert.equal(enabled.activated_now, true);assert.equal(enabled.policy.legacy_max_order_id, 200);
  const [[clock]] = await db.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') current_time_utc");
  assert.match(enabled.policy.enabled_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  assert.ok(enabled.policy.enabled_at <= clock.current_time_utc);
  await db.query("INSERT INTO orders VALUES(201,UTC_TIMESTAMP(),21.80)");
  const repeated = await migrateOrderProfitFxPolicy(db, { apply: true, activate: true });
  assert.equal(repeated.activated_now, false);assert.deepEqual(repeated.policy, enabled.policy);
  assert.equal(eligibleForDailyOrderFx(enabled.policy, { orderId: 200, orderedAt: "2099-01-01T00:00:00Z" }), false);
  assert.equal(eligibleForDailyOrderFx(enabled.policy, { orderId: 201, orderedAt: "2026-10-01T00:00:00Z" }), false);
  assert.equal(eligibleForDailyOrderFx(enabled.policy, { orderId: 201, orderedAt: "2099-01-01T00:00:00Z" }), true);
  assert.deepEqual((await db.query("SELECT * FROM orders WHERE id<=200 ORDER BY id"))[0], before);
  assert.deepEqual((await db.query("SELECT * FROM exchange_rates"))[0], [{ id: 1, rate: "11.3200" }]);
  assert.deepEqual((await db.query("SELECT value_json FROM system_settings WHERE `key`='unrelated'"))[0], [{ value_json: '{"keep":true}' }]);
}));

test("simultaneous activation converges on one original boundary and malformed existing policy refuses overwrite", { skip: !socketPath }, () => fixture(async ({ db, name }) => {
  await createOrderProfitDailyFxSchema(db);await migrateOrderProfitFxPolicy(db, { apply: true });
  const other = await mysql.createConnection({ socketPath, user: "root", database: name, timezone: "Z", dateStrings: true });
  try {
    const [a, b] = await Promise.all([migrateOrderProfitFxPolicy(db, { apply: true, activate: true }), migrateOrderProfitFxPolicy(other, { apply: true, activate: true })]);
    assert.deepEqual(a.policy, b.policy);assert.equal(Number(a.activated_now) + Number(b.activated_now), 1);
    await db.query("UPDATE system_settings SET value_json='{}' WHERE `key`='profit.daily_fx_policy.v2'");
    await assert.rejects(migrateOrderProfitFxPolicy(db, { apply: true, activate: true }), { code: "ORDER_PROFIT_FX_POLICY_INVALID" });
    assert.equal((await db.query("SELECT value_json FROM system_settings WHERE `key`='profit.daily_fx_policy.v2'"))[0][0].value_json, "{}");
  } finally { await other.end(); }
}));

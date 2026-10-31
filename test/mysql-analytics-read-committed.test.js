import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import mysql from "mysql2/promise";

const source = readFileSync(new URL("../src/mysql-pool.js", import.meta.url), "utf8");
const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;

test("all profit snapshot insert-select writes use nonblocking statement transactions", () => {
  const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  for (const table of ["analytics_shop_daily", "analytics_product_profit_daily", "analytics_sku_profit_daily"]) {
    assert.ok(service.includes("await mysqlExecuteReadCommitted(`\n    INSERT INTO " + table));
  }
});

test("analytics snapshot does not lock business rows or leak isolation into the pool", { skip: !socketPath }, async () => {
  const database = "ozon_analytics_lock_" + randomBytes(8).toString("hex");
  const snapshot = await mysql.createConnection({ socketPath, user: "root" });
  const writer = await mysql.createConnection({ socketPath, user: "root" });
  let pending;
  let releases = 0;
  try {
    const [[network]] = await snapshot.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(network.disabled), 1);
    await snapshot.query(`CREATE DATABASE \`${database}\``);
    await snapshot.changeUser({ database });
    await writer.changeUser({ database });
    await snapshot.query("CREATE TABLE business_rows (id INT PRIMARY KEY, quantity INT) ENGINE=InnoDB");
    await snapshot.query("CREATE TABLE snapshots (id INT PRIMARY KEY, quantity INT) ENGINE=InnoDB");
    await snapshot.query("INSERT INTO business_rows VALUES (1, 10)");
    await writer.query("SET SESSION innodb_lock_wait_timeout=1");
    const [[before]] = await snapshot.query("SELECT @@transaction_isolation AS isolation_level");
    const implementation = source.match(/export async function mysqlExecuteReadCommitted[\s\S]*?\n}/)[0].replace("export ", "");
    const context = vm.createContext({ setTimeout,
      getMysqlConnection: async () => snapshot,
      ensureMysqlSessionUtc: async connection => connection.query("SET time_zone='+00:00'"),
      releaseMysqlConnection: connection => { assert.equal(connection, snapshot); releases++; }
    });
    vm.runInContext(implementation, context);
    pending = context.mysqlExecuteReadCommitted("INSERT INTO snapshots SELECT id, quantity+SLEEP(2) FROM business_rows");
    await new Promise(resolve => setTimeout(resolve, 200));
    const start = performance.now();
    await writer.execute("UPDATE business_rows SET quantity=11 WHERE id=1");
    assert.ok(performance.now()-start < 1000, "business writer must not wait for snapshot source locks");
    await pending;
    const [[row]] = await writer.query("SELECT quantity FROM snapshots WHERE id=1");
    assert.equal(Number(row.quantity), 10, "snapshot retains its statement-time source value");
    const [[after]] = await snapshot.query("SELECT @@transaction_isolation AS isolation_level");
    assert.equal(after.isolation_level, before.isolation_level);
    await assert.rejects(context.mysqlExecuteReadCommitted("INSERT INTO snapshots VALUES (1,99)"), /Duplicate/);
    assert.equal(releases, 2, "success and failure both return the pooled connection");
    const [[preserved]] = await writer.query("SELECT quantity FROM snapshots WHERE id=1");
    assert.equal(Number(preserved.quantity), 10);
    const [[finalIsolation]] = await snapshot.query("SELECT @@transaction_isolation AS isolation_level");
    assert.equal(finalIsolation.isolation_level, before.isolation_level);
    const executeOriginal = snapshot.execute.bind(snapshot);
    let attempts = 0;
    snapshot.execute = async (...args) => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("deadlock fixture"), { code: "ER_LOCK_DEADLOCK" });
      return executeOriginal(...args);
    };
    await context.mysqlExecuteReadCommitted("INSERT INTO snapshots SELECT 2,quantity FROM business_rows");
    assert.equal(attempts, 2);
    const [[retryRow]] = await writer.query("SELECT quantity FROM snapshots WHERE id=2");
    assert.equal(Number(retryRow.quantity), 11);
    const [[retryIsolation]] = await snapshot.query("SELECT @@transaction_isolation AS isolation_level");
    assert.equal(retryIsolation.isolation_level, before.isolation_level);
  } finally {
    if (pending) await Promise.allSettled([pending]);
    await snapshot.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await Promise.all([snapshot.end(), writer.end()]);
  }
});

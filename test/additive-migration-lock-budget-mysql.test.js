import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { AI_CREDIT_SCHEMAS } from "../src/services/ai-credit-schema.js";
import { LISTING_FROZEN_CONTENT_SCHEMA } from "../src/services/listing-frozen-content.js";

const execute = promisify(execFile), scripts = ["migrate-order-search-indexes.mjs", "migrate-listing-draft-list-indexes.mjs", "migrate-listing-frozen-content.mjs", "migrate-ai-credits.mjs"];

test("four actual additive migration CLIs bound metadata waits and can retry without stopping application services", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires independent TCP-disabled test MySQL socket", timeout: 90000
}, async t => {
  const f = await createTenantMysqlFixture("ddl_lock_budget");
  const blocker = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", database: f.database });
  const run = async script => {
    const started = performance.now(), args = [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), `--database=${f.database}`, `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`, "--apply"];
    try { const result = await execute(process.execPath, args, { windowsHide: true, timeout: 20000 }); return { script, code: 0, ms: performance.now() - started, ...result }; }
    catch (error) { return { script, code: error.code, ms: performance.now() - started, stdout: error.stdout, stderr: error.stderr }; }
  };
  try {
    await f.connection.query("ALTER TABLE orders DROP INDEX idx_orders_shop_order_number_id");
    await f.connection.query("CREATE TABLE listing_drafts (id BIGINT PRIMARY KEY, tenant_id VARCHAR(64), created_by_person_id BIGINT, created_at DATETIME) ENGINE=InnoDB");
    await f.connection.query(LISTING_FROZEN_CONTENT_SCHEMA);
    for (const sql of AI_CREDIT_SCHEMAS) await f.connection.query(sql);
    await blocker.query("LOCK TABLES orders WRITE, listing_drafts WRITE, listing_frozen_content WRITE, ai_credit_accounts WRITE");
    const results = await Promise.all(scripts.map(run));
    for (const result of results) {
      assert.match(await readFile(new URL(`../scripts/${result.script}`, import.meta.url), "utf8"), /await connection\.query\("SET SESSION lock_wait_timeout = 5"\)/);
      // An already verified immutable table needs only metadata inspection,
      // which is allowed under this table lock; do not invent an ALTER to test it.
      if (["migrate-listing-frozen-content.mjs", "migrate-ai-credits.mjs"].includes(result.script)) {
        assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).mode, "apply"); continue;
      }
      assert.notEqual(result.code, 0, result.script + " must refuse a metadata lock held beyond its budget");
      assert.match(result.stderr, /ER_LOCK_WAIT_TIMEOUT|Lock wait timeout exceeded/, result.script);
      assert.ok(result.ms >= 4500 && result.ms < 15000, `${result.script}: ${result.ms}ms`);
    }
    t.diagnostic(results.map(result => `${result.script}: ${result.code === 0 ? "existing-table metadata-only no-op" : "metadata timeout"} in ${result.ms.toFixed(0)}ms`).join("; "));
    await blocker.query("UNLOCK TABLES");
    await f.connection.query("DROP TABLE listing_frozen_content");
    for (const table of ["ai_credit_entries", "ai_credit_attempts", "ai_credit_tasks", "ai_credit_prices", "ai_credit_accounts"]) await f.connection.query(`DROP TABLE ${table}`);
    for (const script of scripts) {
      const result = await run(script); assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).mode, "apply");
    }
    assert.equal(Number((await f.query("SELECT COUNT(*) n FROM ai_credit_accounts"))[0].n), 0);
    assert.equal(Number((await f.query("SELECT COUNT(*) n FROM listing_frozen_content"))[0].n), 0);
  } finally { await blocker.query("UNLOCK TABLES"); await blocker.end(); await f.cleanup(); }
});

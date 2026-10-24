import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import test from "node:test";
import { AI_CREDIT_SCHEMAS, AI_CREDIT_TABLES } from "../src/services/ai-credit-schema.js";
import { inspectAiCreditSchema, migrateAiCredits } from "../scripts/migrate-ai-credits.mjs";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;

test("AI credit migration rejects incompatible existing money schemas before any DDL", { skip: !socketPath && "Explicit isolated MySQL socket required" }, async t => {
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const database = `ozon_credit_schema_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    const [[server]] = await connection.query("SELECT @@skip_networking disabled");
    assert.equal(Number(server.disabled), 1);
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
    await connection.changeUser({ database });
    const tables = async () => (await connection.query("SHOW TABLES"))[0];
    const reset = async () => { for (const table of AI_CREDIT_TABLES) await connection.query(`DROP TABLE IF EXISTS ${table}`); };
    const create = async () => { for (const sql of AI_CREDIT_SCHEMAS) await connection.query(sql); };

    await t.test("empty dry-run is read-only; apply creates empty tables without accounts, prices or grants", async () => {
      const planned = await migrateAiCredits(connection);
      assert.equal(planned.ok, true); assert.equal(planned.mode, "dry-run");
      assert.deepEqual(planned.create_tables, AI_CREDIT_TABLES); assert.deepEqual(await tables(), []);
      const applied = await migrateAiCredits(connection, { apply: true });
      assert.equal(applied.ok, true); assert.equal((await tables()).length, 5);
      for (const table of AI_CREDIT_TABLES) assert.equal(Number((await connection.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n), 0);
      await connection.execute("INSERT INTO ai_credit_accounts(tenant_id,account_key,status,available_points,frozen_points) VALUES(2,?,'active',100,20)", ["12345678-1234-1234-1234-123456789012"]);
      const [before] = await connection.query("SELECT * FROM ai_credit_accounts");
      assert.equal((await migrateAiCredits(connection, { apply: true })).ok, true);
      assert.deepEqual((await connection.query("SELECT * FROM ai_credit_accounts"))[0], before);
      assert.equal((await inspectAiCreditSchema(connection)).ok, true);
    });

    const cases = [
      ["decimal balances", "ALTER TABLE ai_credit_accounts MODIFY available_points DECIMAL(18,2) NOT NULL DEFAULT 0", "ai_credit_accounts", "available_points: incompatible type"],
      ["nullable tenant", "ALTER TABLE ai_credit_tasks MODIFY tenant_id BIGINT UNSIGNED NULL", "ai_credit_tasks", "tenant_id: incompatible nullability"],
      ["signed tenant", "ALTER TABLE ai_credit_tasks MODIFY tenant_id BIGINT NOT NULL", "ai_credit_tasks", "tenant_id: incompatible type"],
      ["nullable amount", "ALTER TABLE ai_credit_entries MODIFY available_after BIGINT NULL", "ai_credit_entries", "available_after: incompatible nullability"],
      ["missing hash column", "ALTER TABLE ai_credit_tasks DROP COLUMN input_sha256", "ai_credit_tasks", "input_sha256: missing column"],
      ["wrong balance default", "ALTER TABLE ai_credit_accounts ALTER available_points SET DEFAULT 100", "ai_credit_accounts", "available_points: incompatible default"],
      ["case insensitive keys", "ALTER TABLE ai_credit_tasks MODIFY idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL", "ai_credit_tasks", "idempotency_key: incompatible collation"],
      ["non ASCII keys", "ALTER TABLE ai_credit_accounts MODIFY account_key CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL", "ai_credit_accounts", "account_key: incompatible character set"],
      ["prefix unique key", "ALTER TABLE ai_credit_tasks DROP INDEX uq_ai_credit_task_key, ADD UNIQUE KEY uq_ai_credit_task_key(tenant_id,idempotency_key(32))", "ai_credit_tasks", "uq_ai_credit_task_key: incompatible unique key"],
      ["global business unique key", "ALTER TABLE ai_credit_tasks ADD UNIQUE KEY bad_global_key(idempotency_key)", "ai_credit_tasks", "bad_global_key: unexpected unique key"],
      ["attempt sequence type", "ALTER TABLE ai_credit_attempts MODIFY attempt_number INT NOT NULL", "ai_credit_attempts", "attempt_number: incompatible type"],
      ["missing attempt sequence unique", "ALTER TABLE ai_credit_attempts DROP INDEX uq_ai_credit_attempt_number", "ai_credit_attempts", "uq_ai_credit_attempt_number: incompatible unique key"]
    ];
    for (const [name, mutation, table, reason] of cases) await t.test(name, async () => {
      await reset(); await create(); await connection.query(mutation);
      const planned = await migrateAiCredits(connection);
      assert.equal(planned.ok, false);
      assert.ok(planned.incompatible_tables.find(item => item.table === table)?.reasons.includes(reason));
      const [before] = await connection.query(`SHOW CREATE TABLE ${table}`);
      await assert.rejects(migrateAiCredits(connection, { apply: true }), { code: "AI_CREDIT_SCHEMA_INCOMPATIBLE" });
      assert.deepEqual((await connection.query(`SHOW CREATE TABLE ${table}`))[0], before);
    });

    await t.test("MyISAM and decimal existing accounts are refused before creating any other table", async () => {
      await reset();
      await connection.query(`CREATE TABLE ai_credit_accounts (
        tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, account_key CHAR(36) NOT NULL,
        status VARCHAR(16) DEFAULT 'disabled', available_points DECIMAL(18,2) DEFAULT 0,
        frozen_points DECIMAL(18,2) DEFAULT 0, updated_at DATETIME,
        UNIQUE KEY uq_ai_credit_account_key(account_key)) ENGINE=MyISAM`);
      const report = await migrateAiCredits(connection);
      assert.equal(report.ok, false); assert.ok(report.incompatible_tables[0].reasons.includes("engine must be InnoDB"));
      await assert.rejects(migrateAiCredits(connection, { apply: true }), { code: "AI_CREDIT_SCHEMA_INCOMPATIBLE" });
      assert.equal((await tables()).length, 1);
    });

    await t.test("missing nonnegative money checks fail closed", async () => {
      await reset(); await create();
      const [[constraint]] = await connection.query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_credit_accounts' AND CONSTRAINT_TYPE='CHECK'");
      assert.match(constraint.CONSTRAINT_NAME, /^[A-Za-z0-9_]+$/);
      await connection.query(`ALTER TABLE ai_credit_accounts DROP CHECK ${constraint.CONSTRAINT_NAME}`);
      const report = await migrateAiCredits(connection);
      assert.equal(report.ok, false);
      assert.ok(report.incompatible_tables.find(item => item.table === "ai_credit_accounts").reasons.includes("missing enforced money check constraint"));
    });
  } finally {
    try { if (created) await connection.query(`DROP DATABASE \`${database}\``); } finally { await connection.end(); }
  }
});

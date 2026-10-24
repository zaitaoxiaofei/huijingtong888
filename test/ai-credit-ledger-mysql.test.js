import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import mysql from "mysql2/promise";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AI_CREDIT_SCHEMAS } from "../src/services/ai-credit-schema.js";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";
import { createAiCreditExecutor } from "../src/services/ai-credit-execution.js";
import { createAiCreditResultStore } from "../src/services/ai-credit-result-store.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "../src/services/business-task-tenant.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const digest = value => createHash("sha256").update(value).digest("hex");
const session = (tenant = 2, person = 7) => ({ personId: person, tenant: { id: tenant, slug: tenant === 1 ? "default" : `enterprise-${tenant}` } });
const adminSession = { personId: 9, platform_role: "super_admin" };

test("AI points: real transactions, current authorization, retries and reconciliation", { skip: !socketPath && "Explicit isolated MySQL socket required" }, async t => {
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const database = `ozon_ai_credit_test_${randomBytes(8).toString("hex")}`;
  let created = false, pool, resultDirectory;
  try {
    const [[host]] = await connection.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(host.disabled), 1, "Never run financial fixtures against a TCP-enabled business server");
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 6 });
    const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
    const transaction = async action => {
      const c = await pool.getConnection();
      try { await c.beginTransaction(); const result = await action(c); await c.commit(); return result; }
      catch (error) { await c.rollback(); throw error; }
      finally { c.release(); }
    };
    for (const schema of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL, feature_flags_json JSON NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id,person_id))",
      "CREATE TABLE platform_grants (person_id BIGINT PRIMARY KEY, role VARCHAR(32), active TINYINT DEFAULT 1)",
      ...AI_CREDIT_SCHEMAS
    ]) await query(schema);
    await query("INSERT INTO tenants (id,slug) VALUES (1,'default'),(2,'enterprise-2'),(3,'enterprise-3')");
    await query("INSERT INTO people (id) VALUES (7),(8),(9)");
    await query("INSERT INTO platform_grants VALUES (9,'super_admin',1)");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations')),(2,8,JSON_ARRAY('packing'))");
    let ledger = createAiCreditLedger({ transaction });
    const reserve = (key, extra = {}, actor = session()) => ledger.reserve(actor, { idempotencyKey: key, priceKey: "image", inputSha256: digest(key), ...extra });
    const attempt = task => ledger.startAttempt(session(), task.id, { attemptKey: "1", provider: "fixture", model: "fixture" });
    const outcome = (task, tried, extra = {}, actor = session()) => ledger.recordOutcome(actor, task.id, { attemptId: tried.id, outcome: "succeeded",
      successfulResults: Number(task.requested_results), outcomeSha256: digest(`result:${task.id}`), resultReference: `private:result:${task.id}`, resultSha256: digest(`asset:${task.id}`), ...extra });
    await t.test("only a current platform grant configures or recharges an account", async () => {
      await assert.rejects(ledger.configureAccount(session(), { tenantId: 2, status: "active" }), { code: "AI_CREDIT_FORBIDDEN" });
      await assert.rejects(ledger.configureAccount({ ...adminSession, personId: 7 }, { tenantId: 2, status: "active" }), { code: "AI_CREDIT_FORBIDDEN" });
      for (const tenantId of [1, 2, 3]) await ledger.configureAccount(adminSession, { tenantId, status: "active" });
      assert.equal((await query("SELECT JSON_EXTRACT(feature_flags_json,'$.ai_credits_opted_in') AS opted FROM tenants WHERE id=2"))[0].opted, true);
      await ledger.createPrice(adminSession, { priceKey: "image", version: 1, pointsPerResult: 10 });
      await ledger.recharge(adminSession, { tenantId: 2, reference: "payment-1", points: 100, reason: "已核对收款" });
      const replay = await ledger.recharge(adminSession, { tenantId: 2, reference: "payment-1", points: 100, reason: "已核对收款" });
      assert.equal(replay.replayed, true); assert.equal(Number(replay.available_points), 100);
      await assert.rejects(ledger.recharge(adminSession, { tenantId: 2, reference: "payment-1", points: 90, reason: "已核对收款" }), { code: "AI_CREDIT_CONFLICT" });
      await query("UPDATE platform_grants SET active=0 WHERE person_id=9");
      await assert.rejects(ledger.recharge(adminSession, { tenantId: 2, reference: "revoked", points: 1, reason: "test" }), { code: "AI_CREDIT_FORBIDDEN" });
      await query("UPDATE platform_grants SET active=1 WHERE person_id=9");
    });
    await t.test("concurrent duplicate requests freeze once; changed inputs are refused", async () => {
      const results = await Promise.all([reserve("same"), reserve("same")]);
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter(r => r.replayed).length, 1);
      assert.equal(Number((await ledger.wallet(session())).frozen_points), 10);
      await assert.rejects(reserve("same", { inputSha256: digest("changed") }), { code: "AI_CREDIT_CONFLICT" });
      await ledger.releaseUnsubmitted(session(), results[0].id);
      assert.equal((await ledger.audit(session())).consistent, true);
    });
    await t.test("verified receipt can complete a timeout; late supplier cost never rewrites a reviewed bill", async () => {
      const task = await reserve("query-recovery"), submitted = await attempt(task);
      await ledger.recordReceipt(session(), task.id, { attemptId: submitted.id, receipt: "known-query" });
      await outcome(task, submitted, { outcome: "unknown" });
      await assert.rejects(outcome(task, submitted), { code: "AI_CREDIT_CONFLICT" });
      const done = await outcome(task, submitted, { verifiedReceipt: true, receipt: "known-query" });
      assert.equal(done.charged_points, 10);
      const late = await reserve("late-cost"), attempted = await attempt(late);
      await ledger.reconcile(adminSession, { tenantId: 2, taskId: late.id, successfulResults: 0, reason: "人工凭据确认退款" });
      const recorded = await outcome(late, attempted, { supplierCostMicros: 123, supplierCurrency: "CNY" });
      assert.equal(recorded.charged_points, 0); assert.equal(recorded.billing_conflict, true);
      assert.equal((await query("SELECT supplier_cost_micros,billing_conflict FROM ai_credit_attempts WHERE id=?", [attempted.id]))[0].supplier_cost_micros, 123);
      assert.equal((await ledger.audit(session())).consistent, true);
    });
    await t.test("default/A/B and operators cannot impersonate one another", async () => {
      await assert.rejects(reserve("poor-b", {}, session(3)), { code: "AI_CREDIT_INSUFFICIENT" });
      await assert.rejects(reserve("wrong-role", {}, session(2, 8)), { code: "TENANT_TASK_ACCESS_DENIED" });
      await assert.rejects(reserve("wrong-slug", {}, { ...session(), tenant: { id: 2, slug: "enterprise-3" } }), { code: "TENANT_TASK_ACCESS_DENIED" });
      const a = await reserve("private");
      await assert.rejects(ledger.task(session(3), a.id), { code: "AI_CREDIT_NOT_FOUND" });
      await assert.rejects(ledger.startAttempt(session(3), a.id, { attemptKey: "1", provider: "fixture", model: "fixture" }), { code: "AI_CREDIT_NOT_FOUND" });
      await ledger.releaseUnsubmitted(session(), a.id);
    });
    await t.test("immutable prices, partial success, retry cost separate from customer charge", async () => {
      const startingBalance = Number((await ledger.wallet(session())).available_points);
      const task = await reserve("retry", { results: 2 });
      await ledger.createPrice(adminSession, { priceKey: "image", version: 2, pointsPerResult: 15 });
      const first = await attempt(task);
      const repeated = await attempt(task); assert.equal(repeated.should_submit, false);
      await ledger.recordReceipt(session(), task.id, { attemptId: first.id, receipt: "official-1" });
      await assert.rejects(ledger.recordReceipt(session(), task.id, { attemptId: first.id, receipt: "official-other" }), { code: "AI_CREDIT_CONFLICT" });
      await outcome(task, first, { outcome: "failed", retryable: true, supplierCostMicros: 1000, supplierCurrency: "CNY" });
      assert.equal((await query("SELECT provider_receipt FROM ai_credit_attempts WHERE id=?", [first.id]))[0].provider_receipt, "official-1");
      const second = await ledger.startAttempt(session(), task.id, { attemptKey: "2", provider: "fixture", model: "fixture" });
      const done = await outcome(task, second, { successfulResults: 1, supplierCostMicros: 2000, supplierCurrency: "CNY" });
      assert.equal(done.charged_points, 10); assert.equal(done.price_version, 1);
      assert.equal((await outcome(task, second, { successfulResults: 1 })).replayed, true);
      await assert.rejects(outcome(task, second, { successfulResults: 2 }), { code: "AI_CREDIT_CONFLICT" });
      assert.equal(Number((await ledger.wallet(session())).available_points), startingBalance - 10);
      assert.equal((await ledger.audit(session())).consistent, true);
      const next = await reserve("new-price"); assert.equal(next.reserved_points, 15);
      await ledger.releaseUnsubmitted(session(), next.id);
    });
    await t.test("unknown or interrupted submissions cannot refund or resubmit automatically, including after restart", async () => {
      const task = await reserve("unknown"), submitted = await attempt(task);
      await outcome(task, submitted, { outcome: "unknown", receipt: "receipt-timeout" });
      ledger = createAiCreditLedger({ transaction });
      const restored = await reserve("unknown"); assert.equal(restored.status, "unknown");
      await assert.rejects(ledger.startAttempt(session(), task.id, { attemptKey: "2", provider: "fixture", model: "fixture" }), { code: "AI_CREDIT_SUBMISSION_BLOCKED" });
      await assert.rejects(ledger.releaseUnsubmitted(session(), task.id), { code: "AI_CREDIT_CONFLICT" });
      await ledger.reconcile(adminSession, { tenantId: 2, taskId: task.id, successfulResults: 0, reason: "供应商确认未完成" });
      const interrupted = await reserve("interrupted"); await attempt(interrupted);
      ledger = createAiCreditLedger({ transaction });
      await assert.rejects(ledger.startAttempt(session(), interrupted.id, { attemptKey: "2", provider: "fixture", model: "fixture" }), { code: "AI_CREDIT_SUBMISSION_BLOCKED" });
      await ledger.reconcile(adminSession, { tenantId: 2, taskId: interrupted.id, successfulResults: 1,
        resultReference: "private:recovered", resultSha256: digest("recovered"), reason: "按供应商回执恢复结果" });
      assert.equal((await ledger.audit(session())).consistent, true);
    });
    await t.test("definitive failure releases points; insufficient balance never creates a task", async () => {
      const task = await reserve("failed"), submitted = await attempt(task);
      const before = Number((await ledger.wallet(session())).available_points);
      await outcome(task, submitted, { outcome: "failed" });
      assert.equal(Number((await ledger.wallet(session())).available_points), before + 15);
      const parallel = await Promise.allSettled([1, 2, 3].map(i => reserve(`large-${i}`, { results: 3 })));
      assert.equal(parallel.filter(r => r.status === "fulfilled").length, 1);
      for (const result of parallel) if (result.status === "fulfilled") await ledger.releaseUnsubmitted(session(), result.value.id);
    });
    await t.test("waiting for tenant lock rechecks current membership; submitted results still settle after revocation", async () => {
      const task = await reserve("revoke"), submitted = await attempt(task);
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(reserve("revoked"), { code: "TENANT_TASK_ACCESS_DENIED" });
      await assert.rejects(ledger.startAttempt(session(), task.id, { attemptKey: "2", provider: "fixture", model: "fixture" }), { code: "TENANT_TASK_ACCESS_DENIED" });
      await outcome(task, submitted);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
      assert.equal((await ledger.audit(session())).consistent, true);
      const locker = await pool.getConnection();
      try {
        await locker.beginTransaction(); await locker.execute("SELECT id FROM tenants WHERE id=2 FOR UPDATE");
        const waiting = reserve("wait-revoke");
        let completed = false; waiting.then(() => { completed = true; }, () => { completed = true; });
        await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed, false);
        await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
        await locker.commit(); await assert.rejects(waiting, { code: "TENANT_TASK_ACCESS_DENIED" });
      } finally { await locker.rollback(); locker.release(); }
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("journal insert failure rolls back the wallet, and request validation fails before SQL", async () => {
      const before = Number((await ledger.wallet(session())).available_points);
      await pool.query("CREATE TRIGGER credit_fail BEFORE INSERT ON ai_credit_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture journal failure'");
      await assert.rejects(reserve("journal-failure"), /fixture journal failure/);
      await pool.query("DROP TRIGGER credit_fail");
      assert.equal(Number((await ledger.wallet(session())).available_points), before);
      assert.equal((await query("SELECT COUNT(*) AS n FROM ai_credit_tasks WHERE idempotency_key='journal-failure'"))[0].n, 0);
      await assert.rejects(ledger.recharge(adminSession, { tenantId: 2, reference: "decimal", points: 1.5, reason: "test" }), { code: "AI_CREDIT_INVALID" });
      await assert.rejects(reserve("bad", { inputSha256: "not-a-hash" }), { code: "AI_CREDIT_INVALID" });
      await assert.rejects(ledger.recharge(adminSession, { tenantId: 2, reference: "bad' key", points: 1, reason: "test" }), { code: "AI_CREDIT_INVALID" });
      assert.equal((await ledger.audit(session())).consistent, true);
    });
    await t.test("execution retries one quote, persists private result and replays without a new supplier call", async () => {
      await ledger.recharge(adminSession, { tenantId: 2, reference: "execution-funds", points: 1000, reason: "执行链路测试" });
      resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-ai-credit-result-test-"));
      const resultStore = createAiCreditResultStore(resultDirectory);
      const authorize = async actor => assertBusinessTaskPermission(await authorizeBusinessTaskSession(actor, query), "operations");
      let submitted = 0;
      const providers = { image: { priceKey: "image", name: "fixture", model: "fixture", async submit(payload, { onReceipt }) {
        submitted += 1; await onReceipt(`receipt-${submitted}`);
        if (submitted === 1) throw Object.assign(new Error("definite rejection"), { definiteFailure: true, retryable: true });
        return { images: ["private:current-main"], title: payload.title };
      } } };
      const execute = createAiCreditExecutor({ ledger, resultStore, providers, authorize });
      const input = { capability: "image", idempotencyKey: "executor-success", payload: { title: "主图", mode: "new" } };
      const before = Number((await ledger.wallet(session())).available_points);
      const first = await execute(session(), input);
      assert.equal(submitted, 2); assert.equal(first.task.charged_points, 15);
      const replay = await execute(session(), { ...input, payload: { mode: "new", title: "主图" } });
      assert.equal(submitted, 2); assert.deepEqual(replay.result, first.result);
      assert.equal(Number((await ledger.wallet(session())).available_points), before - 15);
      const entries = await query("SELECT kind FROM ai_credit_entries WHERE task_id=? ORDER BY id", [first.task.id]);
      assert.deepEqual(entries.map(row => row.kind), ["reserve", "settle"]);
      const unknownProviders = { image: { priceKey: "image", name: "fixture", model: "fixture", async submit(_, { onReceipt }) {
        submitted += 1; await onReceipt("accepted-before-timeout"); throw new Error("timeout");
      }, async query(receipt) { assert.equal(receipt, "accepted-before-timeout"); return { status: "succeeded", result: { images: ["private:recovered"] } }; } } };
      const unknownExecute = createAiCreditExecutor({ ledger, resultStore, providers: unknownProviders, authorize });
      const unknownInput = { capability: "image", idempotencyKey: "executor-timeout", payload: { title: "恢复" } };
      await assert.rejects(unknownExecute(session(), unknownInput), { code: "AI_CREDIT_RESULT_PENDING" });
      const countBefore = submitted;
      const recovered = await unknownExecute(session(), unknownInput);
      assert.equal(submitted, countBefore); assert.equal(recovered.task.status, "succeeded");
      assert.equal((await ledger.audit(session())).consistent, true);
      await fs.writeFile(path.join(resultDirectory, "2", `${first.task.id}.json`), "tampered");
      await assert.rejects(execute(session(), input), { code: "AI_CREDIT_RESULT_INVALID" });
      assert.equal(submitted, countBefore);
    });
    await t.test("restart settles an already persisted and independently verified result after the SQL settlement was lost", async () => {
      const resultStore = createAiCreditResultStore(resultDirectory);
      const authorize = async actor => assertBusinessTaskPermission(await authorizeBusinessTaskSession(actor, query), "operations");
      for (const unknown of [false, true]) {
        let submitted = 0, queried = 0, verified = 0;
        const provider = { priceKey: "image", name: "fixture", model: "fixture", async submit(payload, { task }) {
          submitted += 1; return { images: ["private:durable"], taskId: task.id, title: payload.title };
        }, async query() { queried += 1; throw new Error("An already saved result must not query the supplier again"); },
        async verifySavedResult(result, { task }) {
          verified += 1; assert.equal(result.taskId, task.id); assert.equal(result.images[0], "private:durable"); return result;
        } };
        const crashLedger = { ...ledger, async recordOutcome() { throw new Error("fixture SQL settlement outage"); } };
        const input = { capability: "image", idempotencyKey: `durable-sql-outage-${unknown}`, payload: { title: "已保存主图" } };
        const before = Number((await ledger.wallet(session())).available_points);
        const interrupted = createAiCreditExecutor({ ledger: crashLedger, resultStore, providers: { image: provider }, authorize });
        await assert.rejects(interrupted(session(), input), /SQL settlement outage/);
        const [task] = await query("SELECT * FROM ai_credit_tasks WHERE idempotency_key=?", [input.idempotencyKey]);
        assert.equal(task.status, "running"); assert.equal(submitted, 1);
        if (unknown) {
          const attempt = await ledger.latestAttempt(session(), task.id);
          await ledger.recordOutcome(session(), task.id, { attemptId: attempt.id, outcome: "unknown", outcomeSha256: digest("interrupted") });
        }
        const restored = createAiCreditExecutor({ ledger: createAiCreditLedger({ transaction }), resultStore: createAiCreditResultStore(resultDirectory), providers: { image: provider }, authorize });
        const result = await restored(session(), input);
        assert.equal(result.task.status, "succeeded"); assert.equal(verified, 1); assert.equal(submitted, 1); assert.equal(queried, 0);
        assert.equal(Number((await ledger.wallet(session())).available_points), before - 15);
        assert.deepEqual((await query("SELECT kind FROM ai_credit_entries WHERE task_id=? ORDER BY id", [task.id])).map(row => row.kind), ["reserve", "settle"]);
        await restored(session(), input); assert.equal(verified, 1); assert.equal(submitted, 1);
        assert.equal((await ledger.audit(session())).consistent, true);
      }
    });
    await t.test("parallel execution submits once; result storage failure never releases an accepted hold", async () => {
      const resultStore = createAiCreditResultStore(resultDirectory);
      const authorize = async actor => assertBusinessTaskPermission(await authorizeBusinessTaskSession(actor, query), "operations");
      let calls = 0;
      const providers = { image: { priceKey: "image", name: "fixture", model: "fixture", async submit() {
        calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { images: ["private:one"] };
      } } };
      const execute = createAiCreditExecutor({ ledger, resultStore, providers, authorize });
      const input = { capability: "image", idempotencyKey: "parallel-executor", payload: {} };
      const results = await Promise.allSettled([execute(session(), input), execute(session(), input)]);
      assert.equal(calls, 1); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "AI_CREDIT_RESULT_PENDING");
      const brokenStore = { ...resultStore, write: async () => { throw new Error("fixture storage failure"); } };
      const broken = createAiCreditExecutor({ ledger, resultStore: brokenStore, providers, authorize });
      await assert.rejects(broken(session(), { ...input, idempotencyKey: "storage-failure" }), /fixture storage failure/);
      const [task] = await query("SELECT * FROM ai_credit_tasks WHERE idempotency_key='storage-failure'");
      assert.equal(task.status, "running");
      await assert.rejects(ledger.releaseUnsubmitted(session(), task.id), { code: "AI_CREDIT_CONFLICT" });
      await ledger.reconcile(adminSession, { tenantId: 2, taskId: task.id, successfulResults: 0, reason: "测试确认未交付结果，释放积分" });
      assert.equal((await ledger.audit(session())).consistent, true);
    });
  } finally {
    if (pool) await pool.end();
    try { if (created) await connection.query(`DROP DATABASE \`${database}\``); } finally { await connection.end(); }
    if (resultDirectory && path.dirname(resultDirectory) === path.resolve(os.tmpdir()) && path.basename(resultDirectory).startsWith("ozon-ai-credit-result-test-")) await fs.rm(resultDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createAiCreditExecutor } from "../src/services/ai-credit-execution.js";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";
import { createAiCreditSqlFixture, aiCreditSqlFixtureAvailable } from "./helpers/ai-credit-sql-fixture.js";

const sqlTest = (name, run) => test(name, { skip: !aiCreditSqlFixtureAvailable && "Native SQLite with exact integer reads required" }, run);
const pending = { code: "AI_CREDIT_RESULT_PENDING" };
const review = { code: "AI_CREDIT_RECONCILIATION_REQUIRED", status: 409, statusCode: 409 };

async function fixture(t) {
  const database = createAiCreditSqlFixture();
  t.after(() => database.close());
  database.seed();
  const ledger = createAiCreditLedger({ transaction: database.transaction });
  const session = { personId: 7, tenant: { id: 2, slug: "customer-a" } };
  const admin = { personId: 9, platform_role: "super_admin" };
  await ledger.configureAccount(admin, { tenantId: 2, status: "active" });
  await ledger.createPrice(admin, { priceKey: "image.generate", version: 1, pointsPerResult: 10 });
  await ledger.recharge(admin, { tenantId: 2, reference: "fixture-funds", points: 100, reason: "Offline regression fixture" });
  const initialAvailable = Number((await ledger.wallet(session)).available_points);
  const counters = { submits: 0, queries: 0 };
  const provider = { name: "fixture-provider", model: "fixture-model", priceKey: "image.generate",
    async submit() { counters.submits++; throw new Error("fixture: submission response lost without a receipt"); },
    async query() { counters.queries++; return { status: "pending" }; }
  };
  const stored = new Map();
  const resultStore = {
    async write(task, result) { stored.set(task.id, result); return { reference: `credit-result:${task.id}`, sha256: "a".repeat(64) }; },
    async read(reference) { return stored.get(reference.replace("credit-result:", "")); }
  };
  // Recreate the executor on every call to exercise persisted recovery state.
  const execute = () => createAiCreditExecutor({ ledger, resultStore, providers: { image: provider }, authorize: async () => {} })(session,
    { capability: "image", idempotencyKey: "original-submission", payload: { prompt: "fixture product" } });
  const task = async () => (await database.query("SELECT * FROM ai_credit_tasks"))[0];
  return { database, ledger, session, admin, provider, counters, execute, task, resultStore, initialAvailable };
}

sqlTest("unknown acceptance without a receipt pauses for reconciliation and keeps the original hold across restarts", async t => {
  const f = await fixture(t);
  let taskId;
  await assert.rejects(f.execute(), error => {
    assert.equal(error.code, review.code); assert.equal(error.status, 409); assert.equal(error.statusCode, 409);
    assert.match(error.message, /供应商任务号/); assert.match(error.message, /平台管理员/);
    taskId = error.creditTaskId; return true;
  });
  for (let index = 0; index < 3; index++) await assert.rejects(f.execute(), { ...review, creditTaskId: taskId });
  assert.deepEqual(f.counters, { submits: 1, queries: 0 });
  assert.equal((await f.task()).status, "unknown");
  const wallet = await f.ledger.wallet(f.session);
  assert.equal(Number(wallet.available_points), f.initialAvailable - 10); assert.equal(Number(wallet.frozen_points), 10);
  assert.equal(Number((await f.task()).charged_points), 0);
  const entries = await f.database.query("SELECT kind FROM ai_credit_entries WHERE task_id=?", [taskId]);
  assert.deepEqual(entries.map(entry => entry.kind), ["reserve"]);
  assert.equal((await f.ledger.audit(f.session)).consistent, true);
});

sqlTest("a saved receipt keeps automatic polling and settles one successful result without another submission", async t => {
  const f = await fixture(t);
  f.provider.submit = async (_payload, { onReceipt }) => {
    f.counters.submits++; await onReceipt("fixture-original-receipt"); throw new Error("fixture: timeout after receipt");
  };
  await assert.rejects(f.execute(), pending);
  await assert.rejects(f.execute(), pending);
  f.provider.query = async receipt => {
    f.counters.queries++; assert.equal(receipt, "fixture-original-receipt");
    return { status: "succeeded", result: { images: ["fixture:original-result"] } };
  };
  const result = await f.execute();
  assert.equal(result.task.status, "succeeded"); assert.equal(Number(result.task.charged_points), 10);
  assert.deepEqual((await f.execute()).result, result.result);
  assert.deepEqual(f.counters, { submits: 1, queries: 2 });
  assert.equal(Number((await f.ledger.wallet(f.session)).frozen_points), 0);
  assert.equal((await f.ledger.audit(f.session)).consistent, true);
});

sqlTest("a reviewed undelivered task releases its original hold and becomes an explicit failure on recovery", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute(), review);
  const task = await f.task();
  await f.ledger.reconcile(f.admin, { tenantId: 2, taskId: task.id, successfulResults: 0, reason: "Offline fixture: supplier confirmed no delivery" });
  await assert.rejects(f.execute(), { code: "AI_CREDIT_TASK_FAILED", creditTaskId: task.id });
  assert.deepEqual(f.counters, { submits: 1, queries: 0 });
  assert.equal(Number((await f.ledger.wallet(f.session)).available_points), f.initialAvailable);
  assert.equal(Number((await f.ledger.wallet(f.session)).frozen_points), 0);
  assert.equal((await f.ledger.audit(f.session)).consistent, true);
});

sqlTest("a reviewed stored image is recovered from the same credit task without paying for another submission", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute(), review);
  const task = await f.task(), result = { generatedImages: [{ url: "fixture:reviewed-original" }] };
  const saved = await f.resultStore.write(task, result);
  await f.ledger.reconcile(f.admin, { tenantId: 2, taskId: task.id, successfulResults: 1, resultReference: saved.reference, resultSha256: saved.sha256, reason: "Offline fixture: verified original private image" });
  assert.deepEqual((await f.execute()).result, result);
  assert.equal(Number((await f.task()).charged_points), 10);
  assert.equal(Number((await f.ledger.wallet(f.session)).frozen_points), 0);
  assert.deepEqual(f.counters, { submits: 1, queries: 0 });
  assert.equal((await f.ledger.audit(f.session)).consistent, true);
});

for (const unavailable of ["query", "name", "model"]) sqlTest(`an original receipt requires reconciliation when provider ${unavailable} no longer matches`, async t => {
  const f = await fixture(t);
  f.provider.submit = async (_payload, { onReceipt }) => {
    f.counters.submits++; await onReceipt("fixture-original-receipt"); throw new Error("fixture: timeout after receipt");
  };
  await assert.rejects(f.execute(), pending);
  if (unavailable === "query") delete f.provider.query;
  else f.provider[unavailable] = "changed-fixture-binding";
  await assert.rejects(f.execute(), review);
  assert.deepEqual(f.counters, { submits: 1, queries: 0 });
  assert.equal((await f.task()).status, "unknown");
  assert.equal(Number((await f.ledger.wallet(f.session)).frozen_points), 10);
});

for (const stale of [false, true]) sqlTest(`${stale ? "an expired" : "a recent"} in-flight submission without a receipt ${stale ? "requires reconciliation" : "remains pending"} without refunding or resubmitting`, async t => {
  const f = await fixture(t);
  let entered, finish;
  const submitted = new Promise(resolve => { entered = resolve; });
  const generated = new Promise(resolve => { finish = resolve; });
  f.provider.submit = async () => { f.counters.submits++; entered(); await generated; return { images: ["fixture:original-result"] }; };
  const original = f.execute();
  await submitted;
  try {
    if (stale) await f.database.query("UPDATE ai_credit_attempts SET created_at=?", [new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "")]);
    await assert.rejects(f.execute(), stale ? review : pending);
    assert.equal((await f.task()).status, "running");
    assert.deepEqual(f.counters, { submits: 1, queries: 0 });
    assert.equal(Number((await f.ledger.wallet(f.session)).frozen_points), 10);
  } finally { finish(); }
  // A still-running original request can finish even after the review signal.
  assert.equal((await original).task.status, "succeeded");
  assert.equal((await f.ledger.audit(f.session)).consistent, true);
});

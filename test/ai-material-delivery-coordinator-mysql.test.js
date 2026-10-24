import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import sharp from "sharp";
import { AI_CREDIT_SCHEMAS } from "../src/services/ai-credit-schema.js";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";
import { createAiCreditResultStore } from "../src/services/ai-credit-result-store.js";
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA } from "../src/services/ai-material-optimization-schema.js";
import { createAiMaterialDeliveryCoordinator, assertAiMaterialDeliveryPermit } from "../src/services/ai-material-delivery-coordinator.js";
import { materialAnalysisFixture, materialPlanFixture, materialReviewFixture } from "./helpers/ai-material-provider-fixtures.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { personId: 7, tenant: { id: 2, slug: "enterprise-2" } };
const platform = { personId: 9, platform_role: "super_admin" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("one final main image: real SQL, fenced worker, offline suppliers, private pixels and one customer settlement", {
  skip: !socketPath && "Explicit isolated MySQL socket required", timeout: 60000
}, async t => {
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const database = `ozon_material_delivery_${randomBytes(8).toString("hex")}`;
  let created = false, pool, directory;
  try {
    const [[host]] = await connection.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(host.disabled), 1, "No business or TCP-enabled MySQL may be used");
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 8 });
    const query = async (sql, values = []) => (await pool.execute(sql, values))[0];
    const transaction = async operation => {
      const c = await pool.getConnection();
      try { await c.beginTransaction(); const value = await operation(c); await c.commit(); return value; }
      catch (error) { await c.rollback(); throw error; } finally { c.release(); }
    };
    for (const sql of [
      "CREATE TABLE tenants(id BIGINT PRIMARY KEY,slug VARCHAR(80),status VARCHAR(32) DEFAULT 'active',subscription_status VARCHAR(32) DEFAULT 'active',subscription_expires_at DATETIME NULL,feature_flags_json JSON NULL)",
      "CREATE TABLE people(id BIGINT PRIMARY KEY,active TINYINT DEFAULT 1,role VARCHAR(32) DEFAULT 'operations',roles_json JSON NULL)",
      "CREATE TABLE tenant_members(tenant_id BIGINT,person_id BIGINT,active TINYINT DEFAULT 1,role VARCHAR(32) DEFAULT 'member',business_roles_json JSON NULL,PRIMARY KEY(tenant_id,person_id))",
      "CREATE TABLE platform_grants(person_id BIGINT PRIMARY KEY,role VARCHAR(32),active TINYINT DEFAULT 1)",
      "CREATE TABLE listing_drafts(id BIGINT PRIMARY KEY AUTO_INCREMENT,tenant_id VARCHAR(64) NULL,status VARCHAR(32) DEFAULT 'draft',product_name VARCHAR(255),source_images_json LONGTEXT)",
      ...AI_CREDIT_SCHEMAS, AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA
    ]) await query(sql);
    await query("INSERT INTO tenants(id,slug) VALUES(17,'default'),(2,'enterprise-2'),(3,'enterprise-3')");
    await query("INSERT INTO people(id) VALUES(7),(8),(9)");
    await query("INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(2,7,JSON_ARRAY('operations')),(2,8,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations')),(17,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO platform_grants VALUES(9,'super_admin',1)");
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "material-delivery-"));
    const store = createAiCreditResultStore(path.join(directory, "private-results"));
    const ledger = createAiCreditLedger({ transaction });
    await ledger.createPrice(platform, { priceKey: "material.main_only", version: 1, pointsPerResult: 20 });
    for (const tenantId of [2, 3, 17]) {
      await ledger.configureAccount(platform, { tenantId, status: "active" });
      await ledger.recharge(platform, { tenantId, reference: `offline-${tenantId}`, points: 10000, reason: "Offline acceptance only" });
    }
    const png = await sharp({ create: { width: 18, height: 22, channels: 3, background: "blue" } }).png().toBuffer();
    let number = 0, binding = "original-account", hook = async () => {}, reviewPass = () => true, omitMainCost = false, terminalEnvelopes = false;
    const calls = [], contexts = new Map(), providerResults = new Map();
    const sourcePath = path.join(directory, "source.png");
    await fs.writeFile(sourcePath, png);
    const loadDraft = async (_c, row) => {
      const contentSha256 = hash(await fs.readFile(sourcePath));
      return { ...row, effective_images: JSON.parse(row.source_images_json),
        effective_image_identities: JSON.parse(row.source_images_json).map(url => ({ url, contentSha256 })) };
    };
    const verifyImage = async (result, { task }) => {
      assert.equal(result.taskId, task.id, "Image must be owned by its original internal stage task");
      assert.equal(result.filename, "image.png");
      const file = path.join(directory, "private-images", task.id, result.filename);
      const bytes = await fs.readFile(file);
      assert.equal(result.contentSha256, hash(bytes), "Saved media cannot silently change");
      const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 });
      const metadata = await decoder.metadata(); assert.ok(metadata.width > 0 && metadata.height > 0);
      await decoder.stats();
      return result;
    };
    const answer = async (stage, context) => {
      if (stage === "analysis") return JSON.stringify(materialAnalysisFixture());
      if (stage === "plan") return JSON.stringify(materialPlanFixture());
      if (stage === "review-main") return JSON.stringify(materialReviewFixture(reviewPass(context.candidate)));
      const folder = path.join(directory, "private-images", context.task.id);
      await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, "image.png"), png);
      return { taskId: context.task.id, filename: "image.png", contentSha256: hash(png) };
    };
    const resolveProvider = async stage => ({
      bindingId: `offline:${binding}:${stage === "main" ? "image" : stage === "plan" ? "text" : "vision"}`, model: "offline-model-v1",
      async submit(payload, context) {
        await hook("queued", stage, context);
        await context.assertAuthorized({ stage, parentTaskId: context.parentTask.id });
        calls.push({ stage, method: "POST", candidate: context.candidate, payload }); contexts.set(`${stage}:${context.candidate}`, context);
        await hook("before-receipt", stage, context);
        const receipt = `${context.parentTask.id}:${context.task.id}`;
        await context.onReceipt(receipt);
        if (!omitMainCost || stage !== "main") await context.onCost({ micros: 100, currency: "USD" });
        providerResults.set(receipt, await answer(stage, context));
        await hook("after-receipt", stage, context);
        return terminalEnvelopes ? { status: "succeeded", result: providerResults.get(receipt) } : providerResults.get(receipt);
      },
      async query(receipt, context) {
        await context.assertAuthorized({ stage, parentTaskId: context.parentTask.id });
        calls.push({ stage, method: "GET", receipt });
        await hook("query", stage, context);
        return { status: "succeeded", result: providerResults.get(receipt) };
      }
    });
    const make = extra => createAiMaterialDeliveryCoordinator({ transaction, ledger, resultStore: store, loadDraft, resolveProvider, verifyImage, ...extra });
    const item = async (key = "2", scope = "main_only") => {
      number++;
      const source = await query("INSERT INTO listing_drafts(tenant_id,product_name,source_images_json) VALUES(?,'Verified product',?)", [key, JSON.stringify(["https://owned-fixture.invalid/source.png"])]);
      await query("INSERT INTO ai_material_optimization_batches(tenant_id,batch_no,created_by_person_id,optimization_scope) VALUES(?,?,7,?)", [key, `batch-${number}`, scope]);
      const inserted = await query("INSERT INTO ai_material_optimization_items(tenant_id,batch_no,item_no,source_draft_id,created_by_person_id,optimization_scope) VALUES(?,?,?,?,7,?)",
        [key, `batch-${number}`, `item-${number}`, source.insertId, scope]);
      return { id: Number(inserted.insertId), source: Number(source.insertId) };
    };
    const checkpoint = async id => JSON.parse((await query("SELECT checkpoint_json FROM ai_material_optimization_items WHERE id=?", [id]))[0].checkpoint_json).final_delivery_v1;
    const reset = () => { hook = async () => {}; reviewPass = () => true; binding = "original-account"; omitMainCost = false; terminalEnvelopes = false;
      calls.length = 0; contexts.clear(); };

    await t.test("no fabricated parent/stage HTTP fields can create a provider capability", async () => {
      await assert.rejects(assertAiMaterialDeliveryPermit({ stage: "main", parentTaskId: "pretend-paid" }), { code: "AI_MATERIAL_PROVIDER_FORBIDDEN" });
      const row = await item();
      await assert.rejects(make()({ ...actor, tenant: { id: 2, slug: "default" } }, row.id), { code: "TENANT_TASK_ACCESS_DENIED" });
      await assert.rejects(make()({ ...actor, tenant: { id: 3, slug: "enterprise-3" } }, row.id), { code: "AI_MATERIAL_DELIVERY_NOT_FOUND" });
      await assert.rejects(make()({ ...actor, personId: 8 }, row.id), { code: "AI_MATERIAL_DELIVERY_NOT_FOUND" });
      assert.equal(calls.length, 0);
    });
    await t.test("intermediate successes freeze once; only the reviewed private main image settles once", async () => {
      reset(); const row = await item(), before = await ledger.wallet(actor);
      hook = async (point, stage) => {
        if (point === "before-receipt" && stage === "review-main") {
          assert.equal(Number((await ledger.wallet(actor)).frozen_points), Number(before.frozen_points) + 20);
          const cp = await checkpoint(row.id);
          assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='settle'", [cp.taskId]))[0].n, 0);
        }
      };
      const completed = await make()(actor, row.id);
      assert.equal(completed.task.charged_points, 20); assert.equal(completed.task.successful_results, 1);
      assert.equal(Number((await ledger.wallet(actor)).available_points), Number(before.available_points) - 20);
      const cp = await checkpoint(row.id);
      assert.deepEqual(cp.attempts.map(value => value.sequence), [1, 2, 3, 4]);
      assert.equal(cp.attempts.every(value => value.receipt && value.cost.micros === 100 && value.inputReference && value.resultReference), true);
      const attempts = await query("SELECT * FROM ai_credit_attempts WHERE task_id=?", [completed.task.id]);
      assert.equal(attempts.length, 1); assert.equal(Number(attempts[0].supplier_cost_micros), 400);
      assert.equal(attempts[0].provider, "material-coordinator-v1"); assert.match(attempts[0].provider_receipt, /^material-item:/);
      const replay = await make()(actor, row.id);
      assert.equal(replay.task.id, completed.task.id); assert.equal(calls.length, 4); assert.equal((await ledger.audit(actor)).consistent, true);
    });
    await t.test("negative review regenerates within the same quote, retaining candidates and correction", async () => {
      reset(); reviewPass = candidate => candidate === 2; const row = await item();
      const result = await make()(actor, row.id);
      assert.equal(result.result.candidate, 2); assert.equal(result.task.charged_points, 20);
      assert.equal(calls.filter(value => value.stage === "analysis").length, 1);
      assert.equal(calls.filter(value => value.stage === "main").length, 2);
      assert.match(calls.find(value => value.stage === "main" && value.candidate === 2).payload.correction, /Restore/);
      const cp = await checkpoint(row.id); assert.deepEqual(cp.attempts.map(value => value.sequence), [1, 2, 3, 4, 5, 6]);
      assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='settle'", [result.task.id]))[0].n, 1);
    });
    await t.test("no accepted final image releases the whole quote, while actual internal attempts/costs remain", async () => {
      reset(); reviewPass = () => false; const row = await item(), before = await ledger.wallet(actor);
      await assert.rejects(make()(actor, row.id), { code: "AI_CREDIT_TASK_FAILED" });
      assert.equal(Number((await ledger.wallet(actor)).available_points), Number(before.available_points));
      assert.equal(Number((await ledger.wallet(actor)).frozen_points), Number(before.frozen_points));
      const cp = await checkpoint(row.id); assert.equal(cp.attempts.length, 6); assert.equal(cp.status, "failed");
      const [attempt] = await query("SELECT * FROM ai_credit_attempts WHERE task_id=?", [cp.taskId]);
      assert.equal(Number(attempt.supplier_cost_micros), 600); assert.equal((await ledger.task(actor, cp.taskId)).charged_points, 0);
    });
    await t.test("an explicit stage rejection retries with a monotonic attempt, never another customer quote", async () => {
      reset(); let failed = false; const row = await item();
      hook = async (point, stage) => { if (!failed && point === "before-receipt" && stage === "plan") { failed = true; throw Object.assign(new Error("Explicit rejection"), { definiteFailure: true }); } };
      const result = await make()(actor, row.id);
      assert.equal(result.task.charged_points, 20);
      assert.deepEqual((await checkpoint(row.id)).attempts.map(value => value.status), ["succeeded", "failed", "succeeded", "succeeded", "succeeded"]);
    });
    await t.test("a submitted unknown without receipt never reposts after a fresh coordinator", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "before-receipt" && stage === "analysis") throw new Error("Unknown network acceptance"); };
      await assert.rejects(make()(actor, row.id), /Unknown network acceptance/);
      const cp = await checkpoint(row.id); assert.equal(cp.status, "unknown"); assert.equal(cp.attempts[0].receipt, undefined);
      reset(); await assert.rejects(make({ maxCandidates: 1 })(actor, row.id), { code: "AI_MATERIAL_POLICY_CHANGED" }); assert.equal(calls.length, 0);
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_DELIVERY_PENDING" }); assert.equal(calls.length, 0);
      assert.equal((await ledger.task(actor, cp.taskId)).status, "unknown");
    });
    await t.test("receipt commits before query, original account is pinned, and restart recovers without POST", async () => {
      reset(); const row = await item();
      hook = async (point, stage, context) => {
        if (point === "after-receipt" && stage === "analysis") {
          assert.ok((await checkpoint(row.id)).attempts[0].receipt); throw new Error("Polling timeout");
        }
      };
      await assert.rejects(make()(actor, row.id), /Polling timeout/); reset(); binding = "rotated-account";
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_DELIVERY_PENDING" }); assert.equal(calls.length, 0);
      reset(); const result = await make()(actor, row.id);
      assert.equal(result.task.charged_points, 20);
      assert.deepEqual(calls.filter(value => value.stage === "analysis").map(value => value.method), ["GET"]);
    });
    await t.test("member revoked in flight stops the next stage, then private output recovers after reauthorization", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "after-receipt" && stage === "analysis") await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7"); };
      await assert.rejects(make()(actor, row.id), { code: "TENANT_TASK_ACCESS_DENIED" }); assert.equal(calls.length, 1);
      reset(); await assert.rejects(make()(actor, row.id), { code: "TENANT_TASK_ACCESS_DENIED" }); assert.equal(calls.length, 0);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
      const result = await make()(actor, row.id); assert.equal(result.task.charged_points, 20);
      assert.equal(calls.some(value => value.stage === "analysis"), false, "Durable response survives revoked checkpoint write");
    });
    await t.test("source ownership or source version changes pause the original quote, with no replacement input", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "after-receipt" && stage === "analysis") await query("UPDATE listing_drafts SET tenant_id='3' WHERE id=?", [row.source]); };
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_SOURCE_CHANGED" }); reset();
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_SOURCE_CHANGED" }); assert.equal(calls.length, 0);
      await query("UPDATE listing_drafts SET tenant_id='2',product_name='Changed product' WHERE id=?", [row.source]);
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_SOURCE_CHANGED" });
      await query("UPDATE listing_drafts SET product_name='Verified product' WHERE id=?", [row.source]);
      assert.equal((await make()(actor, row.id)).task.charged_points, 20); assert.equal(calls.some(value => value.stage === "analysis"), false);
    });
    await t.test("URL-only media is rejected before reserve, and changed bytes behind a stable URL cannot replace the source", async () => {
      reset(); const row = await item();
      const urlOnly = async (_c, value) => ({ ...value, effective_images: JSON.parse(value.source_images_json) });
      await assert.rejects(make({ loadDraft: urlOnly })(actor, row.id), { code: "AI_MATERIAL_SOURCE_UNFROZEN" });
      assert.equal((await query("SELECT checkpoint_json FROM ai_material_optimization_items WHERE id=?", [row.id]))[0].checkpoint_json, null);
      hook = async (point, stage) => { if (point === "after-receipt" && stage === "analysis") await fs.writeFile(sourcePath, Buffer.concat([png, Buffer.from("different-source-version")])); };
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_SOURCE_CHANGED" }); assert.equal(calls.length, 1);
      hook = async () => {}; await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_SOURCE_CHANGED" });
      await fs.writeFile(sourcePath, png); reset();
      assert.equal((await make()(actor, row.id)).task.charged_points, 20); assert.equal(calls.some(value => value.stage === "analysis"), false);
    });
    await t.test("same-item concurrency rejects a second claim before any duplicate provider call", async () => {
      reset(); const row = await item(), entered = deferred(), release = deferred();
      hook = async (point, stage) => { if (point === "before-receipt" && stage === "analysis") { entered.resolve(); await release.promise; } };
      const first = make()(actor, row.id); first.catch(() => {}); await entered.promise;
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_DELIVERY_BUSY" });
      release.resolve(); await first; assert.equal(calls.filter(value => value.stage === "analysis").length, 1);
    });
    await t.test("expired lease cannot revive itself by late receipt; a new claimant uses private output without repost", async () => {
      reset(); const row = await item(), entered = deferred(), release = deferred();
      hook = async (point, stage) => { if (point === "before-receipt" && stage === "analysis") { entered.resolve(); await release.promise; } };
      const first = make({ leaseMs: 1000 })(actor, row.id); first.catch(() => {}); await entered.promise;
      await new Promise(done => setTimeout(done, 1100));
      await assert.rejects(make({ leaseMs: 1000 })(actor, row.id), { code: "AI_MATERIAL_DELIVERY_PENDING" });
      release.resolve(); await assert.rejects(first, { code: "AI_MATERIAL_LEASE_LOST" });
      reset(); assert.equal((await make()(actor, row.id)).task.charged_points, 20);
      assert.equal(calls.some(value => value.stage === "analysis"), false);
    });
    await t.test("business cancellation fences the current provider permit and prevents later stages", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "after-receipt" && stage === "analysis") await query("UPDATE ai_material_optimization_items SET status='paused_review' WHERE id=?", [row.id]); };
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_BUSINESS_STOPPED" }); reset();
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_BUSINESS_STOPPED" }); assert.equal(calls.length, 0);
    });
    await t.test("authorization is checked after waiting on the real item row lock", async () => {
      reset(); const row = await item(), lock = await pool.getConnection(); await lock.beginTransaction();
      await lock.execute("SELECT id FROM ai_material_optimization_items WHERE id=? FOR UPDATE", [row.id]);
      const waiting = make()(actor, row.id); waiting.catch(() => {});
      await new Promise(done => setTimeout(done, 50));
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await lock.commit(); lock.release();
      await assert.rejects(waiting, { code: "TENANT_TASK_ACCESS_DENIED" }); assert.equal(calls.length, 0);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("a queue rechecks the active parent wallet before any actual supplier POST", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "queued" && stage === "analysis") await ledger.configureAccount(platform, { tenantId: 2, status: "disabled" }); };
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_PARENT_BLOCKED" }); assert.equal(calls.length, 0);
      await ledger.configureAccount(platform, { tenantId: 2, status: "active" });
      reset(); await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_DELIVERY_PENDING" }); assert.equal(calls.length, 0);
    });
    await t.test("unattested malformed stage JSON never gains legacy fallback or a customer success", async () => {
      reset(); const row = await item();
      hook = async (point, stage, context) => {
        if (point === "after-receipt" && stage === "analysis") providerResults.set(`${context.parentTask.id}:${context.task.id}`, JSON.stringify({ ...materialAnalysisFixture(), fallback: true }));
      };
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_RESULT_INVALID" });
      assert.equal((await ledger.task(actor, (await checkpoint(row.id)).taskId)).charged_points, 0);
      reset(); binding = "different-account";
      await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_DELIVERY_PENDING" }); assert.equal(calls.length, 0);
    });
    await t.test("definitely completed unusable text retries within one quote, preserving the raw completion proof", async () => {
      reset(); terminalEnvelopes = true; const row = await item(); let invalid = false;
      hook = async (point, stage, context) => {
        if (!invalid && point === "after-receipt" && stage === "plan") {
          invalid = true; providerResults.set(`${context.parentTask.id}:${context.task.id}`, "not JSON");
        }
      };
      const result = await make()(actor, row.id); assert.equal(result.task.charged_points, 20);
      const failed = (await checkpoint(row.id)).attempts.find(value => value.failureKind === "completed-invalid-structure");
      const proof = await store.read(failed.completionReference, failed.completionSha256,
        { id: failed.completionTaskId, tenant_id: 2, input_sha256: failed.inputSha256 });
      assert.equal(proof.result, "not JSON"); assert.equal(proof.receipt, failed.receipt);
      assert.equal(calls.filter(value => value.stage === "plan").length, 2);
    });
    await t.test("exhausted definite completed JSON failures release the whole hold rather than freeze forever", async () => {
      reset(); terminalEnvelopes = true; const row = await item(), before = await ledger.wallet(actor);
      hook = async (point, stage, context) => {
        if (point === "after-receipt" && stage === "analysis") providerResults.set(`${context.parentTask.id}:${context.task.id}`, "{}");
      };
      await assert.rejects(make()(actor, row.id), { code: "AI_CREDIT_TASK_FAILED" });
      const cp = await checkpoint(row.id); assert.equal(cp.attempts.length, 2);
      assert.equal(cp.attempts.every(value => value.failureKind === "completed-invalid-structure" && value.completionReference), true);
      assert.equal((await ledger.task(actor, cp.taskId)).charged_points, 0);
      assert.equal(Number((await ledger.wallet(actor)).available_points), Number(before.available_points));
      assert.equal(Number((await ledger.wallet(actor)).frozen_points), Number(before.frozen_points));
    });
    await t.test("stage private output survives a rolled-back checkpoint and resumes without another query or POST", async () => {
      reset(); const row = await item(); let interrupted = false;
      const flakyTransaction = operation => transaction(c => operation({ execute: async (sql, values) => {
        if (!interrupted && sql.startsWith("UPDATE ai_material_optimization_items SET checkpoint_json=")) {
          const cp = JSON.parse(values[0]).final_delivery_v1;
          if (cp.attempts.some(value => value.stage === "analysis" && value.status === "succeeded")) {
            interrupted = true; throw new Error("Fixture checkpoint write interrupted");
          }
        }
        return c.execute(sql, values);
      } }));
      await assert.rejects(make({ transaction: flakyTransaction })(actor, row.id), /Fixture checkpoint write interrupted/);
      reset(); assert.equal((await make()(actor, row.id)).task.charged_points, 20);
      assert.equal(calls.some(value => value.stage === "analysis"), false);
    });
    await t.test("final private file survives settlement failure and late cost, then settles original bytes without supplier calls", async () => {
      reset(); omitMainCost = true; const row = await item(); let injected = false;
      const flakyLedger = { ...ledger, recordOutcome: async (...args) => {
        if (!injected && args[2].outcome === "succeeded") { injected = true; throw new Error("Fixture settlement interruption"); }
        return ledger.recordOutcome(...args);
      } };
      await assert.rejects(make({ ledger: flakyLedger })(actor, row.id), /Fixture settlement interruption/);
      await contexts.get("main:1").onCost({ micros: 100, currency: "USD" });
      reset(); const result = await make()(actor, row.id);
      assert.equal(result.task.charged_points, 20); assert.equal(calls.length, 0);
      assert.equal(Number((await query("SELECT supplier_cost_micros FROM ai_credit_attempts WHERE task_id=?", [result.task.id]))[0].supplier_cost_micros), 400);
    });
    await t.test("committed customer settlement repairs its failed final checkpoint without another bill or provider call", async () => {
      reset(); const row = await item(); let interrupted = false;
      const flakyTransaction = operation => transaction(c => operation({ execute: async (sql, values) => {
        if (!interrupted && sql.startsWith("UPDATE ai_material_optimization_items SET checkpoint_json=")
          && JSON.parse(values[0]).final_delivery_v1.status === "succeeded") {
          interrupted = true; throw new Error("Fixture post-settlement checkpoint interrupted");
        }
        return c.execute(sql, values);
      } }));
      await assert.rejects(make({ transaction: flakyTransaction })(actor, row.id), /Fixture post-settlement checkpoint interrupted/);
      const old = await checkpoint(row.id); assert.equal(old.status, "unknown");
      assert.equal((await ledger.task(actor, old.taskId)).status, "succeeded"); reset();
      const restored = await make()(actor, row.id), repaired = await checkpoint(row.id);
      assert.equal(restored.task.id, old.taskId); assert.equal(calls.length, 0); assert.equal(repaired.status, "succeeded");
      assert.equal(repaired.finalReference, restored.task.result_reference); assert.equal(repaired.finalSha256, restored.task.result_sha256);
      assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='settle'", [old.taskId]))[0].n, 1);
    });
    await t.test("committed release repairs a failed terminal checkpoint without pretending the supplier failed", async () => {
      reset(); reviewPass = () => false; const row = await item(); let interrupted = false;
      const flakyTransaction = operation => transaction(c => operation({ execute: async (sql, values) => {
        if (!interrupted && sql.startsWith("UPDATE ai_material_optimization_items SET checkpoint_json=")
          && JSON.parse(values[0]).final_delivery_v1.status === "failed") {
          interrupted = true; throw new Error("Fixture post-release checkpoint interrupted");
        }
        return c.execute(sql, values);
      } }));
      await assert.rejects(make({ transaction: flakyTransaction })(actor, row.id), /Fixture post-release checkpoint interrupted/);
      const old = await checkpoint(row.id); assert.equal(old.status, "unknown");
      assert.equal((await ledger.task(actor, old.taskId)).status, "failed"); reset();
      await assert.rejects(make()(actor, row.id), { code: "AI_CREDIT_TASK_FAILED" });
      const repaired = await checkpoint(row.id); assert.equal(repaired.status, "failed"); assert.equal(repaired.failure, "recovered-wallet-failure");
      assert.equal(calls.length, 0); assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='release'", [old.taskId]))[0].n, 1);
    });
    await t.test("actual supplier costs arriving after settlement remain evidence and never rewrite the customer bill", async () => {
      reset(); omitMainCost = true; const row = await item();
      const result = await make()(actor, row.id), context = contexts.get("main:1"), before = await ledger.wallet(actor);
      assert.equal((await query("SELECT supplier_cost_micros FROM ai_credit_attempts WHERE task_id=?", [result.task.id]))[0].supplier_cost_micros, null);
      await context.onCost({ micros: 100, currency: "USD" }); await context.onCost({ micros: 100, currency: "USD" });
      const known = (await checkpoint(row.id)).attempts.find(value => value.stage === "main"); assert.deepEqual(known.cost, { micros: 100, currency: "USD" });
      await assert.rejects(context.onCost({ micros: 101, currency: "USD" }), { code: "AI_MATERIAL_COST_INVALID" });
      const replay = await make()(actor, row.id); assert.equal(replay.task.charged_points, 20);
      assert.equal(Number((await ledger.wallet(actor)).available_points), Number(before.available_points));
      assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='settle'", [result.task.id]))[0].n, 1);
      // Composite wallet cost is a settlement-time projection. Later confirmed
      // attempt facts remain in the checkpoint for a future cost-only reconciler.
      assert.equal((await query("SELECT supplier_cost_micros FROM ai_credit_attempts WHERE task_id=?", [result.task.id]))[0].supplier_cost_micros, null);
    });
    await t.test("manual success racing a final failure never claims refund or overwrites the reviewed bill", async () => {
      reset(); reviewPass = () => false; const row = await item(); let reconciled = false;
      const racingLedger = { ...ledger, recordOutcome: async (...args) => {
        if (!reconciled && args[2].outcome === "failed") {
          reconciled = true;
          await ledger.reconcile(platform, { tenantId: 2, taskId: args[1], successfulResults: 1,
            resultReference: "reviewed:external-result", resultSha256: hash("reviewed-external-result"), reason: "Offline manual success race" });
        }
        return ledger.recordOutcome(...args);
      } };
      await assert.rejects(make({ ledger: racingLedger })(actor, row.id), error => error.code === "AI_MATERIAL_RECONCILIATION_REQUIRED" && !error.message.includes("已释放"));
      const cp = await checkpoint(row.id), task = await ledger.task(actor, cp.taskId);
      assert.equal(cp.status, "unknown"); assert.equal(cp.requiresReconciliation, true);
      assert.equal(task.status, "succeeded"); assert.equal(task.charged_points, 20); assert.equal(task.result_reference, "reviewed:external-result");
      assert.equal((await query("SELECT billing_conflict FROM ai_credit_attempts WHERE task_id=?", [task.id]))[0].billing_conflict, 1);
      assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='release'", [task.id]))[0].n, 0);
      reset(); await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_RECONCILIATION_REQUIRED" }); assert.equal(calls.length, 0);
      assert.equal((await checkpoint(row.id)).status, "unknown"); assert.equal((await ledger.task(actor, task.id)).result_reference, "reviewed:external-result");
    });
    await t.test("manual refund racing final success retains a conflict and never fabricates paid delivery", async () => {
      reset(); const row = await item(); let reconciled = false;
      const racingLedger = { ...ledger, recordOutcome: async (...args) => {
        if (!reconciled && args[2].outcome === "succeeded") {
          reconciled = true;
          await ledger.reconcile(platform, { tenantId: 2, taskId: args[1], successfulResults: 0, reason: "Offline manual release race" });
        }
        return ledger.recordOutcome(...args);
      } };
      await assert.rejects(make({ ledger: racingLedger })(actor, row.id), { code: "AI_MATERIAL_RECONCILIATION_REQUIRED" });
      const cp = await checkpoint(row.id), task = await ledger.task(actor, cp.taskId);
      assert.equal(cp.status, "unknown"); assert.equal(cp.requiresReconciliation, true); assert.equal(task.status, "failed"); assert.equal(task.charged_points, 0);
      reset(); await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_RECONCILIATION_REQUIRED" }); assert.equal(calls.length, 0);
      assert.equal((await query("SELECT COUNT(*) n FROM ai_credit_entries WHERE task_id=? AND kind='release'", [task.id]))[0].n, 1);
    });
    await t.test("reviewed successful external results are not treated as a verified local final package", async () => {
      reset(); const row = await item();
      hook = async (point, stage) => { if (point === "before-receipt" && stage === "analysis") throw new Error("Unknown upstream acceptance"); };
      await assert.rejects(make()(actor, row.id), /Unknown upstream acceptance/);
      const cp = await checkpoint(row.id);
      await ledger.reconcile(platform, { tenantId: 2, taskId: cp.taskId, successfulResults: 1,
        resultReference: "reviewed:external-success", resultSha256: hash("external-success"), reason: "Offline separately verified external result" });
      reset(); await assert.rejects(make()(actor, row.id), { code: "AI_MATERIAL_RECONCILIATION_REQUIRED" }); assert.equal(calls.length, 0);
      const current = await checkpoint(row.id); assert.equal(current.status, "unknown"); assert.equal(current.finalReference, undefined);
      assert.equal((await ledger.task(actor, cp.taskId)).result_reference, "reviewed:external-success");
    });
    await t.test("corrupted saved pixels block recovery and keep hold without new supplier calls", async () => {
      reset(); const row = await item(); let interrupted = false;
      const flakyLedger = { ...ledger, recordOutcome: async (...args) => {
        if (!interrupted && args[2].outcome === "succeeded") { interrupted = true; throw new Error("Fixture interruption"); }
        return ledger.recordOutcome(...args);
      } };
      await assert.rejects(make({ ledger: flakyLedger })(actor, row.id), /Fixture interruption/);
      const file = path.join(directory, "private-images", contexts.get("main:1").task.id, "image.png");
      await fs.writeFile(file, Buffer.from("corrupt")); reset();
      await assert.rejects(make()(actor, row.id), /Saved media cannot silently change/); assert.equal(calls.length, 0);
      assert.equal((await ledger.task(actor, (await checkpoint(row.id)).taskId)).status, "unknown");
      await fs.writeFile(file, png); await make()(actor, row.id);
    });
    await t.test("disabled account, no balance and unsupported full bundle never start an upstream request", async () => {
      reset(); const row = await item(); await ledger.configureAccount(platform, { tenantId: 2, status: "disabled" });
      await assert.rejects(make()(actor, row.id), { code: "AI_CREDIT_ACCOUNT_DISABLED" }); assert.equal(calls.length, 0);
      await ledger.configureAccount(platform, { tenantId: 2, status: "active" });
      const full = await item("2", "full");
      await assert.rejects(make()(actor, full.id), { code: "AI_CREDIT_CAPABILITY_DISABLED" }); assert.equal(calls.length, 0);
      await ledger.createPrice(platform, { priceKey: "material.unaffordable", version: 1, pointsPerResult: 20000 });
      const expensive = await item();
      await assert.rejects(make({ priceKey: "material.unaffordable" })(actor, expensive.id), { code: "AI_CREDIT_INSUFFICIENT" }); assert.equal(calls.length, 0);
      assert.equal((await ledger.audit(actor)).consistent, true);
    });
    await t.test("default tenant identity comes from the database, and null legacy draft ownership maps to that tenant only", async () => {
      reset(); const row = await item("admin"); await query("UPDATE listing_drafts SET tenant_id=NULL WHERE id=?", [row.source]);
      assert.equal((await make()({ ...actor, tenant: { id: 17, slug: "default" } }, row.id)).task.charged_points, 20);
      await assert.rejects(make()({ ...actor, tenant: { id: 2, slug: "default" } }, row.id), { code: "TENANT_TASK_ACCESS_DENIED" });
    });
  } finally {
    if (pool) await pool.end();
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

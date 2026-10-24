import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AI_CREDIT_SCHEMAS } from "../src/services/ai-credit-schema.js";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("prepaid image workflow: real SQL, real image decode, offline transport, recovery and no free bypass", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Explicit isolated MySQL socket required", timeout: 60000
}, async t => {
  const fixture = await createTenantMysqlFixture("ai_credit_image");
  fixture.useEnvironment();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-credit-image-"));
  process.env.AI_IMAGE_OUTPUT_DIR = path.join(directory, "images");
  process.env.AI_CREDIT_RESULT_ROOT = path.join(directory, "private-results");
  const { withAiTenantSession, withAiTenantRequestGuard, reserveTenantAiRequest } = await import("../src/services/ai-tenant-context.js");
  const { withAiCreditOperation, aiCreditRuntime, readAiCreditMode, createAiCreditRuntime } = await import("../src/services/ai-credit-runtime.js");
  const { createAiCreditLedger } = await import("../src/services/ai-credit-ledger.js");
  const { generateImages, getAiTaskFile } = await import("../src/server/services/ai/aiWorkflowService.js");
  const { generateOpenAiImages, editOpenAiImage, testOpenAiImageProvider } = await import("../src/server/services/openai/imageGenerationService.js");
  const { updateAiProviderConfig, aiImageRuntimePoolConfig, chatWithAiProvider, visionWithAiProvider, streamAiProviderResponse, testAiProviderConfig, generateSelectionSellingPoints } = await import("../src/services/ai-provider-settings.js");
  const { withMysqlTransaction, closeMysqlPool } = await import("../src/mysql-pool.js");
  const actor = { personId: 7, tenant: { id: 2, slug: "customer-a" } };
  const admin = { personId: 9, platform_role: "super_admin" };
  const ledger = createAiCreditLedger({ transaction: withMysqlTransaction });
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const oldFetch = globalThis.fetch;
  let behavior = "success", submissions = 0, polls = 0, block, accept;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("data:image/png;base64,")) return new Response(png, { headers: { "Content-Type": "image/png" } });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "paid-fixture.invalid", "No real upstream may be contacted");
    calls.push({ method: options.method, path: parsed.pathname, authorization: options.headers?.Authorization });
    if (options.method === "GET") {
      polls++;
      if (behavior === "timeout") throw Object.assign(new Error("fixture status unavailable"), { name: "FixtureNetworkError" });
      if (behavior === "terminal") return Response.json({ status: "failed", error_message: "explicit failure" });
      return Response.json({ status: "succeeded", url: `data:image/png;base64,${png.toString("base64")}` });
    }
    submissions++;
    if (block) { accept(); await block; }
    if (behavior === "async" || behavior === "timeout" || behavior === "terminal") return Response.json({ id: `receipt-${submissions}` });
    return Response.json({ data: [{ b64_json: behavior === "invalid" ? Buffer.from("not an image").toString("base64") : png.toString("base64") }] });
  };
  const configure = async (apiMode = "images", apiKey = "fixture-secret") => updateAiProviderConfig({ provider: "custom", baseUrl: "https://paid-fixture.invalid/v1",
    apiKey, textModel: "fixture-text", imageModel: "fixture-image", enabled: true,
    routes: { text: { provider: "custom", model: "fixture-text" }, vision: { provider: "custom", model: "fixture-text" }, image: { provider: "custom", model: "fixture-image" } },
    imageProviderPool: { enabled: true, channels: [{ id: "fixture", provider: "custom", name: "fixture", baseUrl: "https://paid-fixture.invalid/v1", apiKey, imageModel: "fixture-image", apiMode, enabled: true, maxConcurrency: 1 }] }
  }, 9);
  const generate = (key, payload = {}, session = actor) => withAiTenantSession(session, () => withAiCreditOperation(key, () => generateImages({ finalPrompt: "A blue product", autoCrop: false, ...payload })));
  const tasks = () => fixture.query("SELECT * FROM ai_credit_tasks ORDER BY created_at,id");
  try {
    for (const schema of AI_CREDIT_SCHEMAS) await fixture.query(schema);
    await fixture.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Internal'),(2,'customer-a','A'),(3,'customer-b','B')");
    await fixture.query("INSERT INTO people(id,name,role) VALUES(7,'Operator','operations'),(9,'Platform','admin')");
    await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations'))");
    await fixture.query("INSERT INTO platform_grants(person_id,role,active,reason) VALUES(9,'super_admin',1,'Offline fixture')");
    await configure();
    await t.test("default internal mode remains legacy; opt-in is explicit and durable", async () => {
      await assert.rejects(readAiCreditMode(actor), { code: "AI_CREDIT_ACCOUNT_NOT_CONFIGURED" });
      await assert.rejects(readAiCreditMode({ ...actor, tenant: { id: 2, slug: "default" } }), { code: "AI_CREDIT_ACCOUNT_NOT_CONFIGURED" });
      await assert.rejects(withAiTenantSession({ ...actor, tenant: { id: 3, slug: "customer-b" } }, () => chatWithAiProvider({ prompt: "unconfigured" })), { code: "AI_CREDIT_ACCOUNT_NOT_CONFIGURED" });
      assert.equal((await tasks()).length, 0);
      const internal = { ...actor, tenant: { id: 1, slug: "default" } };
      const legacy = await generate(null, {}, internal);
      assert.equal(legacy.generatedImages.length, 1);
      assert.equal((await tasks()).length, 0);
      assert.equal(Number((await fixture.query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id=1"))[0].request_count), 1);
      submissions = 0; calls.length = 0;
      await ledger.configureAccount(admin, { tenantId: 2, status: "active" });
      assert.equal((await readAiCreditMode(actor)).mode, "credits");
      await assert.rejects(generate("unpriced"), { code: "AI_CREDIT_PRICE_UNAVAILABLE" });
      await ledger.createPrice(admin, { priceKey: "image.generate", version: 1, pointsPerResult: 10 });
      await ledger.recharge(admin, { tenantId: 2, reference: "fixture-recharge", points: 200, reason: "Offline fixture only" });
    });
    await t.test("concurrent replay submits once, validates pixels, bills once and reuses saved result", async () => {
      let release;
      block = new Promise(resolve => { release = resolve; });
      const accepted = new Promise(resolve => { accept = resolve; });
      const first = generate("stable-worker-1"); first.catch(() => {});
      await accepted;
      await assert.rejects(generate("stable-worker-1"), { code: "AI_CREDIT_RESULT_PENDING" });
      release(); block = null;
      const result = await first;
      assert.equal(result.generatedImages.length, 1);
      assert.match(result.generatedImages[0].contentSha256, /^[a-f0-9]{64}$/);
      const replay = await generate("stable-worker-1");
      assert.equal(replay.taskId, result.taskId); assert.equal(submissions, 1);
      assert.equal(Number((await ledger.wallet(actor)).available_points), 190);
      assert.equal((await ledger.audit(actor)).consistent, true);
      await assert.rejects(generate("stable-worker-1", { finalPrompt: "Different request" }), { code: "AI_CREDIT_CONFLICT" });
      await assert.rejects(withAiTenantSession({ ...actor, tenant: { id: 3, slug: "customer-b" } }, () => getAiTaskFile(result.taskId, "generated", result.generatedImages[0].filename)), { status: 404 });
    });
    await t.test("client runtime credentials/providerJob cannot select another account or endpoint", async () => {
      const result = await generate("untrusted-config", { runtimeConfig: { apiKey: "stolen", baseUrl: "https://evil.invalid", imageModel: "evil" }, providerJob: { jobId: "forged", statusUrl: "https://evil.invalid" } });
      assert.equal(result.model, "fixture-image");
      assert.equal(calls.at(-1).authorization, "Bearer fixture-secret");
      assert.equal(calls.at(-1).method, "POST");
    });
    await t.test("invalid input and foreign private references fail before freezing any points", async () => {
      const before = submissions, taskCount = (await tasks()).length, wallet = await ledger.wallet(actor);
      await fixture.query("INSERT INTO ai_image_task_owners(task_id,tenant_id,created_by_person_id) VALUES('foreign-reference','3',7)");
      for (const sourceImageUrl of ["not-a-url", "ftp://invalid.example/image.png", "data:image/png;base64,AA=="]) {
        await assert.rejects(generate(`invalid-source-${sourceImageUrl.length}`, { sourceImageUrl }), { status: 400 });
      }
      await assert.rejects(generate("foreign-reference", { sourceImageUrl: "/api/ai/file/foreign-reference/generated/image.png" }), { status: 404 });
      assert.equal(submissions, before); assert.equal((await tasks()).length, taskCount);
      assert.equal(Number((await ledger.wallet(actor)).frozen_points), Number(wallet.frozen_points));
    });
    await t.test("invalid 200 image stays uncharged and held, with no blind retry", async () => {
      behavior = "invalid";
      const before = submissions;
      await assert.rejects(generate("bad-image"), { code: "AI_CREDIT_RESULT_PENDING" });
      await assert.rejects(generate("bad-image"), { code: "AI_CREDIT_RESULT_PENDING" });
      assert.equal(submissions, before + 1);
      assert.equal(Number((await ledger.wallet(actor)).frozen_points), 10);
      behavior = "success";
    });
    await t.test("receipt is committed before polling, and a fresh runtime recovers without resubmitting", async () => {
      await configure("tasks_65535"); behavior = "timeout";
      const before = submissions;
      await assert.rejects(generate("receipt-recovery"), { code: "AI_CREDIT_RESULT_PENDING" });
      const [attempt] = await fixture.query("SELECT a.* FROM ai_credit_attempts a JOIN ai_credit_tasks t ON t.id=a.task_id WHERE a.provider_receipt IS NOT NULL ORDER BY a.created_at DESC LIMIT 1");
      assert.equal(attempt.provider_receipt, `receipt-${submissions}`);
      const [task] = await fixture.query("SELECT * FROM ai_credit_tasks WHERE id=?", [attempt.task_id]);
      assert.equal(task.status, "unknown");
      const beforePolls = polls;
      await configure("tasks_65535", "rotated-account");
      await assert.rejects(generate("receipt-recovery"), { code: "AI_CREDIT_RESULT_PENDING" });
      assert.equal(submissions, before + 1); assert.equal(polls, beforePolls, "Never query the old receipt using a changed upstream account");
      await configure("tasks_65535");
      behavior = "success";
      const fresh = createAiCreditRuntime();
      // Recreate the module boundary after restart, while retaining wallet and receipt.
      const result = await withAiTenantSession(actor, () => withAiCreditOperation("receipt-recovery", () => generateImages({ finalPrompt: "A blue product", autoCrop: false }, { creditRuntime: fresh })));
      assert.equal(result.taskId, task.id); assert.equal(submissions, before + 1); assert.ok(polls >= 2);
      assert.equal((await fresh.mode(actor)).mode, "credits");
      assert.equal((await ledger.task(actor, task.id)).status, "succeeded");
    });
    await t.test("an explicit terminal provider failure releases the hold without charging the customer", async () => {
      behavior = "terminal";
      const balance = await ledger.wallet(actor);
      await assert.rejects(generate("terminal-failed"), { code: "AI_CREDIT_TASK_FAILED" });
      const after = await ledger.wallet(actor);
      assert.equal(Number(after.available_points), Number(balance.available_points));
      assert.equal(Number(after.frozen_points), Number(balance.frozen_points));
      behavior = "success";
    });
    await t.test("account disabled while waiting for an image slot is rechecked after the queue", async () => {
      const { withAiImageRuntimeSlot, aiImageRuntimeMetrics } = await import("../src/services/ai-image-runtime-limiter.js");
      const [channel] = await aiImageRuntimePoolConfig();
      let release, entered;
      const blockerEntered = new Promise(resolve => { entered = resolve; });
      const blocking = withAiTenantSession(actor, () => withAiImageRuntimeSlot(channel, async () => { entered(); await new Promise(resolve => { release = resolve; }); }));
      await blockerEntered;
      const before = submissions;
      const queued = generate("disabled-in-queue"); queued.catch(() => {});
      for (let i = 0; i < 100 && !aiImageRuntimeMetrics().waitingTotal; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(aiImageRuntimeMetrics().waitingTotal > 0);
      await ledger.configureAccount(admin, { tenantId: 2, status: "disabled" });
      release(); await blocking;
      await assert.rejects(queued, { code: "AI_CREDIT_RESULT_PENDING" });
      assert.equal(submissions, before);
      await ledger.configureAccount(admin, { tenantId: 2, status: "active" });
    });
    await t.test("current resource/member revocation blocks execution before another supplier call", async () => {
      const before = submissions;
      await assert.rejects(withAiTenantSession(actor, () => withAiTenantRequestGuard(() => { throw Object.assign(new Error("cancelled"), { code: "cancelled" }); }, () => generateImages({ finalPrompt: "blocked", idempotencyKey: "cancelled" }))), { code: "cancelled" });
      await fixture.query("UPDATE tenant_members SET active=0 WHERE tenant_id=2");
      await assert.rejects(generate("revoked"), { code: "TENANT_TASK_ACCESS_DENIED" });
      assert.equal(submissions, before);
      await fixture.query("UPDATE tenant_members SET active=1 WHERE tenant_id=2");
    });
    await t.test("active accounts cannot bypass via low-level image, saved poll, text, vision, stream or test config", async () => {
      const before = submissions + polls;
      const [runtime] = await aiImageRuntimePoolConfig();
      for (const operation of [
        () => reserveTenantAiRequest("text"),
        () => generateOpenAiImages({ taskId: randomUUID(), finalPrompt: "bypass", runtimeConfig: runtime, providerJob: { jobId: "saved" } }),
        () => editOpenAiImage({ imageBuffer: png, prompt: "bypass", runtimeConfig: runtime }),
        () => chatWithAiProvider({ prompt: "bypass" }),
        () => visionWithAiProvider({ messages: [{ role: "user", content: "bypass" }] }),
        () => streamAiProviderResponse({ prompt: "bypass" }),
        () => testAiProviderConfig({ provider: "custom", baseUrl: runtime.baseUrl, apiKey: "override", textModel: "fixture" })
      ]) await assert.rejects(withAiTenantSession(actor, operation), { code: "AI_CREDIT_CAPABILITY_DISABLED" });
      const diagnostics = await withAiTenantSession(actor, () => testOpenAiImageProvider({ runtimeConfig: runtime }));
      assert.equal(diagnostics.ok, false);
      assert.equal(submissions + polls, before);
    });
    await t.test("disabled account, missing wallet, missing price, insufficient balance and absent key fail closed", async () => {
      const before = submissions;
      await assert.rejects(generate(null), { code: "AI_CREDIT_IDEMPOTENCY_REQUIRED" });
      await assert.rejects(generate("multi", { imageCount: 2 }), { code: "AI_CREDIT_CAPABILITY_DISABLED" });
      await ledger.configureAccount(admin, { tenantId: 2, status: "disabled" });
      await assert.rejects(generate("disabled"), { code: "AI_CREDIT_ACCOUNT_DISABLED" });
      await assert.rejects(withAiTenantSession(actor, () => chatWithAiProvider({ prompt: "bypass" })), { code: "AI_CREDIT_ACCOUNT_DISABLED" });
      await ledger.configureAccount(admin, { tenantId: 2, status: "active" });
      await fixture.query("RENAME TABLE ai_credit_accounts TO fixture_accounts_saved");
      try { await assert.rejects(generate("table-missing"), { code: "AI_CREDIT_STORAGE_UNAVAILABLE" }); }
      finally { await fixture.query("RENAME TABLE fixture_accounts_saved TO ai_credit_accounts"); }
      await fixture.query("UPDATE ai_credit_accounts SET available_points=0 WHERE tenant_id=2");
      await assert.rejects(generate("insufficient"), { code: "AI_CREDIT_INSUFFICIENT" });
      assert.equal(submissions, before);
    });
  } finally {
    globalThis.fetch = oldFetch;
    await closeMysqlPool();
    await fixture.cleanup();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

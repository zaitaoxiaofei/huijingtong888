import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import crypto from "node:crypto";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { shanghaiDateKey } from "../src/shanghai-time.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";
import { migrateTenantAiBackground } from "../scripts/migrate-tenant-ai-background.mjs";
import { AI_IMAGE_TASK_OWNERS_SCHEMA, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";
import { checkAiCreditProviderBoundary, withAiCreditOperation } from "../src/services/ai-credit-provider-context.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const load = (context, file) => vm.runInContext(read(file).replace(/^import[^;]*;\r?\n/gm, "").replaceAll("export ", ""), context, { filename: file });

test("AI business data and quota remain isolated for A/B/default in real MySQL", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_ai_test_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let created = false, pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 6 });
    const query = async (sql, params = []) => (await pool.query(sql, params))[0];
    const execute = async (sql, params = []) => (await pool.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL, feature_flags_json JSON NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, name VARCHAR(80), active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))"
    ]) await query(sql);
    await query("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await query("UPDATE tenants SET feature_flags_json=JSON_OBJECT('ai_internal_mode_reviewed',JSON_EXTRACT('true','$')) WHERE id IN (2,3)");
    await query("INSERT INTO people (id, name) VALUES (7, 'Operator')");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    const context = vm.createContext({
      console, process, Buffer, URL, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise,
      fs, path, crypto, createHash: crypto.createHash, randomUUID: crypto.randomUUID,
      AsyncLocalStorage, shanghaiDateKey, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
      config: { appBaseUrl: "http://localhost:8788" }, sharp: () => { throw new Error("Unexpected image processing"); },
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      mysqlQuery: query, mysqlExecute: execute, checkAiCreditProviderBoundary, withAiCreditOperation,
      withMysqlTransaction: async action => {
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        try { const result = await action(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      },
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      assertBusinessTaskPermission, businessTaskTenantKey,
      aiImageRuntimePoolConfig: async () => [],
      adaptiveAiImageConcurrency: value => value,
      aiImageRuntimeMetrics: () => ({ activeTotal: 0, waitingTotal: 0 }),
      generateImages: async () => { throw new Error("External image generation forbidden in isolation test"); },
      putContentAddressedObject: async () => { throw new Error("External storage forbidden in isolation test"); },
      materializeListingMediaAssetUrl: async () => { throw new Error("Unexpected media materialization"); }
    });
    load(context, "src/services/ai-tenant-context.js");
    let providerCalls = 0;
    context.visionWithAiProvider = context.chatWithAiProvider = async () => {
      providerCalls += 1;
      await context.reserveTenantAiRequest("text");
      return { model: "fixture", content: JSON.stringify({ product_type: "key cover", material: "silicone", color: "black", visible_text: "", source_variant_value: "Model A" }), usage: { total_tokens: 10 } };
    };
    load(context, "src/services/ai-variant-lab.js");
    await context.ensureAiVariantLabSchema();

    await t.test("migration is repeatable and legacy rows remain default-owned", async () => {
      await query("ALTER TABLE ai_variant_case_templates DROP INDEX uniq_ai_variant_case_templates_no, DROP COLUMN tenant_id, ADD UNIQUE KEY uniq_ai_variant_case_templates_no (case_no)");
      await query("INSERT INTO ai_variant_case_templates (case_no, case_name) VALUES ('legacy', 'Legacy')");
      const connection = await pool.getConnection();
      try {
        const preview = await migrateTenantAiBackground(connection);
        assert.equal(preview.mode, "dry-run");
        await migrateTenantAiBackground(connection, { apply: true });
        await migrateTenantAiBackground(connection, { apply: true });
      } finally { connection.release(); }
      assert.equal((await query("SELECT tenant_id FROM ai_variant_case_templates WHERE case_no = 'legacy'"))[0].tenant_id, "admin");
    });

    await t.test("same case/template keys in A/B/default cannot overwrite or read each other", async () => {
      for (const id of [1, 2, 3]) {
        await context.aiVariantLabSaveCase({ caseNo: "same", caseName: `Case ${id}`, case: {} }, session(id));
        await context.aiVariantLabSaveTemplate({ templateKey: "same", templateName: `Template ${id}`, template: { private: id } }, session(id));
      }
      for (const id of [1, 2, 3]) {
        assert.equal((await context.aiVariantLabCaseDetail("same", session(id))).case.case_name, `Case ${id}`);
        const templates = await context.aiVariantLabTemplates({}, session(id));
        assert.deepEqual(Array.from(templates.templates, row => row.template_name), [`Template ${id}`]);
      }
      await assert.rejects(context.aiVariantLabCaseDetail("legacy", session(2)), { status: 404 });
      assert.equal((await context.aiVariantLabCases({}, session(1))).total, 2);
      assert.equal((await context.aiVariantLabCases({ tenant_id: "admin" }, session(2))).total, 1);
      await context.aiVariantLabDeleteCase("same", session(2));
      assert.equal((await query("SELECT status FROM ai_variant_case_templates WHERE tenant_id = '3' AND case_no = 'same'"))[0].status, "active");
    });

    await t.test("analysis reuse and optimizer lookups are tenant-scoped", async () => {
      await assert.rejects(context.withAiTenantSession(session(2), () => context.reserveTenantAiRequest("text")), { code: "TENANT_AI_QUOTA_EXCEEDED" });
      await query("INSERT INTO tenant_ai_limits (tenant_id, monthly_request_limit) VALUES (2, NULL), (3, NULL)");
      for (const id of [1, 2, 3]) await context.aiVariantLabAnalyzeImage({ analysisNo: "same-analysis", sourceProductId: "same-product", imageDataUrl: "data:image/png;base64,AA==" }, session(id));
      for (const [key, label] of [["admin", "D"], ["2", "A"], ["3", "B"]]) {
        await query("UPDATE ai_variant_lab_analyses SET analysis_json = ? WHERE tenant_id = ?", [JSON.stringify({ product_type: label }), key]);
        await query("INSERT INTO ai_image_optimizer_jobs (tenant_id, job_no, analysis_json) VALUES (?, 'same-optimizer', ?)", [key, JSON.stringify({ marker: label })]);
      }
      assert.equal((await context.aiVariantLabAnalysisLookup({ sourceProductId: "same-product" }, session(2))).analysis.product_type, "A");
      assert.equal((await context.aiVariantLabAnalysisLookup({ sourceProductId: "same-product" }, session(1))).analysis.product_type, "D");
      assert.equal((await context.aiImageOptimizerJobDetail("same-optimizer", session(3))).analysis.marker, "B");
      assert.equal(providerCalls, 3);
    });

    await t.test("same batch/item numbers remain separate and manual result updates only A", async () => {
      for (const key of ["admin", "2", "3"]) {
        await query("INSERT INTO ai_variant_lab_batch_jobs (tenant_id, job_no, created_by_person_id, status) VALUES (?, 'same-job', 7, 'planned')", [key]);
        await query("INSERT INTO ai_variant_lab_batch_items (tenant_id, item_no, job_no, status) VALUES (?, 'same-item', 'same-job', 'planned')", [key]);
      }
      assert.equal((await context.aiVariantLabBatchJobs({}, session(2))).jobs.length, 1);
      await context.aiVariantLabManualImageResult({ jobNo: "same-job", itemNo: "same-item", url: "https://fixture.invalid/a.png" }, session(2));
      const rows = await query("SELECT tenant_id, status FROM ai_variant_lab_batch_items ORDER BY tenant_id");
      assert.deepEqual(rows, [{ tenant_id: "2", status: "image_done" }, { tenant_id: "3", status: "planned" }, { tenant_id: "admin", status: "planned" }]);
      const detail = await context.aiVariantLabBatchJobDetail("same-job", session(3));
      assert.equal(detail.items[0].status, "planned");
    });

    await t.test("concurrent quotas count only the current enterprise and revoked membership cannot reserve", async () => {
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = 2 WHERE tenant_id = 3");
      // B has one analysis request above; exactly one more request can fit.
      const outcomes = await Promise.allSettled([1, 2].map(() => context.withAiTenantSession(session(3), () => context.reserveTenantAiRequest("image"))));
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(result => result.status === "rejected" && result.reason.code === "TENANT_AI_QUOTA_EXCEEDED").length, 1);
      await context.withAiTenantSession(session(2), () => context.reserveTenantAiRequest("image"));
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2");
      await assert.rejects(context.withAiTenantSession(session(2), () => context.reserveTenantAiRequest("image")), { statusCode: 403 });
      assert.deepEqual((await query("SELECT tenant_id, request_count FROM tenant_ai_usage ORDER BY tenant_id")).map(row => [row.tenant_id, Number(row.request_count)]), [[1, 1], [2, 2], [3, 2]]);
    });

    await t.test("general AI worker overrides the scheduler's ambient tenant with the persisted job owner", async () => {
      await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 2");
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = NULL WHERE tenant_id = 3");
      const charges = [], events = [];
      context.broadcastGlobalEvent = (...args) => events.push(args);
      context.generateDeepSeekListingContent = async () => {
        charges.push(context.aiTenantId());
        await context.reserveTenantAiRequest("text");
        return { data: { content: "Black key cover", fields: { title: "Black key cover" } } };
      };
      load(context, "src/services/ai-generation-tasks.js");
      for (const id of [2, 3]) await context.createAiGenerationTasks({ taskId: "shared-task", fieldKey: "title", input: { productName: "Key cover" } }, session(id));
      const own = await context.aiGenerationTasks({ taskIds: "shared-task", includePayload: true }, session(2));
      assert.equal(own.length, 1);
      await context.createAiGenerationTasks({ taskId: "b-only", fieldKey: "title" }, session(3));
      assert.equal((await context.aiGenerationTasks({ taskIds: "b-only" }, session(2))).length, 0);
      await query("UPDATE ai_generation_tasks SET status = 'failed' WHERE task_no = 'b-only'");
      await context.retryAiGenerationTask("b-only", session(2));
      assert.equal((await query("SELECT status FROM ai_generation_tasks WHERE task_no = 'b-only'"))[0].status, "failed");
      const [job] = await query("SELECT * FROM ai_generation_tasks WHERE task_no = 'shared-task' AND tenant_id = '3'");
      await context.withAiTenantSession(session(2), () => context.executeClaimedTask(job));
      assert.deepEqual(charges, ["3"]);
      assert.equal((await query("SELECT status FROM ai_generation_tasks WHERE task_no = 'shared-task' AND tenant_id = '3'"))[0].status, "done");
      assert.equal((await query("SELECT status FROM ai_generation_tasks WHERE task_no = 'shared-task' AND tenant_id = '2'"))[0].status, "queued");
      assert.ok(events.length > 0);
      assert.ok(events.every(event => event[2].tenantId === 3));
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 3");
      await context.executeClaimedTask(job);
      assert.deepEqual(charges, ["3"]);
    });
    await t.test("analytics AI context reserves its own usage and cannot be reused as operations authority", async () => {
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('operations') WHERE tenant_id = 3");
      const before = (await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 3"))[0].request_count;
      await context.withAiTenantSession(session(3), async () => {
        assert.equal(context.needsAiTenantSession(session(3)), true);
        assert.equal(context.needsAiTenantSession(session(3), "analytics"), false);
        await context.reserveTenantAiRequest("text");
      }, { permission: "analytics" });
      assert.equal(Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 3"))[0].request_count), Number(before) + 1);
      await assert.rejects(context.withAiTenantSession(session(3), () => {}, { permission: "team" }), /Invalid AI business permission/);
    });

    await t.test("fission planning and execution retain enterprise and persisted actor boundaries", async t => {
      await query("INSERT INTO people (id, name) VALUES (8, 'Persisted operator')");
      await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (2, 8, JSON_ARRAY('operations'))");
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = NULL");
      await query("CREATE TABLE ai_vehicle_catalog (id BIGINT PRIMARY KEY, tenant_id VARCHAR(64), brand_name VARCHAR(100), model_name VARCHAR(100), vehicle_reference_image_url TEXT, enabled TINYINT, source VARCHAR(32))");
      vm.runInContext(read("src/services/ai-vehicle-catalog.js").match(/export function vehicleCatalogTenantPredicate[\s\S]*?\n}/)[0].replace("export ", ""), context);
      context.AI_IMAGE_TASK_OWNERS_SCHEMA = AI_IMAGE_TASK_OWNERS_SCHEMA;
      load(context, "src/services/ai-image-task-ownership.js");
      const calls = [], media = [], timers = [];
      let fetchHook = async () => {};
      const channel = { channelId: "fixture", provider: "openai", imageModel: "fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", maxConcurrency: 1, poolMaxConcurrency: 1 };
      context.aiImageRuntimePoolConfig = async () => [channel];
      context.setTimeout = (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; };
      const imageProvider = vm.createContext({
        console, process, Buffer, URL, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise, path,
        AbortSignal, FormData, Blob, fs: fs.promises, fsSync: fs,
        reserveTenantAiRequest: kind => context.reserveTenantAiRequest(kind),
        assertCurrentAiTenantPermission: () => context.assertCurrentAiTenantPermission(),
        withUnbilledAiImageRuntimeSlot: async (_config, operation) => operation(),
        assertAiCreditProviderBoundary: async kind => checkAiCreditProviderBoundary(await context.assertCurrentAiTenantPermission(), kind, query),
        setTimeout: callback => { queueMicrotask(callback); return { unref() {} }; },
        fetch: async (_url, options) => {
          const owner = context.currentAiTenantSession();
          const usage = await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = ?", [owner.tenant.id]);
          const call = { tenant: context.aiTenantId(), person: owner.personId, method: options.method, usage: Number(usage[0]?.request_count || 0) };
          calls.push(call);
          const response = await fetchHook(call);
          return { ok: true, status: 200, json: async () => options.method === "GET"
            ? response || { status: "done", url: "https://fixture.invalid/result.png" }
            : { data: [{ b64_json: "AA==" }] } };
        }
      });
      load(imageProvider, "src/server/services/openai/imageGenerationService.js");
      // Keep real quota reservation and network dispatch; replace only the workflow's
      // image bytes adapter. Ownership registration and all batch SQL remain real.
      context.generateImages = async payload => {
        const taskId = crypto.randomUUID();
        await context.registerAiImageTaskOwner(taskId);
        await imageProvider.requestCompatibleImage({
          runtimeConfig: payload.imageRuntimeConfig, prompt: payload.finalPrompt, size: "1024x1536",
          providerJob: payload.providerJob?.jobs?.[0] || payload.providerJob,
          onProviderJob: payload.onProviderJob
        });
        return { taskId, generatedImages: [{ url: `/api/ai-workflow/generated/${taskId}/generated_001.png` }] };
      };
      context.materializeListingMediaAssetUrl = async (url, metadata, owner) => {
        media.push({ tenant: context.aiTenantId(), person: owner.personId, job: metadata.batch_id, url });
        return { finalUrl: "https://fixture.invalid/durable.png", localUrl: "/uploads/listing-media/fixture.png" };
      };
      const resetAuthorization = async () => {
        await query("UPDATE tenant_members SET active = 1, business_roles_json = JSON_ARRAY('operations')");
        await query("UPDATE tenants SET subscription_status = 'active', subscription_expires_at = NULL");
        await query("UPDATE tenant_ai_limits SET monthly_request_limit = NULL");
        calls.length = media.length = timers.length = 0;
        fetchHook = async () => {};
      };
      const seedBatch = async (key, job, { person = 7, count = 1, status = "queued_image", providerJob = false } = {}) => {
        await query("INSERT INTO ai_variant_lab_batch_jobs (tenant_id, job_no, created_by_person_id, status, result_json, image_concurrency) VALUES (?, ?, ?, 'generating_images', ?, 1)",
          [key, job, person, JSON.stringify({ source_image_url: "https://fixture.invalid/source.png", ratio: "3:4" })]);
        for (let index = 0; index < count; index++) await query("INSERT INTO ai_variant_lab_batch_items (tenant_id, item_no, job_no, target_variant_value, status, item_json, provider_job_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [key, `${job}-${index}`, job, `TENET T${index + 4}`, status, JSON.stringify({ image_edit_prompt_en: "Keep the black key cover unchanged", source_variant_value: "TENET T3", target_variant_value: `TENET T${index + 4}` }),
            providerJob ? JSON.stringify({ jobs: [{ jobId: "persisted-provider-job", channelId: "fixture", provider: "openai", endpoint: "https://fixture.invalid/v1/images/generations", statusUrl: "https://fixture.invalid/status" }] }) : null, index]);
      };
      const drainWorkers = async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (vm.runInContext("runningBatchImageJobs.size", context) === 0) return;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail("Fixture background workers did not settle");
      };

      await t.test("batch plan resolves same analysis/template keys in A/B/default and ignores forged billing actor", async () => {
        await resetAuthorization();
        const plans = [];
        context.chatWithAiProvider = async payload => {
          await context.reserveTenantAiRequest("text");
          plans.push({ tenant: context.aiTenantId(), payload: JSON.parse(payload.messages[1].content) });
          return { provider: "fixture", model: "fixture", content: JSON.stringify({ items: [] }), usage: { total_tokens: 10 } };
        };
        for (const id of [1, 2, 3]) await context.aiVariantLabBatchPlan({
          jobNo: "plan-shared", analysisNo: "same-analysis", templateKey: "same", targetModels: ["TENET T4"],
          tenant_id: id === 2 ? "admin" : "2", personId: 999, created_by_person_id: 999
        }, session(id));
        assert.deepEqual(plans.map(row => [row.tenant, row.payload.analysis.product_type, row.payload.reusable_template.private]), [["admin", "D", 1], ["2", "A", 2], ["3", "B", 3]]);
        assert.ok((await query("SELECT created_by_person_id FROM ai_variant_lab_batch_jobs WHERE job_no = 'plan-shared'")).every(row => Number(row.created_by_person_id) === 7));
        await query("INSERT INTO ai_variant_lab_analyses (tenant_id, analysis_no, analysis_json) VALUES ('3', 'foreign-analysis', '{}')");
        await assert.rejects(context.aiVariantLabBatchPlan({ jobNo: "blocked-plan", analysisNo: "foreign-analysis", targetModels: ["TENET T4"] }, session(2)), { status: 404 });
        assert.equal((await query("SELECT COUNT(*) AS count FROM ai_variant_lab_batch_jobs WHERE job_no = 'blocked-plan'"))[0].count, 0);
      });

      await t.test("run and resume reject an outside enterprise job before any provider call", async () => {
        await resetAuthorization();
        await seedBatch("3", "foreign-run", { status: "provider_pending", providerJob: true });
        await assert.rejects(context.aiVariantLabBatchRunImages({ jobNo: "foreign-run", imageDataUrl: "data:image/png;base64,AA==", execute: true, tenantId: "3", personId: 999 }, session(2)), { status: 404 });
        await assert.rejects(context.aiVariantLabBatchResumeImages({ jobNo: "foreign-run", tenantId: "3", personId: 999 }, session(2)), { status: 404 });
        assert.equal((await query("SELECT status FROM ai_variant_lab_batch_items WHERE job_no = 'foreign-run'"))[0].status, "provider_pending");
        assert.equal(calls.length, 0);
      });

      await t.test("background worker replaces ambient B with persisted A owner for quota, files and usage", async () => {
        await resetAuthorization();
        for (const key of ["admin", "2", "3"]) await seedBatch(key, "worker-shared", { person: key === "2" ? 8 : 7 });
        const before = Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 2"))[0].request_count);
        await context.withAiTenantSession(session(3), () => context.runBatchImageBackgroundJob("worker-shared", {
          tenantId: "2", sessionPersonId: 999, imageConcurrency: 1, sourceImageUrl: "https://fixture.invalid/source.png"
        }));
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method, row.usage]), [["2", 8, "POST", before + 1]]);
        assert.deepEqual(media.map(row => [row.tenant, row.person]), [["2", 8]]);
        const owners = await query("SELECT tenant_id, created_by_person_id FROM ai_image_task_owners WHERE task_id = ?", [media[0].url.split("/")[4]]);
        assert.deepEqual(owners, [{ tenant_id: "2", created_by_person_id: 8 }]);
        assert.deepEqual(await query("SELECT tenant_id, status FROM ai_variant_lab_batch_items WHERE job_no = 'worker-shared' ORDER BY tenant_id"), [{ tenant_id: "2", status: "image_done" }, { tenant_id: "3", status: "queued_image" }, { tenant_id: "admin", status: "queued_image" }]);
        assert.deepEqual(await query("SELECT tenant_id, person_id FROM ai_image_usage_events WHERE job_no = 'worker-shared'"), [{ tenant_id: "2", person_id: 8 }]);
      });

      await t.test("a new run in A and a saved-provider resume in B can execute the same job number independently", async () => {
        await resetAuthorization();
        await seedBatch("2", "run-resume-shared", { person: 8, status: "planned" });
        await seedBatch("3", "run-resume-shared", { status: "provider_pending", providerJob: true });
        const before = await query("SELECT tenant_id, request_count FROM tenant_ai_usage WHERE tenant_id IN (2, 3) ORDER BY tenant_id");
        await Promise.all([
          context.aiVariantLabBatchRunImages({ jobNo: "run-resume-shared", imageDataUrl: "data:image/png;base64,AA==", execute: true, personId: 999, tenantId: "3" }, session(2)),
          context.aiVariantLabBatchResumeImages({ jobNo: "run-resume-shared", personId: 999, tenantId: "2" }, session(3))
        ]);
        await drainWorkers();
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method]).sort(), [["2", 8, "POST"], ["3", 7, "GET"]]);
        assert.deepEqual(media.map(row => [row.tenant, row.person]).sort(), [["2", 8], ["3", 7]]);
        assert.ok((await query("SELECT status FROM ai_variant_lab_batch_items WHERE job_no = 'run-resume-shared'")).every(row => row.status === "image_done"));
        const after = await query("SELECT tenant_id, request_count FROM tenant_ai_usage WHERE tenant_id IN (2, 3) ORDER BY tenant_id");
        assert.deepEqual(after.map((row, index) => Number(row.request_count) - Number(before[index].request_count)), [1, 0]);
      });

      await t.test("an exhausted enterprise quota blocks provider submission before network dispatch", async () => {
        await resetAuthorization();
        await seedBatch("2", "quota-blocked", { person: 8 });
        const before = Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 2"))[0].request_count);
        await query("UPDATE tenant_ai_limits SET monthly_request_limit = ? WHERE tenant_id = 2", [before]);
        await context.withAiTenantSession(session(2), () => context.runBatchImageBackgroundJob("quota-blocked", { tenantId: "2", sessionPersonId: 8, imageConcurrency: 1 }));
        assert.equal(calls.length, 0);
        assert.equal(media.length, 0);
        assert.equal((await query("SELECT status FROM ai_variant_lab_batch_items WHERE job_no = 'quota-blocked'"))[0].status, "failed");
        assert.equal(Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 2"))[0].request_count), before);
      });

      await t.test("revoking operations during a pending provider response prevents the next poll inside the same generation call", async () => {
        await resetAuthorization();
        await seedBatch("2", "poll-loop-revoked", { person: 8, providerJob: true });
        const before = Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 2"))[0].request_count);
        fetchHook = async () => {
          if (calls.length !== 1) return;
          await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2 AND person_id = 8");
          return { status: "processing" };
        };
        await context.withAiTenantSession(session(3), () => context.runBatchImageBackgroundJob("poll-loop-revoked", { tenantId: "2", sessionPersonId: 8, imageConcurrency: 1 })).catch(error => assert.equal(error.code, "TENANT_TASK_ACCESS_DENIED"));
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method]), [["2", 8, "GET"]]);
        assert.equal(media.length, 0);
        assert.equal(Number((await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = 2"))[0].request_count), before);
      });

      for (const [label, revoke] of [
        ["operations", "UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2 AND person_id = 8"],
        ["membership", "UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 8"],
        ["subscription", "UPDATE tenants SET subscription_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id = 2"]
      ]) await t.test(`revoked ${label} prevents completed provider output from materializing and blocks the next saved-job poll`, async () => {
        await resetAuthorization();
        const job = `revoked-${label}`;
        await seedBatch("2", job, { person: 8, count: 2, providerJob: true });
        fetchHook = async () => { await query(revoke); };
        await context.withAiTenantSession(session(3), () => context.runBatchImageBackgroundJob(job, { tenantId: "2", sessionPersonId: 8, imageConcurrency: 1 })).catch(error => assert.equal(error.code, "TENANT_TASK_ACCESS_DENIED"));
        assert.equal(calls.length, 1);
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method]), [["2", 8, "GET"]]);
        assert.equal(media.length, 0);
        assert.equal((await query("SELECT status FROM ai_variant_lab_batch_items WHERE tenant_id = '2' AND item_no = ?", [`${job}-1`]))[0].status, "queued_image");
      });

      await t.test("background failure cleanup and a queued wakeup cannot update or start B's same-number job", async () => {
        await resetAuthorization();
        for (const key of ["2", "3"]) await seedBatch(key, "failure-shared", { person: key === "2" ? 8 : 7, providerJob: true });
        fetchHook = async () => { await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2 AND person_id = 8"); };
        await context.withAiTenantSession(session(2), () => {
          assert.equal(context.startBatchImageBackgroundJob("failure-shared", { tenantId: "3", sessionPersonId: 999 }), true);
          assert.equal(context.startBatchImageBackgroundJob("failure-shared", { tenantId: "3", sessionPersonId: 999 }), false);
        });
        await drainWorkers();
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method]), [["2", 8, "GET"]]);
        assert.equal(media.length, 0);
        assert.deepEqual(await query("SELECT tenant_id, status FROM ai_variant_lab_batch_jobs WHERE job_no = 'failure-shared' ORDER BY tenant_id"), [{ tenant_id: "2", status: "failed" }, { tenant_id: "3", status: "generating_images" }]);
        assert.equal((await query("SELECT status FROM ai_variant_lab_batch_items WHERE tenant_id = '3' AND job_no = 'failure-shared'"))[0].status, "queued_image");
        assert.equal(vm.runInContext("runningBatchImageJobs.size + pendingBatchImageJobWakeups.size", context), 0);
      });

      await t.test("restart recovery resumes same-number jobs under each persisted tenant and polls without a second charge", async () => {
        await resetAuthorization();
        // Other fixture jobs must not be picked up by global startup recovery.
        await query("UPDATE ai_variant_lab_batch_jobs SET status = 'failed'");
        for (const key of ["admin", "2", "3"]) await seedBatch(key, "restart-shared", { person: key === "2" ? 8 : 7, status: "provider_pending", providerJob: true });
        const before = await query("SELECT tenant_id, request_count FROM tenant_ai_usage ORDER BY tenant_id");
        const recovered = await context.withAiTenantSession(session(3), () => context.recoverAiVariantLabImageBatchesOnStartup());
        assert.equal(recovered.resumed, 3);
        await drainWorkers();
        assert.deepEqual(calls.map(row => [row.tenant, row.person, row.method]).sort(), [["admin", 7, "GET"], ["2", 8, "GET"], ["3", 7, "GET"]].sort());
        assert.ok((await query("SELECT status FROM ai_variant_lab_batch_items WHERE job_no = 'restart-shared'")).every(row => row.status === "image_done"));
        assert.deepEqual(await query("SELECT tenant_id, request_count FROM tenant_ai_usage ORDER BY tenant_id"), before);
      });

      await t.test("delayed provider repoll rechecks persisted permissions before moving any item back to the queue", async () => {
        await resetAuthorization();
        await seedBatch("2", "repoll-revoked", { person: 8, status: "provider_pending", providerJob: true });
        await context.withAiTenantSession({ ...session(2), personId: 8 }, () => context.scheduleProviderPendingBatchResume("repoll-revoked", { tenantId: "2", sessionPersonId: 999 }));
        assert.equal(timers.length, 1);
        await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 2 AND person_id = 8");
        await context.withAiTenantSession(session(3), () => timers[0].callback());
        await drainWorkers();
        assert.equal((await query("SELECT status FROM ai_variant_lab_batch_items WHERE job_no = 'repoll-revoked'"))[0].status, "provider_pending");
        assert.equal(calls.length, 0);
        assert.equal(media.length, 0);
      });
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

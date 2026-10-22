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
import { TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";

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
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, name VARCHAR(80), active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))"
    ]) await query(sql);
    await query("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await query("INSERT INTO people (id, name) VALUES (7, 'Operator')");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    const context = vm.createContext({
      console, process, Buffer, URL, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise,
      fs, path, crypto, createHash: crypto.createHash, randomUUID: crypto.randomUUID,
      AsyncLocalStorage, shanghaiDateKey, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
      config: { appBaseUrl: "http://localhost:8788" }, sharp: () => { throw new Error("Unexpected image processing"); },
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      mysqlQuery: query, mysqlExecute: execute,
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
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { shanghaiDateKey } from "../src/shanghai-time.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from "../src/services/business-task-tenant.js";
import { TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("case target history uses actual results from only the current case and enterprise", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_case_history_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let created = false, pool, businessReads = 0;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 3 });
    const query = async (sql, params = []) => {
      if (/FROM (?:ai_variant_lab_batch_jobs|listing_drafts)/.test(sql)) businessReads += 1;
      return (await pool.query(sql, params))[0];
    };
    const execute = async (sql, params = []) => (await pool.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, name VARCHAR(80), active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))",
      "CREATE TABLE listing_drafts (id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(64) NULL, status VARCHAR(32) DEFAULT 'draft', manual_facts_json LONGTEXT NULL, ai_payload_json LONGTEXT NULL, spec VARCHAR(255) DEFAULT '')"
    ]) await query(sql);
    await query("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await query("INSERT INTO people (id, name) VALUES (7, 'Operator')");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    const external = () => { throw new Error("A history read must not call AI, storage, or image processing"); };
    const context = vm.createContext({
      console, process, Buffer, URL, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise,
      fs, path, crypto, AsyncLocalStorage, shanghaiDateKey, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
      config: { appBaseUrl: "http://localhost:8788" }, sharp: external,
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      mysqlQuery: query, mysqlExecute: execute,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      assertBusinessTaskPermission, businessTaskTenantKey,
      aiImageRuntimePoolConfig: async () => [], adaptiveAiImageConcurrency: value => value,
      aiImageRuntimeMetrics: () => ({ activeTotal: 0, waitingTotal: 0 }),
      generateImages: external, chatWithAiProvider: external, visionWithAiProvider: external,
      putContentAddressedObject: external, materializeListingMediaAssetUrl: external
    });
    for (const file of ["src/services/ai-tenant-context.js", "src/services/ai-variant-lab.js"]) {
      vm.runInContext(read(file).replace(/^import[^;]*;\r?\n/gm, "").replaceAll("export ", ""), context, { filename: file });
    }
    await context.ensureAiVariantLabSchema();
    for (const id of [1, 2, 3]) {
      await context.aiVariantLabSaveCase({ caseNo: "AVC-P4", caseName: `Case ${id}`, case: {} }, session(id));
      await context.aiVariantLabSaveCase({ caseNo: "AVC-OTHER", caseName: `Other ${id}`, case: {} }, session(id));
    }
    const history = async (id = 2, caseNo = "AVC-P4") => JSON.parse(JSON.stringify((await context.aiVariantLabCaseDetail(caseNo, session(id))).case.target_history));
    const reset = async () => {
      for (const table of ["listing_drafts", "ai_variant_lab_batch_items", "ai_variant_lab_batch_jobs"]) await query(`DELETE FROM ${table}`);
      await query("UPDATE ai_variant_case_templates SET case_json = '{}', success_target_value = ''");
    };
    const job = async (tenant, jobNo, caseNo = "AVC-P4") => query(
      "INSERT INTO ai_variant_lab_batch_jobs (tenant_id, job_no, source_product_id) VALUES (?, ?, ?)", [tenant, jobNo, caseNo]);
    let itemNumber = 0;
    const item = async (tenant, jobNo, target, status) => query(
      "INSERT INTO ai_variant_lab_batch_items (tenant_id, item_no, job_no, target_variant_value, status) VALUES (?, ?, ?, ?, ?)",
      [tenant, `item-${++itemNumber}`, jobNo, target, status]);
    const draft = async (tenant, target, { caseNo = "AVC-P4", jobNo = "", status = "draft", source = "ai_variant_lab", shape = "facts" } = {}) => {
      const userFacts = { source_product_id: caseNo, target_variant_value: target, ...(jobNo ? { ai_variant_lab_job_no: jobNo } : {}) };
      const optimization = { source, ...(jobNo ? { job_no: jobNo } : {}) };
      return query("INSERT INTO listing_drafts (tenant_id, status, manual_facts_json, ai_payload_json, spec) VALUES (?, ?, ?, ?, ?)",
        [tenant, status, JSON.stringify(shape === "facts" ? { user_facts: userFacts, ai_optimization: optimization } : {}),
          JSON.stringify(shape === "ai" ? { manual_facts: userFacts, ai_optimization: optimization } : {}), target]);
    };

    await t.test("planning does not count, active/failed/completed remain distinct, and exact model normalization preserves slash", async () => {
      await job("2", "own-job");
      for (const [target, status] of [
        ["Planned only", "planned"], ["TENET T7", "image_done"], ["ＴＥＮＥＴ　Ｔ７", "failed"],
        [" tenet   t7 ", "queued_image"], ["CHANGAN UNI-S / CS55 Plus", "generating_image"],
        ["TENET T70", "failed"], ["Provider pending", "provider_pending"]
      ]) await item("2", "own-job", target, status);
      const rows = await history();
      assert.equal(rows.length, 4);
      assert.ok(!rows.some(row => row.target_value === "Planned only"));
      const done = rows.find(row => row.target_value.toLowerCase() === "tenet t7");
      assert.deepEqual([done.status, done.completed_count, done.in_progress_count, done.failed_count], ["completed", 1, 1, 1]);
      assert.equal(rows.find(row => row.target_value === "CHANGAN UNI-S / CS55 Plus").status, "in_progress");
      assert.equal(rows.find(row => row.target_value === "TENET T70").status, "failed");
      assert.equal(rows.find(row => row.target_value === "Provider pending").status, "in_progress");
    });

    await t.test("same job/case numbers in A/B/default and poisoned foreign item links stay isolated", async () => {
      await reset();
      for (const [tenant, target] of [["admin", "Default only"], ["2", "A only"], ["3", "B only"]]) {
        await job(tenant, "shared-job");
        await item(tenant, "shared-job", target, "image_done");
      }
      await job("3", "foreign-job");
      await item("2", "foreign-job", "Poisoned foreign job", "image_done");
      await job("2", "other-case-job", "AVC-OTHER");
      await item("2", "other-case-job", "Other case only", "image_done");
      await job("2", "lookalike-case", "avc-p4");
      await item("2", "lookalike-case", "Case number differs", "image_done");
      for (const [id, target] of [[1, "Default only"], [2, "A only"], [3, "B only"]]) {
        assert.deepEqual((await history(id)).map(row => row.target_value), [target]);
      }
      assert.deepEqual((await history(2, "AVC-OTHER")).map(row => row.target_value), ["Other case only"]);
    });

    await t.test("saved drafts count only for exact case/enterprise and verified local batch lineage", async () => {
      await reset();
      await job("2", "saved-job");
      await job("3", "foreign-job");
      await job("2", "other-case-job", "AVC-OTHER");
      await draft("2", "Saved before image", { jobNo: "saved-job" });
      await draft("2", "Legacy saved", { shape: "ai" });
      await draft(null, "Default legacy");
      await draft("3", "B saved");
      await draft("2", "Deleted draft", { status: "deleted" });
      await draft("2", "Other case saved", { caseNo: "AVC-OTHER" });
      await draft("2", "Foreign linked draft", { jobNo: "foreign-job" });
      await draft("2", "Wrong-case linked draft", { jobNo: "other-case-job" });
      await draft("2", "Other AI workflow", { source: "ai_product_material_optimizer" });
      await query("INSERT INTO listing_drafts (tenant_id, manual_facts_json) VALUES ('2', 'broken JSON')");
      const rows = await history();
      assert.deepEqual(rows.map(row => row.target_value), ["Legacy saved", "Saved before image"]);
      assert.ok(rows.every(row => row.status === "completed" && row.saved_draft_count === 1));
      assert.deepEqual((await history(1)).map(row => row.target_value), ["Default legacy"]);
      assert.deepEqual((await history(3)).map(row => row.target_value), ["B saved"]);
    });

    await t.test("the verified originating batch includes its targets and saved drafts without broadening to other batches of the same SKU", async () => {
      await reset();
      await query("UPDATE ai_variant_case_templates SET case_json = ? WHERE tenant_id = '2' AND case_no = 'AVC-P4'",
        [JSON.stringify({ source_trace: { batch_job_no: "original-job", source_product_id: "mother-P4" } })]);
      await job("2", "original-job", "mother-P4");
      await item("2", "original-job", "Original target one", "image_done");
      await item("2", "original-job", "Original target two", "image_done");
      await draft("2", "Original target two", { caseNo: "mother-P4", jobNo: "original-job" });
      await draft("2", "Original saved only", { caseNo: "mother-P4", jobNo: "original-job", shape: "ai" });
      await job("2", "unrelated-job", "mother-P4");
      await item("2", "unrelated-job", "Unrelated same SKU", "image_done");
      await draft("2", "Unrelated draft", { caseNo: "mother-P4", jobNo: "unrelated-job" });
      await draft("2", "Unverified SKU draft", { caseNo: "mother-P4" });
      await draft("2", "Wrong-source linked draft", { caseNo: "wrong-source", jobNo: "original-job" });
      await job("3", "original-job", "mother-P4");
      await item("3", "original-job", "Foreign original target", "image_done");
      await draft("3", "Foreign original draft", { caseNo: "mother-P4", jobNo: "original-job" });
      await job("2", "reuse-job");
      await item("2", "reuse-job", "Current case reuse", "image_done");
      const rows = await history();
      assert.deepEqual(rows.map(row => row.target_value), ["Current case reuse", "Original saved only", "Original target one", "Original target two"]);
      assert.equal(rows.find(row => row.target_value === "Original target two").saved_draft_count, 1);
      assert.equal(rows.find(row => row.target_value === "Original target one").latest_batch_job_no, "original-job");
      assert.deepEqual(await history(2, "AVC-OTHER"), []);
      assert.deepEqual(await history(3), []);
    });

    await t.test("forged, incomplete, or foreign originating-batch traces cannot contribute history", async () => {
      await reset();
      await job("2", "original-job", "mother-P4");
      await item("2", "original-job", "Hidden original target", "image_done");
      await draft("2", "Hidden original draft", { caseNo: "mother-P4", jobNo: "original-job" });
      await job("3", "foreign-only-job", "mother-P4");
      await item("2", "foreign-only-job", "Poisoned originating item", "image_done");
      await draft("2", "Poisoned originating draft", { caseNo: "mother-P4", jobNo: "foreign-only-job" });
      for (const sourceTrace of [
        { batch_job_no: "original-job", source_product_id: "wrong-source" },
        { batch_job_no: "foreign-only-job", source_product_id: "mother-P4" },
        { batch_job_no: "original-job" }, { source_product_id: "mother-P4" },
        { batch_job_no: "ORIGINAL-JOB", source_product_id: "mother-P4" }
      ]) {
        await query("UPDATE ai_variant_case_templates SET case_json = ? WHERE tenant_id = '2' AND case_no = 'AVC-P4'",
          [JSON.stringify({ source_trace: sourceTrace })]);
        assert.deepEqual(await history(), [], JSON.stringify(sourceTrace));
      }
    });

    await t.test("the current case's actual successful sample is included but target labels alone are not", async () => {
      await reset();
      await query("UPDATE ai_variant_case_templates SET success_target_value = 'Label only', case_json = ? WHERE tenant_id = '2' AND case_no = 'AVC-P4'", [JSON.stringify({ sample_rows: [
        { target_variant_value: "Actual sample", status: "image_done", generated_main_image_url: "/api/ai-images/own.png" },
        { target_variant_value: "Failed sample", status: "failed", generated_main_image_url: "/api/ai-images/old.png" }
      ] })]);
      assert.deepEqual((await history()).map(row => row.target_value), ["Actual sample"]);
      assert.deepEqual(await history(3), []);
      await query("UPDATE ai_variant_case_templates SET case_json = ? WHERE tenant_id = '2' AND case_no = 'AVC-P4'", [JSON.stringify({ sample_assets: { generated_main_image_url: "/api/ai-images/saved.png" } })]);
      assert.deepEqual((await history()).map(row => row.target_value), ["Label only"]);
    });

    await t.test("reopening reads latest stored status without generating anything", async () => {
      await reset();
      await job("2", "live-job");
      await item("2", "live-job", "Latest model", "failed");
      assert.equal((await history())[0].status, "failed");
      await query("UPDATE ai_variant_lab_batch_items SET status = 'generating_image' WHERE tenant_id = '2'");
      assert.equal((await history())[0].status, "in_progress");
      await query("UPDATE ai_variant_lab_batch_items SET status = 'image_done' WHERE tenant_id = '2'");
      assert.equal((await history())[0].status, "completed");
    });

    await t.test("missing/foreign cases and revoked memberships fail before reading result history", async () => {
      await context.aiVariantLabSaveCase({ caseNo: "B-only", case: {} }, session(3));
      const before = businessReads;
      await assert.rejects(context.aiVariantLabCaseDetail("B-only", session(2)), { status: 404 });
      await assert.rejects(context.aiVariantLabCaseDetail("missing", session(2)), { status: 404 });
      assert.equal(businessReads, before);
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2");
      await assert.rejects(context.aiVariantLabCaseDetail("AVC-P4", session(2)), { statusCode: 403 });
      assert.equal(businessReads, before);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

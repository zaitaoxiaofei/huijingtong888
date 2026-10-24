import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import os from "node:os";
import sharp from "sharp";
import test from "node:test";
import mysql from "mysql2/promise";
import { shanghaiDateKey } from "../src/shanghai-time.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";
import { TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA, verifyAiMaterialOptimizationSchema } from "../src/services/ai-material-optimization-schema.js";
import { migrateTenantAiMaterialOptimization } from "../scripts/migrate-tenant-ai-material-optimization.mjs";
import { checkAiCreditProviderBoundary } from "../src/services/ai-credit-provider-context.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const source = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const load = (context, file) => vm.runInContext(source(file).replace(/^import[^;]*;\r?\n/gm, "").replaceAll("export ", ""), context, { filename: file });
const session = id => ({ personId: 7, tenant: { id, slug: id === 7 ? "default" : `enterprise-${id}` } });
const facts = { product_title_zh: "黑色钥匙套", selling_points_zh: ["硅胶材质", "两件装"], confirmed_by_operator: true };
const denial = (message, status = 404) => Object.assign(new Error(message), { status, statusCode: status });

test("material optimization is enterprise scoped through real SQL, workers and migration", { skip: !socketPath && "Requires isolated TENANT_TEST_MYSQL_SOCKET" }, async t => {
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  const [[server]] = await admin.query("SELECT @@skip_networking disabled");
  assert.equal(Number(server.disabled), 1);
  const database = `ozon_mat_test_${randomBytes(8).toString("hex")}`;
  let pool;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ozon-material-fixture-"));
  const imagePath = path.join(temporary, "owned.png");
  const imageBytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: "white" } }).png().toBuffer();
  fs.writeFileSync(imagePath, imageBytes);
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  try {
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 8 });
    const query = async (sql, params = []) => (await pool.query(sql, params))[0];
    const execute = async (sql, params = []) => (await pool.execute(sql, params))[0];
    const transaction = async operation => {
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try { const result = await operation(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL, feature_flags_json JSON NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))",
      "CREATE TABLE listing_drafts (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(64), product_name VARCHAR(80), status VARCHAR(32) DEFAULT 'draft', template_id BIGINT DEFAULT 1, images_json JSON)",
      "INSERT INTO tenants (id,slug) VALUES (7,'default'),(2,'enterprise-2'),(3,'enterprise-3')",
      "INSERT INTO people (id) VALUES (7),(8)",
      "INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (7,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations')),(2,8,JSON_ARRAY('operations'))",
      TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
      "CREATE TABLE ai_image_task_owners (task_id VARCHAR(80) PRIMARY KEY,tenant_id VARCHAR(64),created_by_person_id BIGINT)",
      "INSERT INTO ai_image_task_owners VALUES ('private','2',7)",
      "INSERT INTO tenant_ai_limits (tenant_id,monthly_request_limit) VALUES (2,NULL),(3,NULL)"
    ]) await query(sql);
    await query("UPDATE tenants SET feature_flags_json=JSON_OBJECT('ai_internal_mode_reviewed',JSON_EXTRACT('true','$')) WHERE id IN (2,3)");
    const charges = [], outputs = [];
    let imageHook = null, providerHook = null, fileReads = 0, materializations = 0;
    const context = vm.createContext({ console, process, Buffer, URL, AbortSignal, Date, Number, String, Object, Array, Map, Set, JSON, Math, Promise,
      fs, path, crypto, randomUUID, AsyncLocalStorage, shanghaiDateKey, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
      AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA, verifyAiMaterialOptimizationSchema,
      config: { appBaseUrl: "http://localhost:8788" }, setTimeout: () => ({ unref() {} }), clearTimeout() {},
      mysqlQuery: query, mysqlExecute: execute, withMysqlTransaction: transaction, checkAiCreditProviderBoundary,
      getMysqlPoolMetrics: () => ({ activeConnections: 0, connectionLimit: 8 }),
      authorizeBusinessTaskSession: (value, customQuery) => authorizeBusinessTaskSession(value, customQuery || query),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      assertBusinessTaskPermission, businessTaskTenantKey,
      aiImageRuntimePoolConfig: async () => [], adaptiveAiImageConcurrency: value => value, aiImageRuntimeMetrics: () => ({}),
      sharp,
      resolvePublicImageTarget: async () => ({ address: "1.1.1.1" }),
      requestPublicImage: async () => ({ buffer: imageBytes, contentType: "image/png" }),
      getAiTaskFile: async (_task, _scope, _file, actor) => { fileReads++; if (actor.tenant.id !== 2) throw denial("Wrong private owner"); return { size: 2, filePath: imagePath, contentType: "image/png" }; },
      materializeListingMediaAssetUrl: async url => { materializations++; await context.assertCurrentAiTenantPermission(); return { finalUrl: url }; },
      putContentAddressedObject: async bytes => { await sharp(bytes).metadata(); return { url: "https://fixture.invalid/composed.png" }; },
      listingDraftDetail: async (id, actor) => {
        const rows = await query("SELECT * FROM listing_drafts WHERE id = ? AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted'", [id, businessTaskTenantKey(actor)]);
        if (!rows.length) throw denial("Draft not found");
        const draft = rows[0], images = typeof draft.images_json === "string" ? JSON.parse(draft.images_json) : draft.images_json;
        return { ...draft, template_payload: { editable_payload: { title: draft.product_name, variants: [{ images: ["https://fixture.invalid/STALE.png"] }] } }, source_images: ["https://fixture.invalid/OLD.png"], effective_images: images };
      },
      generateListingOfferId: async () => { await context.assertCurrentAiTenantPermission(); return { offerId: `OPT-${randomUUID()}` }; },
      createAiVariantListingDraftLightweight: async (body, actor) => {
        await context.assertCurrentAiTenantPermission();
        const saved = await execute("INSERT INTO listing_drafts (tenant_id,product_name,images_json) VALUES (?, ?, ?)", [businessTaskTenantKey(actor), body.product_name, JSON.stringify(body.patch.images)]);
        outputs.push({ tenant: businessTaskTenantKey(actor), body }); return { id: saved.insertId };
      }
    });
    load(context, "src/services/ai-tenant-context.js");
    context.visionWithAiProvider = context.chatWithAiProvider = async () => {
      await context.reserveTenantAiRequest("text"); charges.push([context.aiTenantId(), "text"]);
      if (providerHook) await providerHook();
      return { model: "fixture", content: JSON.stringify({ product_type: "key cover", material: "silicone", color: "black", keep_facts: ["black"], image_optimization_prompt_en: "Preserve the exact product", pass: true, score: 100 }), usage: {} };
    };
    context.generateImages = async payload => {
      if (!payload.providerJob?.jobId) { await context.reserveTenantAiRequest("image"); charges.push([context.aiTenantId(), "image"]); }
      if (imageHook) return imageHook(payload);
      await payload.onProviderJob?.({ jobId: "saved-provider-job" });
      return { taskId: randomUUID(), generatedImages: [{ url: `https://fixture.invalid/${context.aiTenantId()}-new.png` }] };
    };
    context.generateCommerceCopy = async () => { await context.reserveTenantAiRequest("text"); return { titles: ["Optimized"], tags: [], description: "Verified" }; };
    load(context, "src/services/ai-variant-lab.js");
    load(context, "src/services/ai-material-optimization-batches.js");
    await context.ensureAiVariantLabSchema();
    await context.ensureAiMaterialOptimizationBatchSchema();
    for (const [id, tenant] of [[101,"admin"],[102,"2"],[103,"3"]]) await query("INSERT INTO listing_drafts (id,tenant_id,product_name,images_json) VALUES (?, ?, ?, ?)", [id, tenant, `Source ${tenant}`, JSON.stringify([`https://fixture.invalid/${tenant}-current.png`, `https://fixture.invalid/${tenant}-detail.png`])]);
    const submit = (draft, actor, extra = {}) => context.createAiMaterialOptimizationBatch({ draftIds: [draft], items: [{ draftId: draft, operatorFacts: facts }], ...extra }, actor);
    const runBatch = async batch => {
      const [item] = await query("SELECT * FROM ai_material_optimization_items WHERE batch_no = ?", [batch.batch_no]);
      await query("UPDATE ai_material_optimization_items SET status = 'running',attempts = attempts + 1 WHERE id = ?", [item.id]);
      item.status = "running"; item.attempts = Number(item.attempts) + 1; await context.executeItem(item); return (await query("SELECT * FROM ai_material_optimization_items WHERE id = ?", [item.id]))[0];
    };

    await t.test("default/A/B share enterprise data with colleagues, never with another enterprise", async () => {
      const batches = [];
      for (const [draft, id] of [[101,7],[102,2],[103,3]]) batches.push(await submit(draft, session(id), { tenant_id: "admin", created_by_person_id: 999 }));
      for (const [index, id] of [[0,7],[1,2],[2,3]]) assert.deepEqual(Array.from(await context.aiMaterialOptimizationBatches({}, session(id)), row => row.batch_no), [batches[index].batch_no]);
      assert.equal((await context.aiMaterialOptimizationBatchDetail(batches[1].batch_no, { ...session(2), personId: 8 })).batch_no, batches[1].batch_no);
      await assert.rejects(context.aiMaterialOptimizationBatchDetail(batches[2].batch_no, session(2)), { status: 404 });
      const before = (await query("SELECT COUNT(*) n FROM ai_material_optimization_batches"))[0].n;
      await assert.rejects(submit(103, session(2)), { status: 404 });
      assert.equal((await query("SELECT COUNT(*) n FROM ai_material_optimization_batches"))[0].n, before);
      for (const batch of batches) assert.equal((await runBatch(batch)).status, "completed");
      assert.deepEqual(outputs.map(row => row.tenant), ["admin", "2", "3"]);
      assert.ok(outputs.every(row => row.body.patch.images.every(url => !/STALE|OLD/.test(url))));
    });

    await t.test("ambient scheduler tenant cannot replace the original actor or charged enterprise", async () => {
      const batch = await submit(103, session(3));
      const before = charges.length;
      const item = await context.withAiTenantSession(session(2), () => runBatch(batch));
      assert.equal(item.status, "completed"); assert.ok(charges.slice(before).every(([key]) => key === "3"));
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 3 AND person_id = 7");
      await assert.rejects(context.aiMaterialOptimizationBatches({}, session(3)), { statusCode: 403 });
      await query("UPDATE tenant_members SET business_roles_json = JSON_ARRAY('operations') WHERE tenant_id = 3 AND person_id = 7");
    });

    await t.test("all optimizer entry dependencies share the same A/B/default policy and reject foreign job references", async () => {
      for (const id of [7,2,3]) {
        const actor = session(id), key = businessTaskTenantKey(actor);
        const analyzed = await context.aiImageOptimizerAnalyze({jobNo:"same-direct-optimizer",sourceProductId:"same-sku",imageDataUrl:"data:image/png;base64,AA==",forceAnalyze:true},actor);
        assert.equal(analyzed.job_no,"same-direct-optimizer");
        await context.aiImageOptimizerConfirmAnalysis({jobNo:analyzed.job_no,analysis:{product_type:`Product ${key}`,keep_facts:[key]}},actor);
        await context.aiImageOptimizerPlan({jobNo:analyzed.job_no},actor);
        await context.aiImageOptimizerConfirmPlan({jobNo:analyzed.job_no,plan:{image_optimization_prompt_en:"Keep exact product"}},actor);
        await context.aiImageOptimizerSaveResult({jobNo:analyzed.job_no,result:{marker:key}},actor);
        const detail = await context.aiImageOptimizerJobDetail(analyzed.job_no,actor);
        assert.equal(detail.result.marker,key);
        assert.equal((await context.aiImageOptimizerAnalysisLookup({sourceProductId:"same-sku"},actor)).job_no,analyzed.job_no);
        const paid = charges.length;
        assert.equal((await context.aiImageOptimizerTestImage({jobNo:analyzed.job_no,imagePrompt:"Keep product exact"},actor)).dry_run,true);
        await context.aiImageOptimizerReviewImage({generatedImageUrl:"data:image/png;base64,AA==",jobNo:analyzed.job_no},actor);
        assert.equal(charges.length,paid+1);
        const preview = await context.aiProductMaterialOptimizerPrepareTemplate({optimizerJobNo:analyzed.job_no,finalImageSlots:[{url:"https://fixture.invalid/current.png",role:"main"}]},actor);
        assert.equal(preview.publish_preview.image_count,1);
      }
      const bOnly = await context.aiImageOptimizerAnalyze({jobNo:"b-only-direct",imageDataUrl:"data:image/png;base64,AA==",forceAnalyze:true},session(3));
      const forbidden = [
        () => context.aiImageOptimizerJobDetail(bOnly.job_no,session(2)),
        () => context.aiImageOptimizerConfirmAnalysis({jobNo:bOnly.job_no,analysis:{}},session(2)),
        () => context.aiImageOptimizerPlan({jobNo:bOnly.job_no,analysis:{}},session(2)),
        () => context.aiImageOptimizerConfirmPlan({jobNo:bOnly.job_no,plan:{}},session(2)),
        () => context.aiImageOptimizerSaveResult({jobNo:bOnly.job_no,result:{}},session(2)),
        () => context.aiImageOptimizerTestImage({jobNo:bOnly.job_no,imagePrompt:"Keep product"},session(2)),
        () => context.aiImageOptimizerReviewImage({jobNo:bOnly.job_no,generatedImageUrl:"data:image/png;base64,AA=="},session(2))
      ];
      const paid = charges.length;
      for (const call of forbidden) await assert.rejects(call(),{status:404});
      assert.equal(charges.length,paid);
    });

    await t.test("optimizer persistence rechecks current authorization and references after real row lock waits", {timeout:60000}, async t => {
      const jobNo = "optimizer-lock-boundary";
      await query("INSERT INTO ai_image_optimizer_jobs (tenant_id,job_no,status,analysis_json,plan_json,result_json) VALUES ('2',?,'plan_confirmed',?,?,?)", [jobNo,JSON.stringify({product_type:"Original"}),JSON.stringify({image_optimization_prompt_en:"Keep product"}),JSON.stringify({marker:"original"})]);
      const rowLock = await mysql.createConnection({socketPath,user:"root",database});
      const originalTransaction = context.withMysqlTransaction;
      let waitingForLock = null, lockTarget = "job";
      context.withMysqlTransaction = operation => originalTransaction(connection => operation({
        execute(sql,params) {
          const pending = connection.execute(sql,params);
          if ((lockTarget === "job" && /SELECT id FROM ai_image_optimizer_jobs[\s\S]*FOR UPDATE/.test(sql))
            || (lockTarget === "tenant" && /SELECT id FROM tenants[\s\S]*FOR SHARE/.test(sql))) waitingForLock?.();
          return pending;
        }
      }));
      const restore = async () => {
        await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2 AND person_id=7");
        await query("UPDATE people SET active=1 WHERE id=7");
        await query("UPDATE tenants SET subscription_status='active',subscription_expires_at=NULL WHERE id=2");
        await query("UPDATE listing_drafts SET tenant_id='2' WHERE id=102");
        await query("UPDATE ai_image_task_owners SET tenant_id='2' WHERE task_id='private'");
        await query("UPDATE ai_image_optimizer_jobs SET tenant_id='2',status='plan_confirmed',analysis_json=?,plan_json=?,result_json=? WHERE job_no=?", [JSON.stringify({product_type:"Original"}),JSON.stringify({image_optimization_prompt_en:"Keep product"}),JSON.stringify({marker:"original"}),jobNo]);
      };
      const writers = {
        analyze: body => context.aiImageOptimizerAnalyze({...body,imageDataUrl:"data:image/png;base64,AA==",forceAnalyze:true},session(2)),
        plan: body => context.aiImageOptimizerPlan(body,session(2)),
        confirmAnalysis: body => context.aiImageOptimizerConfirmAnalysis({...body,analysis:{product_type:"Changed"}},session(2)),
        confirmPlan: body => context.aiImageOptimizerConfirmPlan({...body,plan:{image_optimization_prompt_en:"Changed"}},session(2)),
        saveResult: body => context.aiImageOptimizerSaveResult({...body,result:{marker:"changed"}},session(2))
      };
      const scenarios = [
        ...Object.keys(writers).map(writer => ({name:`${writer}: inactive member`,writer,change:() => query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7"),status:403})),
        {name:"revoked business duties",writer:"saveResult",change:() => query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7"),status:403},
        {name:"disabled global account",writer:"confirmAnalysis",change:() => query("UPDATE people SET active=0 WHERE id=7"),status:403},
        {name:"expired subscription while tenant mutex waits",writer:"confirmAnalysis",target:"tenant",change:() => rowLock.execute("UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"),status:403},
        {name:"source draft changes enterprise",writer:"saveResult",body:{sourceDraftId:102},change:() => query("UPDATE listing_drafts SET tenant_id='3' WHERE id=102"),status:404},
        {name:"optimizer job changes enterprise",writer:"saveResult",change:() => rowLock.execute("UPDATE ai_image_optimizer_jobs SET tenant_id='3' WHERE job_no=? AND tenant_id='2'",[jobNo]),status:404},
        {name:"private image changes enterprise",writer:"confirmAnalysis",body:{imageUrl:"/api/ai/file/private/generated/test.png"},change:() => query("UPDATE ai_image_task_owners SET tenant_id='3' WHERE task_id='private'"),status:404}
      ];
      try {
        for (const scenario of scenarios) await t.test(scenario.name, async () => {
          await restore();
          const before = (await query("SELECT analysis_json,plan_json,result_json,status FROM ai_image_optimizer_jobs WHERE tenant_id='2' AND job_no=?",[jobNo]))[0];
          lockTarget = scenario.target || "job";
          const acquireLock = async () => {
            await rowLock.beginTransaction();
            await rowLock.execute(lockTarget === "tenant" ? "SELECT id FROM tenants WHERE id=2 FOR UPDATE" : "SELECT id FROM ai_image_optimizer_jobs WHERE tenant_id='2' AND job_no=? FOR UPDATE",lockTarget === "tenant" ? [] : [jobNo]);
          };
          // Paid work stays outside the persistence transaction. For provider
          // handlers acquire the contested row only after its quota commits.
          if (["analyze","plan"].includes(scenario.writer)) providerHook = acquireLock;
          else await acquireLock();
          const waiting = new Promise(resolve => { waitingForLock = resolve; });
          const pending = writers[scenario.writer]({jobNo,...scenario.body});
          const denied = assert.rejects(pending,error => Number(error.statusCode || error.status) === scenario.status);
          await waiting;
          await scenario.change();
          await rowLock.commit();
          await denied;
          providerHook = null;
          const after = (await query("SELECT analysis_json,plan_json,result_json,status FROM ai_image_optimizer_jobs WHERE job_no=?",[jobNo]))[0];
          assert.deepEqual(after,before);
        });
        await t.test("same-actor nested workflow guards keep the locked transaction and current resource check", async () => {
          await restore();
          lockTarget = "job";
          await rowLock.beginTransaction();
          await rowLock.execute("SELECT id FROM ai_image_optimizer_jobs WHERE tenant_id='2' AND job_no=? FOR UPDATE",[jobNo]);
          const waiting = new Promise(resolve => { waitingForLock = resolve; });
          let lockedGuardCalls = 0;
          const pending = context.withAiTenantSession(session(2),() => context.withAiTenantRequestGuard(async ({connection,lock}={}) => {
            const rows = connection ? (await connection.execute(`SELECT tenant_id FROM listing_drafts WHERE id=102${lock ? " FOR SHARE" : ""}`))[0] : await query("SELECT tenant_id FROM listing_drafts WHERE id=102");
            if (connection && lock) lockedGuardCalls++;
            if (rows[0]?.tenant_id !== "2") throw denial("Original workflow source no longer belongs to this enterprise",409);
          },() => writers.saveResult({jobNo})));
          const denied = assert.rejects(pending,{status:409});
          await waiting;
          await query("UPDATE listing_drafts SET tenant_id='3' WHERE id=102");
          await rowLock.commit();
          await denied;
          assert.equal(lockedGuardCalls,1);
          const [row] = await query("SELECT result_json FROM ai_image_optimizer_jobs WHERE tenant_id='2' AND job_no=?",[jobNo]);
          assert.equal(JSON.parse(row.result_json).marker,"original");
        });
      } finally {
        providerHook = null;
        context.withMysqlTransaction = originalTransaction;
        await rowLock.rollback();
        await rowLock.end();
        await restore();
      }
    });

    await t.test("material checkpoint rechecks actor after item and source locks without losing original evidence", {timeout:30000}, async t => {
      const batch = await submit(102,session(2));
      await query("UPDATE ai_material_optimization_items SET status='running',attempts=1,checkpoint_json=? WHERE batch_no=?",[JSON.stringify({marker:"original"}),batch.batch_no]);
      const [item] = await query("SELECT * FROM ai_material_optimization_items WHERE batch_no=?",[batch.batch_no]);
      const rowLock = await mysql.createConnection({socketPath,user:"root",database});
      const originalTransaction = context.withMysqlTransaction;
      let waitingForLock = null, lockTarget = "item";
      context.withMysqlTransaction = operation => originalTransaction(connection => operation({
        execute(sql,params) {
          const pending = connection.execute(sql,params);
          if ((lockTarget === "item" && /SELECT checkpoint_json[\s\S]*FOR UPDATE/.test(sql))
            || (lockTarget === "source" && /SELECT i.id FROM ai_material_optimization_items[\s\S]*FOR SHARE/.test(sql))) waitingForLock?.();
          return pending;
        }
      }));
      try {
        for (lockTarget of ["item","source"]) await t.test(`membership withdrawn during ${lockTarget} lock wait`,async () => {
          await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
          await rowLock.beginTransaction();
          await rowLock.execute(lockTarget === "item" ? "SELECT id FROM ai_material_optimization_items WHERE id=? FOR UPDATE" : "SELECT id FROM listing_drafts WHERE id=102 FOR UPDATE",lockTarget === "item" ? [item.id] : []);
          const waiting = new Promise(resolve => {waitingForLock=resolve;});
          const pending = context.withAiTenantSession(session(2),() => context.withAiTenantRequestGuard(options => context.assertMaterialResources(item,options),() => context.saveCheckpoint(item,{marker:"changed"})));
          const denied = assert.rejects(pending,{statusCode:403});
          await waiting;
          await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
          await rowLock.commit();
          await denied;
          const [saved] = await query("SELECT checkpoint_json FROM ai_material_optimization_items WHERE id=?",[item.id]);
          assert.equal(JSON.parse(saved.checkpoint_json).marker,"original");
        });
      } finally {
        context.withMysqlTransaction=originalTransaction;
        await rowLock.rollback();
        await rowLock.end();
        await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
        await query("UPDATE ai_material_optimization_items SET status='failed' WHERE id=?",[item.id]);
        await context.refreshBatch(batch.batch_no,"2");
      }
    });

    await t.test("material batch creation completes with a single available transaction connection", async () => {
      const single = mysql.createPool({socketPath,user:"root",database,connectionLimit:1,waitForConnections:false});
      const singleQuery = async (sql,params=[]) => (await single.execute(sql,params))[0];
      const saved = {query:context.mysqlQuery,execute:context.mysqlExecute,transaction:context.withMysqlTransaction,authorize:context.authorizeBusinessTaskSession};
      context.mysqlQuery = context.mysqlExecute = singleQuery;
      context.authorizeBusinessTaskSession = (actor,customQuery) => authorizeBusinessTaskSession(actor,customQuery || singleQuery);
      context.withMysqlTransaction = async operation => {
        const connection = await single.getConnection();
        await connection.beginTransaction();
        try {const result=await operation(connection);await connection.commit();return result;}
        catch (error) {await connection.rollback();throw error;}
        finally {connection.release();}
      };
      try {
        const batch = await submit(102,session(2));
        assert.equal(batch.total_count,1);
        assert.equal(batch.items[0].source_draft_id,102);
        const [savedItem] = await singleQuery("SELECT tenant_id,created_by_person_id FROM ai_material_optimization_items WHERE batch_no=?",[batch.batch_no]);
        assert.equal(savedItem.tenant_id,"2");
        assert.equal(savedItem.created_by_person_id,7);
      } finally {
        context.mysqlQuery=saved.query;
        context.mysqlExecute=saved.execute;
        context.withMysqlTransaction=saved.transaction;
        context.authorizeBusinessTaskSession=saved.authorize;
        await single.end();
      }
    });

    await t.test("provider-return revocation blocks persisted optimizer results and draft writes", async () => {
      providerHook = () => query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7");
      const jobs = (await query("SELECT COUNT(*) n FROM ai_image_optimizer_jobs WHERE tenant_id = '2'"))[0].n;
      await assert.rejects(context.aiImageOptimizerAnalyze({ imageDataUrl: "data:image/png;base64,AA==", forceAnalyze: true }, session(2)), { statusCode: 403 });
      assert.equal((await query("SELECT COUNT(*) n FROM ai_image_optimizer_jobs WHERE tenant_id = '2'"))[0].n, jobs);
      providerHook = null;
      await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 2 AND person_id = 7");
      const batch = await submit(102, session(2)), count = outputs.length;
      imageHook = async () => { await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7"); return { generatedImages: [{ url: "https://fixture.invalid/result.png" }] }; };
      const item = await runBatch(batch);
      assert.equal(item.status, "unknown_review"); assert.equal(outputs.length, count);
      imageHook = null;
      await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 2 AND person_id = 7");
      await assert.rejects(context.retryAiMaterialOptimizationItem(item.item_no, session(2)), { status: 409 });
    });

    await t.test("unknown image submission is preserved across recovery and retry, never charged twice", async () => {
      const batch = await submit(102, session(2));
      imageHook = async () => { throw denial("Provider response was lost", 502); };
      const item = await runBatch(batch);
      assert.equal(item.status, "unknown_review");
      const paid = charges.length;
      await context.recoverAiMaterialOptimizationBatchesOnStartup();
      await assert.rejects(context.retryAiMaterialOptimizationItem(item.item_no, session(2)), { status: 409 });
      assert.equal(charges.length, paid); imageHook = null;
    });

    await t.test("known provider receipt retries poll the same job without another image charge", async () => {
      const batch = await submit(102, session(2));
      imageHook = async payload => { await payload.onProviderJob({ jobId: "known-job" }); throw denial("Poll network lost", 502); };
      let item = await runBatch(batch);
      assert.equal(item.status, "failed");
      const imageCharges = charges.filter(([,kind]) => kind === "image").length;
      await context.retryAiMaterialOptimizationItem(item.item_no, session(2));
      imageHook = async payload => { assert.equal(payload.providerJob.jobId, "known-job"); return { generatedImages: [{ url: "https://fixture.invalid/resumed.png" }] }; };
      item = await runBatch(batch); assert.equal(item.status, "completed");
      assert.equal(charges.filter(([,kind]) => kind === "image").length, imageCharges); imageHook = null;
    });

    await t.test("in-flight revocation preserves a known receipt but prevents another poll or result save", async () => {
      const batch = await submit(102, session(2));
      imageHook = async payload => {
        await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7");
        await payload.onProviderJob({ jobId: "receipt-on-revoke" });
        throw new Error("A revoked request must never reach this next poll");
      };
      const item = await runBatch(batch), state = JSON.parse(item.checkpoint_json);
      assert.equal(state.images.main.provider_job.jobId, "receipt-on-revoke");
      assert.equal(item.status, "failed");
      imageHook = null; await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 2 AND person_id = 7");
    });

    await t.test("each provider poll rechecks original source and cannot save a foreign draft result", async () => {
      const batch = await submit(102,session(2)), before = outputs.length;
      imageHook = async payload => {
        await payload.onProviderJob({jobId:"source-reassigned-in-flight"});
        await query("UPDATE listing_drafts SET tenant_id = '3' WHERE id = 102");
        await context.assertCurrentAiTenantPermission();
        throw new Error("A changed source must stop before a further poll");
      };
      const item = await runBatch(batch); assert.equal(item.status,"failed"); assert.equal(outputs.length,before);
      assert.equal(JSON.parse(item.checkpoint_json).images.main.provider_job.jobId,"source-reassigned-in-flight");
      await assert.rejects(context.retryAiMaterialOptimizationItem(item.item_no,session(2)), {status:404});
      await query("UPDATE listing_drafts SET tenant_id = '2' WHERE id = 102"); imageHook = null;
    });

    await t.test("a late provider response cannot overwrite a later worker claim or mark it failed", async () => {
      const batch = await submit(102,session(2));
      let release,entered;
      const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
      imageHook = async payload => { entered(); await wait; await payload.onProviderJob({jobId:"stale-provider-job"}); return {generatedImages:[{url:"https://fixture.invalid/stale.png"}]}; };
      const pending = runBatch(batch); await ready;
      await query("UPDATE ai_material_optimization_items SET attempts = attempts + 1,checkpoint_json = ? WHERE batch_no = ?",[JSON.stringify({images:{main:{state:"provider_pending",provider_job:{jobId:"new-claim-provider-job"}}}}),batch.batch_no]);
      release(); const item = await pending;
      assert.equal(item.status,"running"); assert.equal(JSON.parse(item.checkpoint_json).images.main.provider_job.jobId,"new-claim-provider-job"); imageHook = null;
      await query("UPDATE ai_material_optimization_items SET status = 'failed' WHERE id = ?",[item.id]);
    });

    await t.test("restart resumes saved image tasks but pauses unknown submissions and unfinished text", async () => {
      const batches = [await submit(102, session(2)), await submit(102, session(2)), await submit(102, session(2))];
      const checkpoints = [{ images: { main: { state: "provider_pending", provider_job: { jobId: "known-after-restart" } } } }, { images: { main: { state: "submitting" } } }, { text_pending: "analysis" }];
      for (let index = 0; index < batches.length; index++) await query("UPDATE ai_material_optimization_items SET status = 'running', checkpoint_json = ? WHERE batch_no = ?", [JSON.stringify(checkpoints[index]), batches[index].batch_no]);
      const paid = charges.length;
      await context.recoverAiMaterialOptimizationBatchesOnStartup();
      const statuses = [];
      for (const batch of batches) statuses.push((await query("SELECT status FROM ai_material_optimization_items WHERE batch_no = ?", [batch.batch_no]))[0].status);
      assert.deepEqual(statuses, ["queued", "unknown_review", "paused_review"]); assert.equal(charges.length, paid);
      await query("UPDATE ai_material_optimization_items SET status = 'failed' WHERE batch_no = ?", [batches[0].batch_no]);
    });

    await t.test("full optimization preserves authoritative detail images and charges the original tenant", async () => {
      const before = outputs.length, paid = charges.length;
      const batch = await submit(102, session(2), { optimizationScope: "full" });
      const item = await runBatch(batch);
      assert.equal(item.status, "completed"); assert.equal(outputs.length, before + 1);
      assert.ok(charges.slice(paid).every(([tenant]) => tenant === "2"));
      assert.equal(outputs.at(-1).body.patch.images.length, 2);
      assert.ok(outputs.at(-1).body.patch.images.every(url => !/STALE|OLD/.test(url)));
    });

    await t.test("default/A/B quota is enforced before a material image submission", async () => {
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = 0 WHERE tenant_id = 2");
      const batch = await submit(102, session(2)), paid = charges.length;
      const item = await runBatch(batch); assert.equal(item.status, "failed"); assert.equal(charges.length, paid);
      assert.match(item.error_message, /额度/);
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = NULL WHERE tenant_id = 2");
    });

    await t.test("real text composition accepts owned private and public images, rejects foreign images", async () => {
      const privateResult = await context.aiImageOptimizerComposeText({ imageUrl: "/api/ai/file/private/generated/test.png", title: "Verified" }, session(2));
      assert.equal(privateResult.url, "https://fixture.invalid/composed.png");
      const publicResult = await context.aiImageOptimizerComposeText({ imageUrl: "https://fixture.invalid/public.png", title: "Verified" }, session(2));
      assert.equal(publicResult.composed, true);
      await assert.rejects(context.aiImageOptimizerComposeText({ imageUrl: "/api/ai/file/private/generated/test.png", title: "Verified" }, session(3)), { status: 404 });
      const requestImage = context.requestPublicImage;
      context.requestPublicImage = async () => { await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7"); return { buffer: imageBytes, contentType: "image/png" }; };
      await assert.rejects(context.aiImageOptimizerComposeText({ imageUrl: "https://fixture.invalid/public.png", title: "Verified" }, session(2)), { statusCode: 403 });
      context.requestPublicImage = requestImage; await query("UPDATE tenant_members SET active = 1 WHERE tenant_id = 2 AND person_id = 7");
    });

    await t.test("forged result and template job references are denied before materializing bytes", async () => {
      const [job] = await query("SELECT job_no FROM ai_image_optimizer_jobs WHERE tenant_id = '2' LIMIT 1");
      await assert.rejects(context.aiImageOptimizerSaveResult({ jobNo: job.job_no, result: { result_draft_id: 103 } }, session(2)), { status: 404 });
      const before = materializations;
      await assert.rejects(context.aiProductMaterialOptimizerPrepareTemplate({ optimizerJobNo: job.job_no, finalImageSlots: [{ url: "/api/ai/file/private/generated/test.png" }] }, session(3)), { status: 404 });
      assert.equal(materializations, before);
      await assert.rejects(context.aiProductMaterialOptimizerPrepareTemplate({ finalImageSlots: [{ url: "https://fixture.invalid/x.png" }] }, null), { statusCode: 403 });
    });

    await t.test("private generated review image verifies owner before any file bytes/provider call", async () => {
      const before = charges.length;
      await assert.rejects(context.aiImageOptimizerReviewImage({ generatedImageUrl: "https://erp.hjt888.xyz/api/ai/file/private/generated/test.png" }, session(3)), { status: 404 });
      assert.equal(charges.length, before); assert.ok(fileReads > 0);
    });

    await t.test("new schema supports equal natural keys in A/B/default with no global unique", async () => {
      for (const tenant of ["admin","2","3"]) await query("INSERT INTO ai_material_optimization_batches (tenant_id,batch_no,created_by_person_id) VALUES (?, 'same-business-no', 7)", [tenant]);
      await verifyAiMaterialOptimizationSchema(query);
      assert.equal((await query("SELECT COUNT(*) n FROM ai_material_optimization_batches WHERE batch_no = 'same-business-no'"))[0].n, 3);
    });

    await t.test("former staff keep proven completed history while unfinished work and unproven relationships still fail closed", async () => {
      const history = [];
      const [optimizer] = await query("SELECT job_no FROM ai_image_optimizer_jobs WHERE tenant_id = '2' LIMIT 1");
      const createHistory = async (name, status, tenant = "2") => {
        const batch = await execute("INSERT INTO ai_material_optimization_batches (tenant_id,batch_no,status,total_count,created_by_person_id) VALUES (?,?,?,1,8)", [tenant,name,status]);
        const item = await execute("INSERT INTO ai_material_optimization_items (tenant_id,item_no,batch_no,source_draft_id,result_draft_id,optimizer_job_no,status,created_by_person_id) VALUES (?,?,?,102,102,?,?,8)", [tenant,`${name}-item`,name,optimizer.job_no,status]);
        return { batch: Number(batch.insertId), item: Number(item.insertId), name };
      };
      for (const status of ["completed","partial","failed"]) history.push(await createHistory(`former-${status}`,status));
      const unfinished = await createHistory("former-unfinished","queued");
      const reviewed = await createHistory("former-reviewed-completed","completed","legacy_review");
      const reviewedActive = await createHistory("former-reviewed-running","running","legacy_review");
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 8");
      await query("UPDATE people SET active = 0 WHERE id = 8");
      const connection = await pool.getConnection();
      try {
        const original = await query("SELECT * FROM ai_material_optimization_items WHERE created_by_person_id = 8 AND tenant_id = '2' AND status <> 'queued' ORDER BY id");
        const plan = await migrateTenantAiMaterialOptimization(connection);
        for (const row of history) assert.ok(!plan.review.some(candidate => candidate.table.endsWith("batches") && candidate.id === row.batch || candidate.table.endsWith("items") && candidate.id === row.item));
        assert.ok(plan.review.some(row => row.table.endsWith("items") && row.id === unfinished.item));
        const manifest = record => {
          const checked = plan.reviewable_batches.find(row => row.batch_id === record.batch);
          return { reason: "Explicit reviewed historical staff relationship", batches: [{ batch_id: checked.batch_id,target_tenant:"2",actor_person_id:8,expected_batch_sha256:checked.expected_batch_sha256,
            items:checked.items.map(item => ({...item,source_draft_id:102,result_draft_id:102,optimizer_job_no:optimizer.job_no})) }] };
        };
        await assert.rejects(migrateTenantAiMaterialOptimization(connection,{reviewManifest:manifest(reviewedActive)}), /original membership unavailable/);
        await migrateTenantAiMaterialOptimization(connection,{apply:true,reviewManifest:manifest(reviewed)});
        assert.deepEqual(await query("SELECT * FROM ai_material_optimization_items WHERE created_by_person_id = 8 AND item_no IN ('former-completed-item','former-partial-item','former-failed-item') ORDER BY id"), original);
        const [approved] = await query("SELECT tenant_id,status FROM ai_material_optimization_items WHERE id = ?", [reviewed.item]);
        assert.deepEqual(approved,{tenant_id:"2",status:"completed"});
        assert.equal((await query("SELECT status FROM ai_material_optimization_items WHERE id = ?", [unfinished.item]))[0].status,"paused_review");
        const paid = charges.length; await context.recoverAiMaterialOptimizationBatchesOnStartup(); assert.equal(charges.length,paid);
        await query("DELETE FROM tenant_members WHERE tenant_id = 2 AND person_id = 8");
        const missingMembership = await migrateTenantAiMaterialOptimization(connection);
        assert.ok(missingMembership.review.some(row => row.table.endsWith("items") && row.id === history[0].item));
      } finally {
        connection.release();
        await query("INSERT INTO tenant_members (tenant_id,person_id,active,role,business_roles_json) VALUES (2,8,1,'member',JSON_ARRAY('operations')) ON DUPLICATE KEY UPDATE active = 1");
        await query("UPDATE people SET active = 1 WHERE id = 8");
      }
    });

    await t.test("legacy migration defaults to read only, retains unknown rows in an explicit quarantine", async () => {
      await query("DELETE FROM ai_material_optimization_items"); await query("DELETE FROM ai_material_optimization_batches");
      await query("ALTER TABLE ai_material_optimization_batches DROP INDEX uq_ai_material_batch_no, DROP COLUMN tenant_id, ADD UNIQUE KEY uq_ai_material_batch_no (batch_no)");
      await query("ALTER TABLE ai_material_optimization_items DROP INDEX uq_ai_material_item_no, DROP COLUMN tenant_id, DROP COLUMN checkpoint_json, ADD UNIQUE KEY uq_ai_material_item_no (item_no)");
      await query("INSERT INTO ai_material_optimization_batches (batch_no,status,created_by_person_id) VALUES ('legacy','running',NULL)");
      await query("INSERT INTO ai_material_optimization_items (item_no,batch_no,source_draft_id,status,created_by_person_id) VALUES ('legacy-item','legacy',102,'running',NULL)");
      await query("INSERT INTO ai_material_optimization_batches (batch_no,status,total_count,created_by_person_id) VALUES ('legacy-completed','completed',1,7)");
      await query("INSERT INTO ai_material_optimization_items (item_no,batch_no,source_draft_id,status,created_by_person_id) VALUES ('legacy-completed-item','legacy-completed',103,'completed',7)");
      await query("INSERT INTO ai_material_optimization_batches (batch_no,status,total_count,created_by_person_id) VALUES ('reviewed-completed','completed',1,7)");
      await query("INSERT INTO ai_material_optimization_items (item_no,batch_no,source_draft_id,status,created_by_person_id) VALUES ('reviewed-completed-item','reviewed-completed',101,'completed',7)");
      const connection = await pool.getConnection();
      try {
        const preview = await migrateTenantAiMaterialOptimization(connection); assert.equal(preview.mode, "dry-run");
        assert.ok(!(await query("SHOW COLUMNS FROM ai_material_optimization_items")).some(row => row.Field === "tenant_id"));
        const [reviewBatch] = await query("SELECT id FROM ai_material_optimization_batches WHERE batch_no = 'reviewed-completed'");
        const checked = preview.reviewable_batches.find(row => row.batch_id === Number(reviewBatch.id));
        const manifest = { reason: "Explicit fixture-reviewed source and actor", batches: [{ batch_id: checked.batch_id,target_tenant: "admin",actor_person_id: 7,
          expected_batch_sha256: checked.expected_batch_sha256,items: checked.items.map(item => ({ ...item,source_draft_id:101,result_draft_id:null,optimizer_job_no:"" })) }] };
        await assert.rejects(migrateTenantAiMaterialOptimization(connection, { reviewManifest: {...manifest,batches:[{...manifest.batches[0],expected_batch_sha256:"changed"}]} }), /fingerprint/);
        await assert.rejects(migrateTenantAiMaterialOptimization(connection, { reviewManifest: {...manifest,batches:[{...manifest.batches[0],target_tenant:"2"}]} }), /ownership mismatch/);
        const applied = await migrateTenantAiMaterialOptimization(connection, { apply: true, reviewManifest: manifest }); assert.ok(applied.review.length >= 2);
        assert.equal(applied.reviewed_batches.length, 1);
        await migrateTenantAiMaterialOptimization(connection, { apply: true });
      } finally { connection.release(); }
      const [legacy] = await query("SELECT * FROM ai_material_optimization_items WHERE item_no = 'legacy-item'");
      assert.match(legacy.tenant_id, /^legacy_review:/); assert.equal(legacy.status, "paused_review"); assert.equal(legacy.created_by_person_id, null);
      const review = JSON.parse(legacy.ownership_review_json); assert.equal(review.status, "running");
      assert.equal((await context.aiMaterialOptimizationBatches({}, session(2))).length, 0);
      const [completed] = await query("SELECT * FROM ai_material_optimization_items WHERE item_no = 'legacy-completed-item'");
      assert.match(completed.tenant_id, /^legacy_review:/); assert.equal(completed.status, "completed");
      assert.notEqual(completed.tenant_id, legacy.tenant_id);
      assert.equal(JSON.parse(completed.ownership_review_json).tenant_id, null);
      const [approved] = await query("SELECT tenant_id,status,ownership_review_json FROM ai_material_optimization_items WHERE item_no = 'reviewed-completed-item'");
      assert.equal(approved.tenant_id,"admin"); assert.equal(approved.status,"completed");
      assert.equal(JSON.parse(approved.ownership_review_json).tenant_id,null);
      const restoreConnection = await pool.getConnection();
      try {
        const reviewPlan = await migrateTenantAiMaterialOptimization(restoreConnection);
        const [candidate] = await query("SELECT id FROM ai_material_optimization_batches WHERE batch_no = 'legacy-completed'");
        const expected = reviewPlan.reviewable_batches.find(row=>row.batch_id === Number(candidate.id));
        const manifest = {reason:"Subsequently reviewed historical identity",batches:[{batch_id:expected.batch_id,target_tenant:"3",actor_person_id:7,expected_batch_sha256:expected.expected_batch_sha256,
          items:expected.items.map(item=>({...item,source_draft_id:103,result_draft_id:null,optimizer_job_no:""}))}]};
        await migrateTenantAiMaterialOptimization(restoreConnection,{apply:true,reviewManifest:manifest});
      } finally {restoreConnection.release();}
      const [restored] = await query("SELECT tenant_id,ownership_review_json FROM ai_material_optimization_items WHERE item_no = 'legacy-completed-item'");
      assert.equal(restored.tenant_id,"3"); assert.equal(JSON.parse(restored.ownership_review_json).tenant_id,null);
      assert.equal(JSON.parse(restored.ownership_review_json).status,"completed"); assert.ok(JSON.parse(restored.ownership_review_json).review_history.length);
      await query("INSERT INTO ai_material_optimization_batches (tenant_id,batch_no,status,total_count,created_by_person_id) VALUES ('2','bad-completed','completed',1,7)");
      await query("INSERT INTO ai_material_optimization_items (tenant_id,item_no,batch_no,source_draft_id,status,created_by_person_id) VALUES ('2','bad-completed-item','bad-completed',103,'completed',7)");
      await query("ALTER TABLE ai_material_optimization_items ADD UNIQUE KEY unscoped_pair (source_draft_id,item_no)");
      await assert.rejects(verifyAiMaterialOptimizationSchema(query), {code:"AI_MATERIAL_SCHEMA_PENDING"});
      const fixConnection = await pool.getConnection();
      try {
        const plan = await migrateTenantAiMaterialOptimization(fixConnection); assert.ok(plan.tables.find(row=>row.table.endsWith("items")).remove_unscoped_unique_indexes.includes("unscoped_pair"));
        await migrateTenantAiMaterialOptimization(fixConnection,{apply:true});
      } finally {fixConnection.release();}
      const [badCompleted] = await query("SELECT tenant_id,status,ownership_review_json FROM ai_material_optimization_items WHERE item_no = 'bad-completed-item'");
      assert.match(badCompleted.tenant_id,/^legacy_review:/); assert.equal(badCompleted.status,"completed");
      assert.equal(JSON.parse(badCompleted.ownership_review_json).tenant_id,"2");
      await verifyAiMaterialOptimizationSchema(query);
      await query("DROP TABLE ai_image_optimizer_jobs");
      const connection2 = await pool.getConnection();
      try { const preview = await migrateTenantAiMaterialOptimization(connection2); assert.ok(preview.missing_dependencies.includes("ai_image_optimizer_jobs")); }
      finally { connection2.release(); }
      await context.recoverAiMaterialOptimizationBatchesOnStartup(); assert.equal(charges.length > 0, true);
      assert.equal((await query("SELECT status FROM ai_material_optimization_items WHERE id = ?", [legacy.id]))[0].status, "paused_review");
    });
  } finally { if (pool) await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

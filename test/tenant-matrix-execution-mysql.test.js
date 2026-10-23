import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { authorizeBusinessTaskSession, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";

const sourceUrl = new URL("../src/services/asset-variant-engine.js", import.meta.url);
const session = (id, personId = 7) => ({ personId, roles: ["operations"], tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}`, role: "member" } });
const tenantKey = id => id === 1 ? "admin" : String(id);
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=", "base64");

test("matrix execution preserves enterprise, original actor, resources and publish receipts in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("matrix_execution");
  const cleanup = new Set();
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const actual = await import(sourceUrl.href);
    const listing = await import("../src/services/listing-automation.js");
    await query("INSERT INTO tenants (id,slug,name,status,subscription_status) VALUES (1,'default','Default','active','active'),(2,'enterprise-2','A','active','active'),(3,'enterprise-3','B','active','active')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations'),(8,'Other operator','operations'),(9,'Packer','packing')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,role,business_roles_json) VALUES (1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations')),(2,8,'member',JSON_ARRAY('operations')),(2,9,'member',JSON_ARRAY('packing'))");
    await query("ALTER TABLE shops ADD ozon_api_key TEXT NULL");
    await query("INSERT INTO shops (id,tenant_id,name,status,ozon_client_id,ozon_api_key) VALUES (10,NULL,'Legacy','active','client-10','key-10'),(11,1,'Default','active','client-11','key-11'),(20,2,'A','active','client-20','key-20'),(21,2,'A2','active','client-21','key-21'),(30,3,'B','active','client-30','key-30')");
    await query("INSERT INTO products (id,tenant_id,name,active,package_weight_g) VALUES (101,1,'Default product',1,100),(200,2,'A product',1,100),(300,3,'B product',1,100)");
    await query("INSERT INTO tenant_ai_limits (tenant_id,monthly_request_limit) VALUES (1,100),(2,100),(3,100)");
    await actual.assetVariantJobs({}, session(2));
    await listing.ensureListingAutomationSchema();

    let source = readFileSync(sourceUrl, "utf8");
    const imports = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.filter(node => node.type === "ImportDeclaration");
    const globals = {};
    for (const declaration of imports) {
      const name = declaration.source.value;
      const module = await import(name.startsWith(".") ? new URL(name, sourceUrl).href : name);
      for (const binding of declaration.specifiers) globals[binding.local.name] = binding.type === "ImportDefaultSpecifier" ? module.default
        : binding.type === "ImportNamespaceSpecifier" ? module : module[binding.imported.name];
    }
    for (const declaration of [...imports].reverse()) source = source.slice(0, declaration.start) + source.slice(declaration.end);
    const calls = [], scheduled = [];
    let hook = null, retryStatus = "submitted", transactionsHook = null;
    const stage = async (name, detail = {}) => {
      const current = globals.currentAiTenantSession();
      calls.push({ name, tenant: current?.tenant?.id, person: current?.personId, ...detail });
      if (hook) await hook(name, detail);
    };
    const context = vm.createContext({ ...globals, process, Buffer, URL, URLSearchParams, AbortSignal,
      console: { info() {}, warn() {}, error() {} }, setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout() {} });
    vm.runInContext(source.replaceAll("export ", "") + "\nschemaReady = true;", context);
    const originalImageGenerator = context.generateVariantImages;
    const originalTemplatePersistence = context.ensureAssetVariantListingTemplateFromPackage;
    let transactionDepth = 0;
    const tx = async action => {
      await fixture.connection.beginTransaction();
      transactionDepth++;
      const wrapped = { execute: async (sql, params) => {
        const value = await fixture.connection.execute(sql, params);
        if (transactionsHook) await transactionsHook(sql, params);
        return value;
      } };
      try { const value = await action(wrapped); await fixture.connection.commit(); return value; }
      catch (error) { await fixture.connection.rollback(); throw error; }
      finally { transactionDepth--; }
    };
    const candidates = Object.fromEntries(["traffic", "material", "scenario", "value", "premium"].map(style => [style, { ru: "Защитный чехол автомобильного ключа для TENET T7", zh: "汽车钥匙保护壳" }]));
    Object.assign(context, {
      mysqlQuery: query, mysqlExecute: query, withMysqlTransaction: tx,
      authorizeBusinessTaskSession: (value, currentQuery = query) => authorizeBusinessTaskSession(value, currentQuery),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      ensureListingAutomationSchema: async () => {},
      assetVariantBootstrap: async (_query, actor) => {
        const scope = globals.assetVariantTenantScope(actor);
        const rows = await query(`SELECT id,name FROM shops s WHERE status = 'active' AND ${globals.assetVariantTenantPredicate(scope, "s")}`, [scope.id]);
        return { shops: rows.map(row => ({ ...row, rule: { mainImagePlan: "original" } })), watermarkTemplates: [], tailTemplates: [] };
      },
      generateVariantCopyPack: async (_material, shop) => {
        await context.cachedAiCall({ kind: "matrix", cacheInput: { shop: shop.id }, request: { prompt: "Fixture" } });
        return { titleCandidates: candidates, tags: ["#авто", "#чехол"], description: "Защитный чехол для автомобильного ключа." };
      },
      chatWithAiProvider: async () => {
        await globals.reserveTenantAiRequest?.("text");
        // The provider layer owns quota accounting; the real quota helper is
        // invoked here while external AI requests remain fully substituted.
        if (!globals.reserveTenantAiRequest) {
          const { reserveTenantAiRequest } = await import("../src/services/ai-tenant-context.js");
          await reserveTenantAiRequest("text");
        }
        await stage("ai"); return { content: "fixture copy" };
      },
      generateVariantImages: async options => {
        cleanup.add(path.dirname(options.shopDir));
        await options.throwIfCancelled?.(); await stage("images", { shop: options.shopId });
        await options.throwIfCancelled?.();
        return { images: [{ type: "main", url: "https://fixture.invalid/main.jpg" }], warnings: [] };
      },
      ensureAssetVariantVideoFromImages: async () => { await stage("video"); return null; },
      ensureAssetVariantListingTemplateFromPackage: async (connection, variant) => {
        await stage("template", { variant: variant.id });
        const [inserted] = await connection.execute(`INSERT INTO listing_category_templates
          (tenant_id,template_name,ozon_category_id,category_name,required_attributes_json,ai_rules_json,title_prompt,description_prompt,image_rules_json,created_by_person_id)
          VALUES (?,?,?,'Fixture','[]','{}','','','{}',?)`, [globals.aiTenantId(), `matrix-${variant.id}`, "fixture", globals.currentAiTenantSession().personId]);
        return Number(inserted.insertId);
      },
      generateUniqueListingOfferId: async ({ shopId }) => `fixture-offer-${shopId}-${calls.length}`,
      listingCategoryTemplateDetail: async id => ({ id, title: "Fixture" }),
      validateAssetVariantPublishPrecheck: async () => ({ ok: true, errors: [], warnings: [] }),
      publishListingTemplateToOzon: async (body, actor) => {
        const shopId = body.shop_ids[0];
        await stage("publish", { shop: shopId });
        const shop = (await query("SELECT ozon_client_id,ozon_api_key FROM shops WHERE id = ? AND tenant_id = ?", [shopId, actor.tenant.id]))[0];
        assert.equal(shop.ozon_client_id, `client-${shopId}`); assert.equal(shop.ozon_api_key, `key-${shopId}`);
        const record = await query("INSERT INTO listing_publish_records (tenant_id,draft_id,shop_id,task_id,status,created_by_person_id) VALUES (?,?,?,'receipt','submitted',?)", [tenantKey(actor.tenant.id), body.source_draft_id, shopId, actor.personId]);
        return { results: [{ ok: true, record_id: record.insertId, shop_id: shopId, task_id: "receipt", status: "submitted" }] };
      },
      retryListingPublishRecord: async (id, _body, actor) => {
        const row = (await query("SELECT id,shop_id,tenant_id FROM listing_publish_records WHERE id = ?", [id]))[0];
        assert.equal(row.tenant_id, tenantKey(actor.tenant.id));
        await stage("retry", { record: id, shop: row.shop_id });
        return { id, task_id: retryStatus === "resubmitting" ? "" : "receipt", status: retryStatus };
      },
      requestPublicImage: async (url, options) => {
        assert.equal(options.maxBytes, 20 * 1024 * 1024);
        await options.beforeRequest(); await stage("media", { url }); return { buffer: pixel };
      }
    });
    const material = id => ({ title: "汽车钥匙保护壳", mainImage: "https://fixture.invalid/main.jpg", sourceProductId: id, basePriceRmb: 10, weightG: 100 });
    const generated = new Map();
    const active = () => query("UPDATE tenant_members SET active = 1, business_roles_json = JSON_ARRAY('operations') WHERE person_id = 7");

    await t.test("default/A/B generate only their own source and shops with separate quota and cache", async () => {
      for (const [tenant, product, shop] of [[1,101,11],[2,200,20],[3,300,30]]) {
        const result = await context.generateAssetVariants({ material: material(product), shopIds: [shop], tenant_id: "forged", created_by_person_id: 8 }, session(tenant));
        generated.set(tenant, result.variants[0].id);
        const row = (await query("SELECT shop_id,source_product_id,created_by_person_id FROM asset_variants WHERE id = ?", [result.variants[0].id]))[0];
        assert.deepEqual(row, { shop_id: shop, source_product_id: product, created_by_person_id: 7 });
      }
      assert.deepEqual((await query("SELECT tenant_id,request_count FROM tenant_ai_usage ORDER BY tenant_id")).map(row => [row.tenant_id,row.request_count]), [[1,1],[2,1],[3,1]]);
      assert.equal((await query("SELECT COUNT(*) AS n FROM asset_variant_ai_cache"))[0].n, 3);
    });

    await t.test("enqueue rejects foreign source and shops before saving a task; body cannot replace original actor", async () => {
      for (const body of [{ material: material(300), shopIds: [20] }, { material: material(200), shopIds: [30] }]) {
        await assert.rejects(context.enqueueGenerateAssetVariants(body, session(2)), /不属于当前企业/);
      }
      assert.equal((await query("SELECT COUNT(*) AS n FROM asset_variant_jobs"))[0].n, 0);
      const queued = await context.enqueueGenerateAssetVariants({ material: material(200), shopIds: [20], tenant_id: "3", created_by_person_id: 8 }, session(2));
      const row = (await query("SELECT tenant_id,created_by_person_id FROM asset_variant_jobs WHERE id = ?", [queued.jobId]))[0];
      assert.deepEqual(row, { tenant_id: "2", created_by_person_id: 7 });
      assert.equal(await context.assetVariantJobDetail(queued.jobId, session(3)), null);
      assert.equal(await context.assetVariantJobDetail(queued.jobId, session(2,8)), null);
      assert.deepEqual(Array.from(await context.assetVariantJobs({ createdByPersonId: 7 }, session(2,8))), []);
      await assert.rejects(context.cancelAssetVariantJob(queued.jobId, session(2,8)), /not found/);
    });

    await t.test("AI revocation and exhausted quota abort without fallback generation or cache writes", async () => {
      await query("DELETE FROM asset_variant_ai_cache");
      const before = (await query("SELECT COUNT(*) AS n FROM asset_variants"))[0].n;
      hook = async name => { if (name === "ai") await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7"); };
      await assert.rejects(context.generateAssetVariants({ material: material(200), shopIds: [20] }, session(2)), { statusCode: 403 });
      hook = null; await active();
      assert.equal((await query("SELECT COUNT(*) AS n FROM asset_variants"))[0].n, before);
      assert.equal((await query("SELECT COUNT(*) AS n FROM asset_variant_ai_cache"))[0].n, 0);
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = 0 WHERE tenant_id = 2");
      const aiBefore = calls.filter(item => item.name === "ai").length;
      await assert.rejects(context.generateAssetVariants({ material: material(200), shopIds: [20] }, session(2)), { statusCode: 409 });
      assert.equal(calls.filter(item => item.name === "ai").length, aiBefore);
      await query("UPDATE tenant_ai_limits SET monthly_request_limit = 100 WHERE tenant_id = 2");
    });

    await t.test("import is idempotent and never reads another enterprise variant", async () => {
      await assert.rejects(context.importAssetVariantToListingAutomation({ variantIds: [generated.get(3)] }, session(2)), { statusCode: 404 });
      const one = await context.importAssetVariantToListingAutomation({ variantIds: [generated.get(2)] }, session(2));
      const two = await context.importAssetVariantToListingAutomation({ variantIds: [generated.get(2)] }, session(2));
      assert.equal(one.drafts[0].draftId, two.drafts[0].draftId);
      assert.equal(two.drafts[0].reused, true);
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_drafts WHERE tenant_id = '2'"))[0].n, 1);
    });

    await t.test("revocation after import row lock rolls the complete draft transaction back", async () => {
      transactionsHook = async sql => { if (sql.includes("asset_variants WHERE id = ? FOR UPDATE")) {
        transactionsHook = null;
        // A separate pool connection makes revocation visible after the lock.
        const { mysqlExecute } = await import("../src/mysql-pool.js");
        await mysqlExecute("UPDATE tenant_members SET active = 0 WHERE tenant_id = 3 AND person_id = 7");
      } };
      await assert.rejects(context.importAssetVariantToListingAutomation({ variantIds: [generated.get(3)] }, session(3)), { statusCode: 403 });
      transactionsHook = null; await active();
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_drafts WHERE tenant_id = '3'"))[0].n, 0);
    });

    await t.test("publishing binds original draft/receipt and repeated call reconciles the same record", async () => {
      const first = await context.publishAssetVariantsToOzon({ variantIds: [generated.get(2)] }, session(2));
      assert.equal(first.published, 1);
      const second = await context.publishAssetVariantsToOzon({ variantIds: [generated.get(2)] }, session(2));
      assert.equal(second.published, 1);
      assert.equal(calls.filter(item => item.name === "publish").length, 1);
      assert.equal(calls.filter(item => item.name === "retry").length, 1);
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_publish_records WHERE tenant_id = '2'"))[0].n, 1);
      for (const status of ["failed", "resubmitting"]) {
        retryStatus = status;
        const result = await context.publishAssetVariantsToOzon({ variantIds: [generated.get(2)] }, session(2));
        assert.equal(result.published, 0, status);
        assert.equal(result.ok, false, status);
        assert.equal(result.results[0].status, status === "failed" ? "failed" : "reconciliation_required");
      }
      retryStatus = "submitted";
    });

    await t.test("unknown pre-receipt attempt cannot submit another offer", async () => {
      await query("UPDATE asset_variants SET status = 'submitting' WHERE id = ?", [generated.get(1)]);
      const precheck = context.validateAssetVariantPublishPrecheck;
      context.validateAssetVariantPublishPrecheck = async () => ({ ok: false, errors: ["Invalid field"], warnings: [] });
      await assert.rejects(context.publishAssetVariantsToOzon({ variantIds: [generated.get(1)] }, session(1)), { code: "LISTING_PUBLISH_RECONCILIATION_REQUIRED" });
      assert.equal((await query("SELECT status FROM asset_variants WHERE id = ?", [generated.get(1)]))[0].status, "submitting");
      context.validateAssetVariantPublishPrecheck = precheck;
      await assert.rejects(context.publishAssetVariantsToOzon({ variantIds: [generated.get(1)] }, session(1)), { code: "LISTING_PUBLISH_RECONCILIATION_REQUIRED" });
      assert.equal(calls.filter(item => item.name === "publish").length, 1);
    });

    await t.test("restart suspends interrupted publishing and restores queued work only as persisted actor", async () => {
      await query("INSERT INTO asset_variant_jobs (tenant_id,job_no,job_type,status,created_by_person_id,request_json) VALUES ('3','interrupted-publish','publish_selection','running',7,'{}')");
      await query("INSERT INTO asset_variant_jobs (tenant_id,job_no,job_type,status,created_by_person_id,request_json) VALUES ('3','interrupted-image','generate_variants','running',7,'{}')");
      await context.recoverAssetVariantJobsOnStartup();
      assert.equal((await query("SELECT status FROM asset_variant_jobs WHERE job_no = 'interrupted-publish'"))[0].status, "reconciliation_required");
      assert.equal((await query("SELECT status FROM asset_variant_jobs WHERE job_no = 'interrupted-image'"))[0].status, "reconciliation_required");
      const row = (await query("SELECT id FROM asset_variant_jobs WHERE tenant_id = '2' AND status = 'queued'"))[0];
      await globals.withAiTenantSession(session(3), () => context.runAssetVariantJob({ id: row.id }));
      const done = (await query("SELECT status,tenant_id,created_by_person_id FROM asset_variant_jobs WHERE id = ?", [row.id]))[0];
      assert.deepEqual(done, { status: "success", tenant_id: "2", created_by_person_id: 7 });
      assert.equal(calls.filter(item => item.name === "images").at(-1).tenant, 2);
    });

    await t.test("remote image uses bounded per-request guards and drops revoked responses", async () => {
      await assert.rejects(globals.withAiTenantSession(session(2), () => context.readImageBuffer("/api/platform/private")), { statusCode: 403 });
      hook = async name => { if (name === "media") await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7"); };
      await assert.rejects(globals.withAiTenantSession(session(2), () => context.readImageBuffer("https://fixture.invalid/source.png")), { statusCode: 403 });
      hook = null; await active();
    });

    await t.test("a stopped original shop prevents text retry and image provider polling", async () => {
      const originalTimer = context.setTimeout;
      context.setTimeout = globalThis.setTimeout;
      const before = calls.filter(item => item.name === "ai").length;
      hook = async name => { if (name === "ai") {
        await query("UPDATE shops SET status = 'disabled' WHERE id = 20");
        throw Object.assign(new Error("Transient provider failure"), { status: 503 });
      } };
      await assert.rejects(globals.withAiTenantSession(session(2), () => context.cachedAiCall({
        kind: "shop-retry", cacheInput: { retry: true }, resources: { shopIds: [20], productId: 200 }, maxAttempts: 2
      })), { statusCode: 403 });
      assert.equal(calls.filter(item => item.name === "ai").length, before + 1);
      hook = null; context.setTimeout = originalTimer;
      await query("UPDATE shops SET status = 'active' WHERE id = 20");
      const { assertCurrentAiTenantPermission } = await import("../src/services/ai-tenant-context.js");
      let polls = 0;
      context.editOpenAiImage = async () => {
        await assertCurrentAiTenantPermission(); polls += 1;
        await query("UPDATE shops SET status = 'disabled' WHERE id = 20");
        await assertCurrentAiTenantPermission(); polls += 1;
        return pixel;
      };
      const reference = await globals.sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
      await assert.rejects(globals.withAiTenantSession(session(2), () => context.withAssetProviderGuard(session(2), {},
        { shopIds: [20], productId: 200 }, () => context.generateAiSimilarMainImage({ mainBuffer: reference, material: {} }))), { statusCode: 403 });
      assert.equal(polls, 1);
      await query("UPDATE shops SET status = 'active' WHERE id = 20");
    });

    await t.test("temporary AI storage is not considered a permanent publish media asset", () => {
      const original = context.isManagedOssObjectUrl;
      context.isManagedOssObjectUrl = (url, options = {}) => options.prefix ? url.includes(`/${options.prefix}/`) : url.startsWith("https://fixture.invalid/");
      assert.equal(context.reusablePermanentMediaResult("https://fixture.invalid/ai-unused/temp.jpg", "main"), null);
      assert.equal(context.reusablePermanentMediaResult("https://fixture.invalid/listing-media/stable.jpg", "main").reused, true);
      context.isManagedOssObjectUrl = original;
    });

    await t.test("required detail image failures cannot silently produce a smaller media package", async () => {
      const batchDir = path.resolve("uploads", "shop-variants", fixture.database);
      cleanup.add(batchDir);
      const originalReader = context.readImageBuffer, originalResult = context.imageResult;
      const originalManaged = context.isManagedOssObjectUrl;
      const buffer = await globals.sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
      context.imageResult = async (_file, type) => ({ type, url: "https://fixture.invalid/stable.jpg" });
      context.isManagedOssObjectUrl = () => false;
      for (const code of [403, 503]) {
        context.readImageBuffer = async source => {
          if (source === "detail") throw Object.assign(new Error("Detail image rejected"), { statusCode: code });
          return buffer;
        };
        await assert.rejects(originalImageGenerator({ material: { mainImage: "main", detailImages: ["detail"] },
          shopDir: path.join(batchDir, `shop-${code}`), watermark: null, mainImagePlan: "original", batchId: fixture.database,
          shopId: 20, throwIfCancelled: async () => {} }), code === 403 ? { statusCode: 403 } : /未保存不完整/);
      }
      context.readImageBuffer = originalReader; context.imageResult = originalResult; context.isManagedOssObjectUrl = originalManaged;
    });

    await t.test("a failed parallel item drains running siblings and never claims another item", async () => {
      let finishLate;
      const late = new Promise(resolve => { finishLate = resolve; });
      const started = [], finished = [];
      let settled = false;
      const running = context.mapWithConcurrency([1,2,3], 2, async item => {
        started.push(item);
        if (item === 1) throw new Error("First item failed");
        await late; finished.push(item);
      });
      const checked = assert.rejects(running, /First item failed/).then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      assert.deepEqual(started, [1,2]);
      finishLate(); await checked;
      assert.deepEqual(finished, [2]);
      assert.deepEqual(started, [1,2]);
    });

    await t.test("a shared media limiter retains each queued enterprise and original actor context", async () => {
      const limiter = context.createConcurrencyLimiter(1);
      let release, entered, queued;
      const waiting = new Promise(resolve => { release = resolve; });
      const firstEntered = new Promise(resolve => { entered = resolve; });
      const secondQueued = new Promise(resolve => { queued = resolve; });
      const seen = [];
      const first = globals.withAiTenantSession(session(2), () => limiter(async () => {
        seen.push([globals.currentAiTenantSession().tenant.id, globals.currentAiTenantSession().personId]);
        entered();
        await waiting;
      }));
      await firstEntered;
      const second = globals.withAiTenantSession(session(3), () => {
        const task = limiter(async () => {
          seen.push([globals.currentAiTenantSession().tenant.id, globals.currentAiTenantSession().personId]);
        });
        queued(); return task;
      });
      await secondQueued;
      release(); await Promise.all([first,second]);
      assert.deepEqual(seen, [[2,7],[3,7]]);
    });

    await t.test("the provider runtime queue restores B's resource guard after A releases its slot", async () => {
      const { withAiImageRuntimeSlot, aiImageRuntimeMetrics } = await import("../src/services/ai-image-runtime-limiter.js");
      const channel = { channelId: `matrix-context-${fixture.database}`, maxConcurrency: 1, poolMaxConcurrency: 1 };
      let entered, release;
      const firstEntered = new Promise(resolve => { entered = resolve; });
      const waiting = new Promise(resolve => { release = resolve; });
      const seen = [];
      const first = globals.withAiTenantSession(session(2), () => context.withAssetProviderGuard(session(2), {}, { shopIds: [20] },
        () => withAiImageRuntimeSlot(channel, async () => { seen.push(globals.currentAiTenantSession().tenant.id); entered(); await waiting; })));
      await firstEntered;
      const second = globals.withAiTenantSession(session(3), () => context.withAssetProviderGuard(session(3), {}, { shopIds: [30] },
        () => withAiImageRuntimeSlot(channel, async () => { seen.push(globals.currentAiTenantSession().tenant.id); })));
      for (let turn = 0; turn < 100 && !aiImageRuntimeMetrics().waitingTotal; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(aiImageRuntimeMetrics().waitingTotal, 1);
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2 AND person_id = 7");
      release(); await Promise.all([first,second]);
      assert.deepEqual(seen, [2,3]);
      await active();
    });

    await t.test("import prepares paid copy outside transactions and concurrent reentry reuses one atomic draft", async () => {
      const inserted = await query(`INSERT INTO asset_variants
        (batch_id,shop_id,source_product_id,source_title,variant_title,description_text,tags_json,images_json)
        VALUES ('import-preparation',20,200,'Уникальный ключ подготовки','Уникальный ключ подготовки','Ключ','[]','[]')`);
      const id = Number(inserted.insertId);
      const persisted = context.ensureAssetVariantListingTemplateFromPackage;
      context.ensureAssetVariantListingTemplateFromPackage = originalTemplatePersistence;
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const waiting = new Promise(resolve => { release = resolve; });
      let aiCount = 0;
      hook = async name => {
        if (name !== "ai") return;
        aiCount++;
        assert.equal(transactionDepth, 0, "paid copy must not retain an import transaction");
        // The real lightweight writer takes tenant then product, exactly the
        // path which previously deadlocked with import holding product first.
        const saved = await listing.createAiVariantListingDraftLightweight({
          offer_id: `CONCURRENT-${fixture.database}`, product_name: "Concurrent own draft", source_product_id: 200,
          template_payload: { title: "Concurrent own draft", editable_payload: { title: "Concurrent own draft", variants: [{ images: [] }] } },
          source_images: [], ai_optimization: { source: "ai_product_material_optimizer" }
        }, session(2), { summaryOnly: true });
        assert.ok(saved.id > 0);
        enter(); await waiting;
      };
      try {
        const first = context.importAssetVariantToListingAutomation({ variantIds: [id] }, session(2));
        await entered;
        const second = context.importAssetVariantToListingAutomation({ variantIds: [id] }, session(2));
        release();
        const [one, two] = await Promise.all([first, second]);
        assert.equal(one.drafts[0].draftId, two.drafts[0].draftId);
        assert.equal(two.drafts[0].reused, true);
        assert.equal(aiCount, 1);
        assert.equal((await query("SELECT COUNT(*) n FROM listing_drafts WHERE tenant_id='2' AND internal_code=?", [`AV-${id}`]))[0].n, 1);
        assert.equal((await query("SELECT COUNT(*) n FROM listing_shop_copies WHERE draft_id=?", [one.drafts[0].draftId]))[0].n, 1);
        const [template] = await query("SELECT tenant_id,created_by_person_id FROM listing_category_templates WHERE id=?", [one.drafts[0].templateId]);
        assert.deepEqual(template, { tenant_id: "2", created_by_person_id: 7 });
      } finally { release(); hook = null; context.ensureAssetVariantListingTemplateFromPackage = persisted; }
    });

    await t.test("import resource wait uses current membership and rolls template/draft back together", async () => {
      const inserted = await query(`INSERT INTO asset_variants
        (batch_id,shop_id,source_product_id,source_title,variant_title,description_text,tags_json,images_json)
        VALUES ('import-lock-review',20,200,'Проверка права','Проверка права','Защитный чехол для автомобильного ключа из прочного материала для ежедневного использования','[]','[]')`);
      const id = Number(inserted.insertId);
      const { getMysqlPool, mysqlExecute } = await import("../src/mysql-pool.js");
      const blocker = await getMysqlPool().getConnection();
      await blocker.beginTransaction();
      await blocker.execute("SELECT id FROM products WHERE id=200 FOR UPDATE");
      let enter, proceed;
      const entered = new Promise(resolve => { enter = resolve; });
      const waiting = new Promise(resolve => { proceed = resolve; });
      transactionsHook = async sql => {
        if (sql.includes("FROM shops s WHERE") && sql.includes("FOR SHARE")) {
          transactionsHook = null; enter(); await waiting;
        }
      };
      const pending = context.importAssetVariantToListingAutomation({ variantIds: [id] }, session(2));
      try {
        await entered;
        await mysqlExecute("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
        proceed(); await blocker.commit();
        await assert.rejects(pending, { statusCode: 403 });
        assert.equal((await query("SELECT COUNT(*) n FROM listing_drafts WHERE internal_code=?", [`AV-${id}`]))[0].n, 0);
        assert.equal(calls.filter(item => item.name === "template" && Number(item.variant) === id).length, 0);
      } finally { transactionsHook = null; proceed(); await blocker.rollback(); blocker.release(); await active(); }
    });

    await t.test("a failed final import write rolls all business rows back and retry reuses prepared AI cache", async () => {
      const inserted = await query(`INSERT INTO asset_variants
        (batch_id,shop_id,source_product_id,source_title,variant_title,description_text,tags_json,images_json)
        VALUES ('import-atomic-review',20,200,'Уникальный атомарный ключ','Уникальный атомарный ключ','Ключ','[]','[]')`);
      const id = Number(inserted.insertId);
      const persisted = context.ensureAssetVariantListingTemplateFromPackage, copy = context.insertListingShopCopyFromPackage;
      context.ensureAssetVariantListingTemplateFromPackage = originalTemplatePersistence;
      const counts = async () => (await Promise.all(["listing_category_templates", "listing_drafts", "listing_shop_copies"].map(table =>
        query(`SELECT COUNT(*) n FROM ${table}`)))).map(rows => Number(rows[0].n));
      const before = await counts(), aiBefore = calls.filter(item => item.name === "ai").length;
      try {
        context.insertListingShopCopyFromPackage = async () => { throw new Error("Injected copy write failure"); };
        await assert.rejects(context.importAssetVariantToListingAutomation({ variantIds: [id] }, session(2)), /Injected copy write failure/);
        assert.deepEqual(await counts(), before);
        assert.equal((await query("SELECT imported_to_listing FROM asset_variants WHERE id=?", [id]))[0].imported_to_listing, 0);
        context.insertListingShopCopyFromPackage = copy;
        await context.importAssetVariantToListingAutomation({ variantIds: [id] }, session(2));
        assert.deepEqual(await counts(), before.map(n => n + 1));
        assert.equal(calls.filter(item => item.name === "ai").length - aiBefore, 1);
      } finally { context.ensureAssetVariantListingTemplateFromPackage = persisted; context.insertListingShopCopyFromPackage = copy; }
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    const root = path.resolve("uploads", "shop-variants");
    for (const target of cleanup) {
      const relative = path.relative(root, path.resolve(target));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe matrix fixture cleanup");
      await fs.rm(target, { recursive: true, force: true });
    }
    await fixture.cleanup();
  }
});

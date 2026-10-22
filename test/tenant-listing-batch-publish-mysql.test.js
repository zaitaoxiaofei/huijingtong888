import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "acorn";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { authorizeBusinessTaskSession, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const sourceUrl = new URL("../src/services/listing-automation.js", import.meta.url);
const tenantKey = id => id === 1 ? "admin" : String(id);
const session = (id, personId = 7) => ({ personId, roles: ["operations"], tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}`, role: "member" } });

test("batch publishing persists and restores enterprise operations authority in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("listing_batch");
  const originalFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("All external network is disabled in this test"); };
    const query = fixture.query;
    const readQuery = async (sql, params = []) => (await fixture.connection.query(sql, params))[0];
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const listing = await import(sourceUrl.href);
    // Use the actual fresh initializer, including tenant request uniqueness.
    // Every business write below targets only this randomly named fixture DB.
    await listing.ensureListingAutomationSchema();
    await query("INSERT INTO tenants (id,slug,name,status,subscription_status) VALUES (1,'default','Default','active','active'),(2,'enterprise-2','A','active','active'),(3,'enterprise-3','B','active','active')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations'),(8,'Other operator','operations'),(9,'Packer','packing')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,role,business_roles_json) VALUES (1,7,'owner',NULL),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations')),(2,8,'member',JSON_ARRAY('operations')),(3,8,'member',JSON_ARRAY('operations')),(2,9,'member',JSON_ARRAY('packing'))");
    await query("INSERT INTO shops (id,tenant_id,name,ozon_client_id,ozon_api_key,status) VALUES (10,NULL,'Legacy','client-10','fixture-10','active'),(11,1,'Default','client-11','fixture-11','active'),(20,2,'A','client-20','fixture-20','active'),(21,2,'A2','client-21','fixture-21','active'),(30,3,'B','client-30','fixture-30','active')");
    for (const [id, tenant] of [[100, null], [101, "admin"], [200, "2"], [201, "2"], [300, "3"]]) {
      const payload = { editable_payload: { title: `Fixture ${id}`, variants: [{ id: `variant-${id}`, offer_id: `offer-${id}`, images: ["https://fixture.invalid/image.jpg"] }] } };
      await query("INSERT INTO listing_drafts (id,tenant_id,product_name,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json,created_by_person_id) VALUES (?,?,?,'[]','[]',?,'{}','{}',7)", [id, tenant, `Fixture ${id}`, JSON.stringify(payload)]);
    }

    // Execute deployed service functions and SQL unchanged. Only scheduling,
    // pure content generation/normalization and external I/O are controlled.
    let source = readFileSync(sourceUrl, "utf8");
    const imports = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.filter(node => node.type === "ImportDeclaration");
    const importedGlobals = {};
    for (const declaration of imports) {
      const specifier = declaration.source.value;
      const module = await import(specifier.startsWith(".") ? new URL(specifier, sourceUrl).href : specifier);
      for (const binding of declaration.specifiers) importedGlobals[binding.local.name] = binding.type === "ImportDefaultSpecifier" ? module.default
        : binding.type === "ImportNamespaceSpecifier" ? module : module[binding.imported.name];
    }
    for (const declaration of [...imports].reverse()) source = source.slice(0, declaration.start) + source.slice(declaration.end);
    const calls = [], authority = [], queue = [];
    let hook = null;
    const stage = async (name, current, shop, payload) => {
      const ambient = importedGlobals.currentAiTenantSession();
      calls.push({ name, tenant: Number(current?.tenant?.id || ambient?.tenant?.id), person: Number(current?.personId || ambient?.personId), shop: Number(shop?.id || 0) });
      if (hook) await hook(name, current || ambient, shop, payload);
    };
    const buildService = () => {
      const context = vm.createContext({ ...importedGlobals, console: { info() {}, warn() {}, error() {} }, process, Buffer, URL, URLSearchParams, Date, Set, Map, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
        fetch: globalThis.fetch });
      vm.runInContext(source.replaceAll("export ", "") + "\nmysqlSchemaReady=true; publishTaskReadSchemaReady=true; listingListReadSchemaReady=true;", context);
      Object.assign(context, {
        mysqlQuery: readQuery, mysqlExecute: query,
        authorizeBusinessTaskSession: async value => {
          const fresh = await authorizeBusinessTaskSession(value, query);
          authority.push({ method: "authorize", tenant: fresh.tenant.id, person: fresh.personId }); return fresh;
        },
        restoreBusinessTaskSession: async (tenant, person) => {
          const fresh = await restoreBusinessTaskSession(tenant, person, query);
          authority.push({ method: "restore", tenant: fresh.tenant.id, person: fresh.personId }); return fresh;
        },
        ensureListingAutomationSchema: async () => {}, ensurePublishTaskReadSchema: async () => {},
        runBackgroundListingPublishBatch: (label, action) => queue.push({ kind: "batch", label, action }),
        runBackgroundListingPublish: (label, action) => queue.push({ kind: "record", label, action }),
        repairAiVariantDraftTemplateReference: async () => false,
        hydrateTemplateDictionaryDisplayValues: async value => value, hydrateTemplateSelectedDictionaryValues: async value => value,
        resolveMappedMediaInValue: async value => value,
        buildPublishTemplateFromListingDraft: async draft => ({ id: draft.id, source_product_id: 0, draft_id: draft.id, title: draft.product_name }),
        validateListingTemplatePublish: async template => ({ ok: true, errors: [], warnings: [], payload: { items: [{ offer_id: `offer-${template.id}`, name: template.title,
          price: "100", currency_code: "RUB", images: ["https://fixture.invalid/image.jpg"] }] } }),
        applyShopPublishDefaults: async payload => payload, buildListingCategoryPublishDiagnostics: async () => null,
        fetchOzonProductInfoLimit: async shop => { await stage("limit", null, shop); return {}; },
        applyShopTextVariantToPayload: async (payload, shop) => { await stage("build", null, shop, payload); return payload; },
        applyShopWatermarkedImagesToPayload: async payload => payload,
        resolveShopTailImageUrl: async () => "",
        prepareSafeShopOfferIds: async payload => payload,
        prepareOzonSellerMediaForPublishPayload: async (payload, options) => {
          await stage("seller-media", options.session, options.shop, payload);
          return { payload, changed: false, replacements: 0, jobs: [], pending: [] };
        },
        repairOzonPublishPayloadMedia: async (payload, options) => {
          await stage("repair", options.session, options.shop, payload); return { payload, changed: false };
        },
        assertPublishPayloadMediaReachable: async payload => { await stage("reachability", null, null, payload); return { ok: true }; },
        importOzonProducts: async (shop, payload) => {
          assert.equal(shop.ozon_client_id, `client-${shop.id}`);
          assert.equal(shop.api_key_hint || shop.ozon_api_key, `fixture-${shop.id}`);
          await stage("import", null, shop, payload); return { result: { task_id: `fixture-${shop.id}` } };
        },
        fetchOzonProductImportInfo: async (shop, taskId) => {
          await stage("import-info", null, shop); return { result: { items: [{ product_id: shop.id + 5000, offer_id: `fixture-${taskId}`, status: "imported" }] } };
        },
        refreshPublishRecordQuality: async () => null,
        persistListingVariantLineageForRecord: async () => {}, autoBindPublishRecordInventory: async () => null,
        enrichPublishRecordRowFromOzon: async value => value
      });
      return context;
    };
    let service = buildService();
    const restoreAuthority = async () => {
      hook = null;
      await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,role='member',business_roles_json=JSON_ARRAY('operations') WHERE person_id IN (7,8)");
      await query("UPDATE tenant_members SET role='owner',business_roles_json=NULL WHERE person_id=7 AND tenant_id=1");
      await query("UPDATE shops SET tenant_id=2,status='active' WHERE id IN (20,21)");
    };
    const clear = async () => {
      queue.length = 0; calls.length = 0; authority.length = 0;
      await restoreAuthority();
      for (const table of ["listing_publish_variant_links", "listing_publish_records", "listing_publish_task_items", "listing_publish_tasks"]) await query(`DELETE FROM ${table}`);
      service = buildService();
    };
    const scenario = (name, action) => t.test(name, async () => { await clear(); await action(); });
    const body = (id, extra = {}) => ({ draft_ids: [id === 1 ? 100 : id * 100], shop_ids: [id === 1 ? 10 : id * 10], request_id: `request-${id}`, ...extra });
    const drain = async kind => {
      for (let index = 0; index < queue.length;) {
        if (queue[index].kind !== kind) { index++; continue; }
        const item = queue.splice(index, 1)[0];
        await importedGlobals.withAiTenantSession(session(3, 8), item.action);
      }
    };
    const records = () => query("SELECT id,tenant_id,draft_id,shop_id,created_by_person_id,publish_task_id,publish_task_item_id,status,task_id FROM listing_publish_records ORDER BY id");
    const snapshotB = async () => JSON.stringify({
      tasks: await query("SELECT * FROM listing_publish_tasks WHERE tenant_id='3' ORDER BY id"),
      items: await query("SELECT * FROM listing_publish_task_items WHERE tenant_id='3' ORDER BY id"),
      records: await query("SELECT * FROM listing_publish_records WHERE tenant_id='3' ORDER BY id")
    });

    await scenario("concurrent same request IDs in A/B/default create distinct scoped tasks and preserve legacy shops", async () => {
      const result = await Promise.all([1, 2, 3].map(id => service.publishListingDraftsToOzon(body(id, {
        shop_ids: id === 1 ? [10, 11] : id === 2 ? [20, 21] : [30], request_id: "same-request-all-tenants", tenant_id: "3", created_by_person_id: 8, personId: 8
      }), session(id))));
      assert.equal(new Set(result.map(row => row.task.id)).size, 3);
      const tasks = await query("SELECT tenant_id,created_by_person_id,request_id FROM listing_publish_tasks ORDER BY tenant_id");
      assert.deepEqual(tasks.map(row => row.tenant_id).sort(), ["2", "3", "admin"]);
      assert.ok(tasks.every(row => Number(row.created_by_person_id) === 7 && row.request_id === "same-request-all-tenants"));
      const again = await service.publishListingDraftsToOzon(body(2, { request_id: "same-request-all-tenants" }), session(2, 8));
      assert.equal(again.reused, true);
      assert.equal(again.task.id, result[1].task.id);
      await drain("batch");
      const prepared = await records();
      assert.equal(prepared.length, 5);
      assert.ok(prepared.every(row => Number(row.created_by_person_id) === 7));
      for (const row of prepared) assert.equal(row.tenant_id, Number(row.shop_id) < 20 ? "admin" : Number(row.shop_id) < 30 ? "2" : "3");
      await drain("record");
      assert.equal(calls.filter(row => row.name === "import").length, 5);
      assert.ok((await records()).every(row => row.task_id && row.status === "imported"));
      assert.ok(calls.every(row => row.person === 7), JSON.stringify(calls));
      assert.ok(authority.some(row => row.method === "restore" && row.tenant === 2 && row.person === 7));
    });

    await scenario("foreign, mixed and forged enterprise inputs reject before task writes or provider calls", async () => {
      for (const tenant of [1, 2]) for (const extra of [
        { draft_ids: [300] }, { draft_ids: [tenant === 1 ? 100 : 200, 300] },
        { shop_ids: [30] }, { shop_ids: [tenant === 1 ? 10 : 20, 30] }
      ]) await assert.rejects(service.publishListingDraftsToOzon(body(tenant, { ...extra, tenant_id: "3" }), session(tenant)));
      await assert.rejects(service.publishListingDraftsToOzon(body(2), null));
      await assert.rejects(service.publishListingDraftsToOzon(body(2), { ...session(2, 9), platform_role: "super_admin" }));
      assert.equal((await query("SELECT COUNT(*) AS n FROM listing_publish_tasks"))[0].n, 0);
      assert.equal(calls.length, 0);
    });

    await scenario("task and record reads ignore forged query tenant and reject foreign IDs", async () => {
      const [a, b, legacy] = await Promise.all([2, 3, 1].map(id => service.publishListingDraftsToOzon(body(id), session(id))));
      await drain("batch");
      for (const id of [1, 2]) {
        await assert.rejects(service.listingPublishTaskDetail(b.task.id, session(id)), { status: 404 });
        const list = await service.listingPublishTasks({ tenant_id: "3", creatorId: "all" }, session(id));
        assert.deepEqual(Array.from(list.rows, row => Number(row.id)), [id === 1 ? legacy.task.id : a.task.id]);
        const foreign = (await records()).find(row => row.tenant_id === "3");
        await assert.rejects(service.listingPublishRecordDetail(foreign.id, session(id)));
        const own = await service.listingPublishRecords({ tenant_id: "3" }, session(id));
        assert.ok((own.rows || own).every(row => row.tenant_id === tenantKey(id)));
      }
      assert.equal(calls.filter(row => row.name === "import").length, 0);
    });

    const revocations = [
      ["role", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7"],
      ["membership", "UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7"],
      ["subscription", "UPDATE tenants SET subscription_status='suspended' WHERE id=2"],
      ["person", "UPDATE people SET active=0 WHERE id=7"],
      ["expiry", "UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"]
    ];
    for (const [name, sql] of revocations) await scenario(`queued batch restores persisted authority after ${name} revocation`, async () => {
      await service.publishListingDraftsToOzon(body(2), session(2));
      await query(sql);
      try { await drain("batch"); } catch (error) { assert.ok(error.status === 403 || error.statusCode === 403, String(error)); }
      assert.equal(calls.length, 0, JSON.stringify(calls));
      assert.equal((await records()).length, 0);
    });

    for (const [name, sql] of revocations.slice(0, 3)) for (const boundary of ["limit", "build", "seller-media"]) {
      await scenario(`batch stops after ${boundary} if ${name} is revoked during preparation`, async () => {
        await service.publishListingDraftsToOzon(body(2), session(2));
        let revoked = false;
        hook = async stageName => { if (!revoked && stageName === boundary) { revoked = true; await query(sql); } };
        await drain("batch");
        assert.equal(revoked, true);
        assert.equal(calls.filter(row => row.name === "import").length, 0);
        assert.equal(queue.filter(row => row.kind === "record").length, 0, "Revoked preparation must not enqueue a submit worker");
        const after = calls.slice(calls.findIndex(row => row.name === boundary) + 1);
        assert.equal(after.length, 0, JSON.stringify(calls));
      });
    }

    await scenario("fresh worker context restores persisted creator and tenant instead of ambient or supplied overrides", async () => {
      await service.publishListingDraftsToOzon(body(2), session(2));
      await drain("batch");
      const [record] = await records();
      queue.length = 0;
      const restarted = buildService();
      await importedGlobals.withAiTenantSession(session(3, 8), () => restarted.submitPreparedListingPublishRecord({ recordId: record.id, shop: { id: 30 }, shopPayload: { items: [{ offer_id: "forged" }] } }));
      const imports = calls.filter(row => row.name === "import");
      assert.deepEqual(imports.map(row => [row.tenant, row.person, row.shop]), [[2, 7, 20]]);
      assert.equal((await records())[0].created_by_person_id, 7);
    });

    for (const [name, sql] of revocations.slice(0, 3)) await scenario(`record worker rejects ${name} revocation after preparation`, async () => {
      await service.publishListingDraftsToOzon(body(2), session(2)); await drain("batch");
      const before = calls.length;
      await query(sql);
      try { await drain("record"); } catch (error) { assert.ok(error.status === 403 || error.statusCode === 403, String(error)); }
      assert.equal(calls.length, before, JSON.stringify(calls));
      assert.ok((await records()).every(row => !row.task_id));
    });

    await scenario("revocation during final media reachability blocks external import", async () => {
      await service.publishListingDraftsToOzon(body(2), session(2)); await drain("batch");
      hook = async name => { if (name === "reachability") await query(revocations[0][1]); };
      await drain("record");
      assert.equal(calls.filter(row => row.name === "import").length, 0);
      assert.ok((await records()).every(row => !row.task_id));
    });

    for (const [name, sql] of revocations.slice(0, 3)) for (const boundary of ["repair", "seller-media", "import"]) {
      await scenario(`record worker starts no next provider after ${name} revocation during ${boundary}`, async () => {
        await service.publishListingDraftsToOzon(body(2), session(2)); await drain("batch");
        const before = calls.length;
        let revoked = false;
        hook = async stageName => { if (!revoked && stageName === boundary) { revoked = true; await query(sql); } };
        await drain("record");
        assert.equal(revoked, true);
        const workerCalls = calls.slice(before);
        const after = workerCalls.slice(workerCalls.findIndex(row => row.name === boundary) + 1);
        assert.equal(after.length, 0, JSON.stringify(workerCalls));
        assert.equal(calls.filter(row => row.name === "import").length, boundary === "import" ? 1 : 0);
        if (boundary === "import") {
          const [stored] = await query("SELECT id,task_id,response_json FROM listing_publish_records WHERE tenant_id='2'");
          assert.equal(stored.task_id, "fixture-20", "A confirmed Ozon mutation receipt must survive revocation");
          assert.ok(JSON.parse(stored.response_json), "The external receipt must be durable to prevent a duplicate submit");
          await restoreAuthority();
          await buildService().submitPreparedListingPublishRecord({ recordId: stored.id });
          assert.equal(calls.filter(row => row.name === "import").length, 1, "Recovering a saved receipt must never repeat the Ozon mutation");
        }
      });
    }

    await scenario("poisoned task draft/shop/record references never submit foreign data or change B", async () => {
      const a = await service.publishListingDraftsToOzon(body(2), session(2));
      await service.publishListingDraftsToOzon(body(3), session(3));
      const bBatch = queue.find(row => row.kind === "batch" && !row.label.includes(String(a.task.id)));
      queue.splice(queue.indexOf(bBatch), 1); await bBatch.action();
      const [bRecord] = (await records()).filter(row => row.tenant_id === "3");
      const before = await snapshotB();
      await query("UPDATE listing_publish_task_items SET record_id=?,draft_id=300,shop_id=30 WHERE publish_task_id=?", [bRecord.id, a.task.id]);
      queue.splice(0, queue.length, ...queue.filter(row => row.kind === "batch"));
      await drain("batch");
      assert.equal(await snapshotB(), before);
      assert.equal((await records()).filter(row => row.tenant_id === "2").length, 0);
      assert.equal(calls.filter(row => row.name === "import").length, 0);
    });

    await scenario("startup interruption does not follow poisoned record references into B", async () => {
      const a = await service.publishListingDraftsToOzon(body(2), session(2));
      const b = await service.publishListingDraftsToOzon(body(3), session(3));
      const bBatch = queue.find(row => row.kind === "batch" && row.label.includes(String(b.task.id)));
      queue.splice(queue.indexOf(bBatch), 1); await bBatch.action();
      const [bRecord] = (await records()).filter(row => row.tenant_id === "3");
      const before = await snapshotB();
      await query("UPDATE listing_publish_task_items SET record_id=?,status='processing',updated_at=DATE_SUB(NOW(),INTERVAL 40 MINUTE) WHERE publish_task_id=?", [bRecord.id, a.task.id]);
      queue.length = 0;
      await buildService().recoverInterruptedListingPublishTasksOnStartup({ minAgeMinutes: 1 });
      assert.equal(await snapshotB(), before);
      assert.equal(calls.filter(row => row.name === "import").length, 0);
    });

    await scenario("restart marks only unsubmitted stale items interrupted and never republishes completed items", async () => {
      const a = await service.publishListingDraftsToOzon(body(2), session(2));
      await service.publishListingDraftsToOzon(body(3), session(3));
      await drain("batch"); await drain("record");
      const before = await snapshotB(), submitted = calls.filter(row => row.name === "import").length;
      await query("UPDATE listing_publish_records SET task_id='',response_json=NULL,status='processing',updated_at=DATE_SUB(NOW(),INTERVAL 40 MINUTE) WHERE tenant_id='2'");
      await query("UPDATE listing_publish_task_items SET status='processing',updated_at=DATE_SUB(NOW(),INTERVAL 40 MINUTE) WHERE publish_task_id=?", [a.task.id]);
      const result = await buildService().recoverInterruptedListingPublishTasksOnStartup({ minAgeMinutes: 1 });
      assert.equal(result.interruptedItems, 1);
      const [item] = await query("SELECT status,error_json FROM listing_publish_task_items WHERE publish_task_id=?", [a.task.id]);
      assert.ok(["interrupted", "failed"].includes(item.status));
      assert.match(item.error_json, /后台服务重启/);
      assert.equal(await snapshotB(), before);
      assert.equal(calls.filter(row => row.name === "import").length, submitted);
      assert.equal(queue.length, 0);
    });

    await scenario("unreviewed task retry remains closed for ordinary A/default operations", async () => {
      for (const id of [1, 2]) assert.equal(tenantIsolationDecision(session(id), ["api", "listing", "publish-tasks", "1", "retry"], "POST").allowed, false);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});

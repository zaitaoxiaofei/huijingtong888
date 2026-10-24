import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import mysql from "mysql2/promise";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";
import { TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "../src/services/ai-tenant-schema.js";
import { shanghaiDateKey } from "../src/shanghai-time.js";
import { checkAiCreditProviderBoundary } from "../src/services/ai-credit-provider-context.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
function functions(file, names) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const nodes = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
  return names.map(name => {
    const node = nodes.find(node => node.type === "FunctionDeclaration" && node.id.name === name);
    assert.ok(node, name); return source.slice(node.start, node.end);
  }).join("\n");
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });

test("legacy retry uses real owned SQL, fresh attempt guards and durable receipts", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_retry_test_${crypto.randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath, user: "root" });
  let created = false, pool;
  try {
    const [[server]] = await admin.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(server.disabled), 1);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ socketPath, user: "root", database, connectionLimit: 6 });
    const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL, feature_flags_json JSON NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))",
      "CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT NULL, name VARCHAR(80), status VARCHAR(32) DEFAULT 'active', ozon_client_id VARCHAR(80), ozon_api_key VARCHAR(80), api_key_hint VARCHAR(80), watermark_path TEXT, watermark_name TEXT, watermark_position TEXT, watermark_x_percent INT, watermark_y_percent INT, watermark_scale_percent INT, watermark_opacity_percent INT)",
      "CREATE TABLE listing_publish_records (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80), shop_id BIGINT NOT NULL, created_by_person_id BIGINT DEFAULT 7, offer_id VARCHAR(128) DEFAULT '', status VARCHAR(64), request_json LONGTEXT, response_json LONGTEXT, template_snapshot_json LONGTEXT, task_id VARCHAR(128) DEFAULT '', error_json LONGTEXT, ozon_product_id VARCHAR(128), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, published_at TIMESTAMP NULL)",
      "CREATE TABLE listing_publish_variant_links (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id VARCHAR(80), record_id BIGINT, ozon_status VARCHAR(64))"
    ]) await query(sql);
    await query("INSERT INTO tenants (id,slug) VALUES (1,'default'),(2,'enterprise-2'),(3,'enterprise-3')");
    await query("UPDATE tenants SET feature_flags_json=JSON_OBJECT('ai_internal_mode_reviewed',JSON_EXTRACT('true','$')) WHERE id IN (2,3)");
    await query("INSERT INTO people (id) VALUES (7)");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name,ozon_client_id,ozon_api_key) VALUES (10,NULL,'Legacy','client-10','key-10'),(20,2,'A','client-20','key-20'),(30,3,'B','client-30','key-30')");
    let hooks = {}, calls = [], bindings = 0;
    const context = vm.createContext({ Buffer, crypto, AbortController, setTimeout, clearTimeout,
      console: { warn() {}, info() {} }, listingTenantLookup, assertBusinessTaskPermission,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      withAiTenantSession: async (_session, operation) => operation(),
      needsAiTenantSession: () => false, ensureListingAutomationSchema: async () => {},
      listingPublishExecutionGuards: new WeakMap(), normalizePublishRecordRow: value => value,
      normalizeRetryPublishPayload: value => value, normalizeArray: value => Array.isArray(value) ? value : [],
      parseJson: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } }, sameTimestamp: () => true,
      applyShopPublishDefaults: async value => value, repairOzonPublishPayloadMedia: async payload => ({ payload }),
      prepareOzonSellerMediaForPublishPayload: async payload => ({ payload, changed: false, jobs: [], pending: [] }),
      assertPublishPayloadHasOnlyPublicMedia() {}, assertPublishPayloadMediaReachable: async () => {},
      mysqlQuery: async (sql, params) => { await hooks.beforeQuery?.(sql, params); return query(sql, params); },
      mysqlExecute: async (sql, params) => { await hooks.beforeQuery?.(sql, params); return query(sql, params); },
      normalizeOzonImportInfoErrors: () => ({ has_errors: false, items: [] }), hasBlockingOzonItemError: () => false,
      extractOzonImportInfoFailure: () => "", extractImportedProductRefs: () => ({ productIds: [], offerIds: [] }),
      persistListingVariantLineageForRecord: async (_id, _tenant, options) => { await options.assertAccess(); bindings++; },
      autoBindPublishRecordInventory: async (_id, _tenant, options) => { await options.assertAccess(); bindings++; },
      refreshPublishRecordQuality: async (_id, _tenant, options) => { await options.assertAccess(); },
      buildOzonPublishErrorPayload: error => ({ message: error.message, code: error.code }),
      OZON_API_BASE: "https://fixture.invalid", OZON_REQUEST_RETRIES: 2, OZON_REQUEST_TIMEOUT_MS: 1000,
      FBS_LIST_PATH: "/fixture-fbs", FBP_LIST_PATH: "/fixture-fbp", sleep: async () => hooks.backoff?.(),
      fetch: async (url, options) => {
        assert.ok(url.startsWith("https://fixture.invalid/"), "Real Ozon calls are forbidden");
        const path = new URL(url).pathname;
        assert.ok(["/v3/product/import", "/v1/product/import/info"].includes(path));
        const call = { path, payload: JSON.parse(options.body), client: options.headers["Client-Id"] };
        calls.push(call);
        const result = await hooks.network?.(call);
        const data = result?.data || (path === "/v3/product/import" ? { result: { task_id: String(9000 + calls.length) } }
          : { result: { total: 1, items: [{ status: "imported" }] } });
        const status = result?.status || 200;
        return { ok: status < 400, status, text: async () => JSON.stringify(data), headers: { get: () => null } };
      }
    });
    vm.runInContext(functions("../src/services/listing-automation.js", ["listingTenantId", "listingStoredShopTenantPredicate", "row", "run", "all",
      "listingPublishRecordNotFoundError", "importInfoStatus", "updatePublishRecordAfterSubmit", "retryListingPublishRecord", "submitPreparedListingPublishRecord"]), context);
    vm.runInContext(functions("../src/ozonClient.js", ["importOzonProducts", "fetchOzonProductImportInfo", "ozonRequest", "ozonRequestOnce",
      "isRetryableOzonError", "networkErrorMessage", "retryAfterMs", "ozonApiKey", "hasRealOzonCredentials"]), context);
    const reset = async () => {
      hooks = {}; calls = []; bindings = 0;
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
      await query("UPDATE tenants SET subscription_status='active',subscription_expires_at=NULL");
      await query("UPDATE shops SET status='active',tenant_id=CASE id WHEN 10 THEN NULL WHEN 20 THEN 2 ELSE 3 END");
    };
    const create = async (tenant = 2, shop = 20, overrides = {}) => {
      const fields = { tenant_id: tenant === 1 ? "admin" : String(tenant), shop_id: shop, status: "failed",
        request_json: JSON.stringify({ items: [{ offer_id: "original" }] }), ...overrides };
      const result = await query(`INSERT INTO listing_publish_records (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(() => "?").join(",")})`, Object.values(fields));
      return Number(result.insertId);
    };
    const record = async id => (await query("SELECT * FROM listing_publish_records WHERE id=?", [id]))[0];
    const submits = () => calls.filter(call => call.path === "/v3/product/import");
    const retry = (id, tenant = 2, body = {}) => context.retryListingPublishRecord(id, body, session(tenant));

    await t.test("A/B/default NULL shop retries ignore body identity and preserve original credentials", async () => {
      await reset();
      for (const [tenant, shop] of [[1, 10], [2, 20], [3, 30]]) {
        const id = await create(tenant, shop);
        const result = await retry(id, tenant, { tenant_id: "other", personId: 999, shop_id: 30 });
        assert.equal(result.status, "imported");
        assert.equal(result.tenant_id, tenant === 1 ? "admin" : String(tenant));
        assert.equal(submits().at(-1).client, `client-${shop}`);
      }
      const foreign = await create(3, 30), poison = await create(2, 30);
      await assert.rejects(retry(foreign), { status: 404 });
      await assert.rejects(retry(poison), { status: 404 });
      assert.equal(submits().length, 3);
    });

    for (const [name, revoke] of [
      ["operations", () => query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2")],
      ["membership", () => query("UPDATE tenant_members SET active=0 WHERE tenant_id=2")],
      ["subscription", () => query("UPDATE tenants SET subscription_expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id=2")]
    ]) await t.test(`${name} revoked during 503 backoff blocks the second network attempt`, async () => {
      await reset(); const id = await create();
      hooks.network = async () => ({ status: 503, data: { message: "Fixture unavailable" } });
      hooks.backoff = revoke;
      await assert.rejects(retry(id), { statusCode: 403 });
      assert.equal(submits().length, 1);
      assert.equal(bindings, 0);
      assert.equal((await record(id)).status, "resubmitting");
      assert.equal((await record(id)).task_id, "");
      assert.match((await record(id)).error_json, /不要重复上架/);
      await reset();
      await assert.rejects(retry(id), { statusCode: 409 });
      assert.equal(submits().length, 0);
    });

    await t.test("moving the original shop during backoff blocks refreshed credentials", async () => {
      await reset(); const id = await create();
      hooks.network = async () => ({ status: 503 });
      hooks.backoff = () => query("UPDATE shops SET tenant_id=3 WHERE id=20");
      await assert.rejects(retry(id), { status: 404 });
      assert.equal(submits().length, 1);
      assert.equal((await record(id)).status, "resubmitting");
    });

    await t.test("in-flight revocation still saves the receipt before stopping info and binding", async () => {
      await reset(); const id = await create();
      hooks.network = async call => {
        assert.equal(call.path, "/v3/product/import");
        await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2");
        return { data: { result: { task_id: "2001" } } };
      };
      await assert.rejects(retry(id), { statusCode: 403 });
      assert.equal((await record(id)).task_id, "2001");
      assert.equal((await record(id)).status, "submitted");
      assert.equal(calls.length, 1);
      assert.equal(bindings, 0);
      await reset();
      assert.equal((await retry(id)).status, "imported");
      assert.equal(submits().length, 0, "A restarted request must reconcile its receipt instead of resubmitting");
    });

    await t.test("a hanging import-info request cannot hide an already durable receipt", async () => {
      await reset(); const id = await create(), entered = deferred(), release = deferred();
      hooks.network = async call => {
        if (call.path.endsWith("/info")) { entered.resolve(); await release.promise; }
      };
      const request = retry(id);
      await entered.promise;
      assert.ok((await record(id)).task_id);
      assert.equal((await record(id)).status, "submitted");
      assert.equal(bindings, 0);
      release.resolve();
      assert.equal((await request).status, "imported");
    });

    for (const persistent of [false, true]) await t.test(`${persistent ? "persistent" : "transient"} receipt write failure never makes a submitted operation retryable`, async () => {
      await reset(); const id = await create(); let failures = 0;
      hooks.beforeQuery = sql => {
        if (sql.includes("SET task_id = ?, response_json = ?, status = ?") && (persistent || failures === 0)) {
          failures++; throw new Error("Fixture receipt write failure");
        }
      };
      const result = await retry(id);
      assert.equal(submits().length, 1);
      assert.equal(result.status, persistent ? "resubmitting" : "submitted");
      assert.equal(Boolean(result.task_id), !persistent);
      assert.equal(bindings, 0);
      await reset();
      if (persistent) await assert.rejects(retry(id), { statusCode: 409 });
      else assert.equal((await retry(id)).status, "imported");
      assert.equal(submits().length, 0);
    });

    await t.test("a missing task ID or exhausted 503 response remains unknown with a recovery message", async () => {
      for (const missingId of [true, false]) {
        await reset(); const id = await create();
        hooks.network = async () => missingId ? { data: { result: {} } } : { status: 503 };
        const result = await retry(id);
        assert.equal(result.task_id, "");
        assert.equal(result.status, "resubmitting");
        assert.ok(result.response_json, "The durable attempt marker must remain available after a crash");
        assert.match(result.error_json, /RECONCILIATION_REQUIRED|RESULT_UNKNOWN/);
        const before = calls.length;
        await assert.rejects(retry(id), { statusCode: 409 });
        assert.equal(calls.length, before);
      }
    });

    await t.test("an officially confirmed failed receipt permits one corrected new submission", async () => {
      await reset();
      const id = await create(2, 20, { task_id: "1001", response_json: JSON.stringify({ submit: { result: { task_id: "1001" } } }) });
      hooks.network = async call => call.payload.task_id === 1001
        ? { data: { result: { total: 1, items: [{ status: "failed" }] } } } : undefined;
      const result = await retry(id, 2, { payload: { items: [{ offer_id: "corrected" }] } });
      assert.equal(result.status, "imported");
      assert.notEqual(result.task_id, "1001");
      assert.equal(submits().length, 1);
      assert.equal(submits()[0].payload.items[0].offer_id, "corrected");
    });

    await t.test("concurrent retry claims submit at most once", async () => {
      await reset(); const id = await create();
      const results = await Promise.allSettled([retry(id), retry(id)]);
      assert.ok(results.some(result => result.status === "fulfilled"));
      assert.ok(results.every(result => result.status === "fulfilled" || [409].includes(result.reason.statusCode || result.reason.status)));
      assert.equal(submits().length, 1);
    });

    await t.test("a stale failed-task reconciliation cannot overwrite a newer claimed receipt", async () => {
      await reset();
      const id = await create(2, 20, { task_id: "1001", response_json: JSON.stringify({ submit: { result: { task_id: "1001" } } }) });
      const firstEntered = deferred(), bothEntered = deferred(), releaseOld = deferred(); let oldReads = 0;
      hooks.network = async call => {
        if (call.payload.task_id === 1001) {
          if (++oldReads === 1) { firstEntered.resolve(); await bothEntered.promise; }
          else { bothEntered.resolve(); await releaseOld.promise; }
          return { data: { result: { total: 1, items: [{ status: "failed" }] } } };
        }
      };
      const first = retry(id);
      await firstEntered.promise;
      const second = retry(id);
      const secondResult = second.then(value => ({ value }), error => ({ error }));
      assert.equal((await first).status, "imported");
      const confirmedTask = (await record(id)).task_id;
      releaseOld.resolve();
      assert.equal((await secondResult).error?.statusCode, 409);
      assert.equal((await record(id)).task_id, confirmedTask);
      assert.equal((await record(id)).status, "imported");
      assert.equal(submits().length, 1);
    });

    for (const mode of ["legacy", "prepared"]) await t.test(`${mode} late task1 finalization and catch cannot overwrite task2 or its variant status`, async () => {
      await reset(); const id = await create(2, 20, { status: mode === "prepared" ? "processing" : "failed" });
      await query("INSERT INTO listing_publish_variant_links (tenant_id,record_id,ozon_status) VALUES ('2',?,'original')", [id]);
      const entered = deferred(), release = deferred(); let oldReads = 0, imported = 0;
      hooks.network = async call => {
        if (call.path === "/v3/product/import") return { data: { result: { task_id: ++imported === 1 ? 1001 : 2002 } } };
        if (call.payload.task_id === 1001) {
          if (++oldReads === 1) { entered.resolve(); await release.promise; }
          return { data: { result: { total: 1, items: [{ status: "failed" }] } } };
        }
      };
      const first = mode === "legacy" ? retry(id) : context.submitPreparedListingPublishRecord({ recordId: id });
      await entered.promise;
      assert.equal((await retry(id)).task_id, "2002");
      const winner = await record(id), beforeBindings = bindings;
      release.resolve();
      await first;
      const after = await record(id);
      assert.equal(after.task_id, "2002");
      assert.equal(after.status, "imported");
      assert.equal(after.response_json, winner.response_json);
      assert.equal(after.error_json, winner.error_json, "The old catch must not journal an error onto task2");
      assert.equal(bindings, beforeBindings, "The old result must stop before lineage/inventory writes");
      const [link] = await query("SELECT ozon_status FROM listing_publish_variant_links WHERE record_id=?", [id]);
      assert.equal(link.ozon_status, "imported");
      assert.equal(submits().length, 2);
    });

    await t.test("variant status SQL atomically requires the same finalized receipt", async () => {
      await reset();
      const receipt = JSON.stringify({ submit: { result: { task_id: 1001 } } });
      const id = await create(2, 20, { status: "submitted", task_id: "1001", response_json: receipt });
      await query("INSERT INTO listing_publish_variant_links (tenant_id,record_id,ozon_status) VALUES ('2',?,'original')", [id]);
      let switched = false;
      hooks.beforeQuery = async sql => {
        if (sql.startsWith("UPDATE listing_publish_variant_links") && !switched) {
          switched = true;
          await query("UPDATE listing_publish_records SET task_id='2002',response_json='{}',status='processing' WHERE id=?", [id]);
          await query("UPDATE listing_publish_variant_links SET ozon_status='processing' WHERE record_id=?", [id]);
        }
      };
      await assert.rejects(context.updatePublishRecordAfterSubmit(id, { taskId: "1001", response: { result: { task_id: 1001 } },
        importInfo: { result: { total: 1, items: [{ status: "failed" }] } }, status: "failed", tenantId: "2",
        assertAccess: async () => {}, expectedReceipt: { shopId: 20, taskId: "1001", responseJson: receipt } }), { statusCode: 409 });
      assert.equal(switched, true);
      const [link] = await query("SELECT ozon_status FROM listing_publish_variant_links WHERE record_id=?", [id]);
      assert.equal(link.ozon_status, "processing");
      assert.equal((await record(id)).task_id, "2002");
      assert.equal(bindings, 0);
    });

    for (const persistent of [false, true]) await t.test(`prepared ${persistent ? "persistent" : "transient"} receipt failure cannot trigger startup resubmission`, async () => {
      await reset(); const id = await create(2, 20, { status: "processing" }); let failures = 0;
      hooks.beforeQuery = sql => {
        if (sql.includes("SET task_id = ?, response_json = ?, status = ?") && (persistent || failures === 0)) {
          failures++; throw new Error("Fixture prepared receipt write failure");
        }
      };
      const result = await context.submitPreparedListingPublishRecord({ recordId: id });
      assert.equal(result.ok, false);
      assert.equal(submits().length, 1);
      assert.equal((await record(id)).status, persistent ? "resubmitting" : "submitted");
      assert.equal(Boolean((await record(id)).task_id), !persistent);
      assert.match((await record(id)).error_json, /结果待核对/);
      assert.equal(bindings, 0);
      await reset();
      assert.equal((await context.submitPreparedListingPublishRecord({ recordId: id })).reused, true);
      if (persistent) await assert.rejects(retry(id), { statusCode: 409 });
      else assert.equal((await retry(id)).status, "imported");
      assert.equal(submits().length, 0);
    });

    await t.test("prepared unknown network result keeps a durable marker outside automatic processing recovery", async () => {
      await reset(); const id = await create(2, 20, { status: "processing" });
      hooks.network = async () => ({ status: 503 });
      const result = await context.submitPreparedListingPublishRecord({ recordId: id });
      assert.equal(result.ok, false);
      assert.equal(result.task_id, "");
      assert.equal((await record(id)).status, "resubmitting");
      assert.equal(JSON.parse((await record(id)).response_json).submission.state, "pending");
      assert.match(result.fix_tip, /核对原店铺/);
      const count = submits().length;
      assert.equal((await context.submitPreparedListingPublishRecord({ recordId: id })).reused, true);
      assert.equal(submits().length, count);
    });

    for (const boundary of ["membership", "shop"]) await t.test(`prepared backoff rechecks ${boundary} before every network attempt`, async () => {
      await reset(); const id = await create(2, 20, { status: "processing" });
      hooks.network = async () => ({ status: 503 });
      hooks.backoff = () => boundary === "membership" ? query("UPDATE tenant_members SET active=0 WHERE tenant_id=2")
        : query("UPDATE shops SET status='paused' WHERE id=20");
      const result = await context.submitPreparedListingPublishRecord({ recordId: id });
      assert.equal(result.ok, false);
      assert.equal(submits().length, 1);
      assert.equal((await record(id)).status, "resubmitting");
      assert.equal(bindings, 0);
    });

    await t.test("prepared response without a task ID retains its own unknown-attempt marker and recovery hint", async () => {
      await reset(); const id = await create(2, 20, { status: "processing" });
      hooks.network = async () => ({ data: { result: {} } });
      const result = await context.submitPreparedListingPublishRecord({ recordId: id });
      const stored = await record(id);
      assert.equal(result.ok, false);
      assert.equal(stored.task_id, "");
      assert.equal(stored.status, "resubmitting");
      assert.equal(JSON.parse(stored.response_json).submission.state, "pending");
      assert.match(stored.error_json, /结果待核对/);
      assert.equal(submits().length, 1);
    });

    for (const scenario of ["quota", "revoked", "success"]) await t.test(`vision actual SQL ${scenario}: the retry retains A's identity and charges each attempt`, async () => {
      await reset();
      await query(TENANT_AI_LIMITS_SCHEMA); await query(TENANT_AI_USAGE_SCHEMA);
      await query("DELETE FROM tenant_ai_usage");
      await query("INSERT INTO tenant_ai_limits VALUES (2,?), (3,0) ON DUPLICATE KEY UPDATE monthly_request_limit=VALUES(monthly_request_limit)", [scenario === "quota" ? 1 : 2]);
      let requests = 0;
      const vision = vm.createContext({ AsyncLocalStorage, AbortController, setTimeout, clearTimeout, shanghaiDateKey,
        businessTaskTenantKey, assertBusinessTaskPermission, TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA,
        authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query), mysqlExecute: query, mysqlQuery: query, checkAiCreditProviderBoundary,
        withMysqlTransaction: async operation => {
          const connection = await pool.getConnection();
          try { await connection.beginTransaction(); const value = await operation(connection); await connection.commit(); return value; }
          catch (error) { await connection.rollback(); throw error; }
          finally { connection.release(); }
        },
        normalizeVisionMessages: value => value,
        resolveRuntimeConfig: async () => ({ provider: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture", textModel: "fixture" }),
        delay: async () => { if (scenario === "revoked") await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2"); },
        fetch: async url => {
          assert.equal(url, "https://fixture.invalid/chat/completions");
          const [usage] = await query("SELECT request_count FROM tenant_ai_usage WHERE tenant_id=2");
          assert.equal(Number(usage.request_count), ++requests);
          assert.equal((await query("SELECT * FROM tenant_ai_usage WHERE tenant_id=3")).length, 0);
          return { ok: requests > 1, status: requests === 1 ? 503 : 200,
            json: async () => requests === 1 ? { error: { message: "Fixture retry" } } : { choices: [{ message: { content: "Result" } }] } };
        }
      });
      vm.runInContext("const context = new AsyncLocalStorage(); let usageSchema;\n" + functions("../src/services/ai-tenant-context.js",
        ["currentAiTenantSession", "withAiTenantSession", "assertCurrentAiTenantPermission", "reserveTenantAiRequest"]), vision);
      vision.assertAiCreditProviderBoundary = async kind => checkAiCreditProviderBoundary(await vision.assertCurrentAiTenantPermission(), kind, query);
      vm.runInContext(functions("../src/services/ai-provider-settings.js", ["visionWithAiProvider", "visionProviderError", "callOpenAiCompatibleChat",
        "finiteNumber", "statusError", "extractAiTextContent", "normalizeAiContentValue"]), vision);
      const request = vision.withAiTenantSession(session(2), () => vision.visionWithAiProvider({ tenant_id: 3, personId: 999,
        messages: [{ role: "user", content: "Fixture" }] }));
      if (scenario === "success") assert.equal((await request).content, "Result");
      else await assert.rejects(request, scenario === "quota" ? { statusCode: 409, code: "TENANT_AI_QUOTA_EXCEEDED" } : { statusCode: 403, code: "TENANT_TASK_ACCESS_DENIED" });
      assert.equal(requests, scenario === "success" ? 2 : 1);
      const [usage] = await query("SELECT request_count,text_count,image_count FROM tenant_ai_usage WHERE tenant_id=2");
      assert.equal(Number(usage.request_count), requests);
      assert.equal(Number(usage.text_count), requests);
      assert.equal(Number(usage.image_count), 0);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

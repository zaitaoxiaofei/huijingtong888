import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const cleanupKey = id => `ozon.actions.cleanup:${id}`;

test("promotion cleanup recovers current-enterprise authorization and preserves execution failures", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET",
  timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture("action_cleanup");
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    const tenantColumns = await query("SHOW COLUMNS FROM tenants");
    if (!tenantColumns.some(column => column.Field === "subscription_status")) await query("ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'");
    if (!tenantColumns.some(column => column.Field === "subscription_expires_at")) await query("ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL");
    const shopColumns = await query("SHOW COLUMNS FROM shops");
    if (!shopColumns.some(column => column.Field === "ozon_api_key")) await query("ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL");
    await query("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (10,NULL,'Legacy','client-10','fixture-key'),(11,1,'Default','client-11','fixture-key'),(20,2,'A','client-20','fixture-key'),(21,2,'A disabled','client-21','fixture-key'),(22,2,'A new','client-22','fixture-key'),(30,3,'B','client-30','fixture-key')");
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(new URL(url).origin, "https://api-seller.ozon.ru");
      const request = { endpoint: new URL(url).pathname, client: options.headers?.["Client-Id"], body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      const data = respond ? await respond(request) : { result: [] };
      const { __status: status = 200, ...body } = data;
      return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
    };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const actions = await import("../src/services/ozon-actions.js");
    const { withAiTenantSession } = await import("../src/services/ai-tenant-context.js");
    const listConfigs = id => withAiTenantSession(session(id), () => actions.listOzonActionCleanupConfigsMysql());
    // Create the settings table through the ordinary scoped read path.
    await listConfigs(2);
    const setConfig = (id, config) => query("INSERT INTO system_settings (`key`,value_json) VALUES (?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)", [cleanupKey(id), JSON.stringify(config)]);
    const storedConfig = async id => {
      const rows = await query("SELECT value_json FROM system_settings WHERE `key`=?", [cleanupKey(id)]);
      return rows.length ? JSON.parse(rows[0].value_json) : null;
    };
    const reset = async () => {
      await query("DELETE FROM system_settings WHERE `key` LIKE 'ozon.actions.cleanup:%'");
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
      requests.length = 0;
      respond = null;
    };

    await t.test("new shops start disabled and legacy enabled shops expose missing execution identity", async () => {
      await reset();
      await setConfig(20, { enabled: true });
      const configs = await listConfigs(2);
      assert.deepEqual(configs.map(row => row.storeId), ["20", "21", "22"]);
      const legacy = configs.find(row => row.storeId === "20");
      assert.equal(legacy.enabled, true);
      assert.equal(legacy.taskEnabled, false);
      assert.equal(legacy.authorizationReady, false);
      assert.ok(legacy.authorizationError);
      const fresh = await actions.getOzonActionCleanupConfigMysql({ storeId: 22 }, session(2));
      assert.equal(fresh.enabled, false);
      assert.equal(fresh.taskEnabled, false);
      assert.equal(requests.length, 0);
      assert.equal(await storedConfig(22), null, "reading status must not fabricate a saved operator");
    });

    await t.test("all-shop recovery binds only enabled shops in the current enterprise to the real caller", async () => {
      await reset();
      for (const id of [10, 11, 20, 30]) await setConfig(id, { enabled: true });
      await setConfig(21, { enabled: false });
      const result = await actions.runOzonActionCleanupForTenantMysql({ tenant_key: "3", created_by_person_id: 99 }, session(2), { waitForCompletion: true });
      assert.equal(result.success, true);
      assert.equal(result.status, "completed");
      assert.equal(result.failed, 0);
      assert.deepEqual(result.results.map(row => String(row.storeId)), ["20"]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].client, "client-20");
      const saved = await storedConfig(20);
      assert.equal(saved.tenant_key, "2");
      assert.equal(saved.created_by_person_id, 7);
      assert.equal(saved.enabled, true);
      assert.ok(saved.lastRunAt);
      for (const id of [10, 11, 30]) assert.deepEqual(await storedConfig(id), { enabled: true });
      assert.deepEqual(await storedConfig(21), { enabled: false });
      assert.equal(await storedConfig(22), null);
    });

    await t.test("all-shop recovery returns promptly and authorizes every shop before a slow supplier responds", async () => {
      await reset();
      await setConfig(20, { enabled: true });
      await setConfig(21, { enabled: true });
      let release;
      let started;
      let timer;
      const held = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      respond = async request => {
        assert.equal(request.endpoint, "/v1/actions");
        started();
        await held;
        return { result: [] };
      };
      const waiting = actions.runOzonActionCleanupForTenantMysql({}, session(2));
      try {
        const accepted = await Promise.race([
          waiting,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The all-shop request waited for Ozon instead of returning its running status")), 1500); })
        ]);
        clearTimeout(timer);
        assert.equal(accepted.status, "running");
        assert.equal(accepted.success, true);
        await Promise.race([
          entered,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The accepted all-shop scan never started")), 1500); })
        ]);
        clearTimeout(timer);
        for (const id of [20, 21]) {
          const config = await storedConfig(id);
          assert.equal(config.tenant_key, "2");
          assert.equal(config.created_by_person_id, 7);
        }
      } finally {
        clearTimeout(timer);
        release();
        await waiting;
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const last = await storedConfig(21);
        if (last?.lastRunAt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok((await storedConfig(20)).lastRunAt);
      assert.ok((await storedConfig(21)).lastRunAt);
      assert.deepEqual(requests.map(row => row.client), ["client-20", "client-21"]);
    });

    await t.test("revoked current members cannot bind configurations or make external requests", async () => {
      await reset();
      await setConfig(20, { enabled: true });
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(actions.runOzonActionCleanupForTenantMysql({}, session(2)), error => Number(error.statusCode || error.status) === 403);
      assert.deepEqual(await storedConfig(20), { enabled: true });
      assert.equal(requests.length, 0);
    });

    await t.test("malformed product responses fail visibly and never submit deletion", async () => {
      await reset();
      respond = async request => request.endpoint === "/v1/actions" ? { result: [{ id: 123, title: "Promotion" }] } : {};
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.equal(result.immediateRun.success, false);
      assert.ok(result.config.lastError);
      assert.equal(result.config.lastResult.removedCount, 0);
      assert.ok(!result.config.lastResult.actionSummaries.some(row => row.verified));
      assert.ok(!requests.some(row => /products\/(?:deactivate|delete)$/.test(row.endpoint)));
    });

    await t.test("a malformed promotion catalog cannot be reported as an empty successful scan", async () => {
      await reset();
      respond = async () => ({});
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.ok(result.config.lastError);
      assert.equal(result.config.lastResult.removedCount, 0);
      assert.ok(!requests.some(row => /products\/(?:deactivate|delete)$/.test(row.endpoint)));
    });

    const unifiedPriceRefusal = () => ({ __status: 400, message: "the method is blocked due to unified price logic. To resume management via promotions, please switch to the new methods" });
    const money = amount => ({ amount, currency: "RUB" });
    const automaticProduct = (id, fields = {}) => ({ id, add_mode: "AUTO", max_action_price: money("50.00"), action_price: money("40.00"), min_seller_price: money("45.00"), price: money("60.00"), ...fields });

    await t.test("unified-price fallback follows root-level cursors, exits AUTO and preserves SELLER participation", async () => {
      await reset();
      let exited = false;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") {
          if (exited) return { products: [{ id: 502, add_mode: "SELLER" }], total: 1, last_id: "" };
          if (request.body.last_id === "next") return { products: [automaticProduct(503, { action_price: money("70.00"), min_seller_price: money("75.00"), price: money("100.00") }), { id: 502, add_mode: "SELLER" }], total: 3, last_id: "" };
          return { products: [automaticProduct(501)], total: 3, last_id: "next" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.deepEqual(request.body, { action_id: 123, products: [{ product_id: 501, action_price: money("50.01") }, { product_id: 503, action_price: money("75.00") }] });
          exited = true;
          return { deactivated_product_ids: ["501", "503"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 2);
      assert.equal(result.config.lastError, "");
      assert.equal(result.config.lastResult.actionSummaries[0].verified, true);
      assert.ok(requests.some(row => row.endpoint === "/v2/actions/products" && row.body.last_id === "next"));
      assert.ok(requests.filter(row => row.endpoint === "/v2/actions/products").length >= 3, "an update receipt must be followed by a fresh product-list check");
      assert.equal(requests.filter(row => row.endpoint === "/v1/actions/products").length, 1, "a migrated shop should not repeatedly call its rejected old method");
      assert.ok(!requests.some(row => /products\/deactivate$/.test(row.endpoint)), "Boosting cannot use the voucher-only v2 deactivate method");
    });

    await t.test("an incomplete first legacy page restarts v2 without a legacy cursor or target", async () => {
      await reset();
      let exited = false;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return { result: { products: [{ id: 901, add_mode: "AUTO" }], total: 2, last_id: "" } };
        if (request.endpoint === "/v2/actions/products") {
          assert.equal(request.body.last_id, undefined);
          return { products: exited ? [] : [automaticProduct(501)], total: exited ? 0 : 1, last_id: "" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.deepEqual(request.body.products.map(row => row.product_id), [501]);
          exited = true;
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected incomplete-legacy fallback request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 1);
      const v2 = requests.filter(row => row.endpoint === "/v2/actions/products");
      assert.ok(v2.length >= 2);
      assert.equal(v2[0].body.last_id, undefined);
      assert.equal(requests.filter(row => row.endpoint === "/v1/actions/products").length, 1);
    });

    await t.test("a legacy terminal empty page discards every legacy-only AUTO target before a fresh v2 scan", async () => {
      await reset();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") {
          if (!request.body.last_id) return { result: { products: [{ id: 901, add_mode: "AUTO" }], total: 2, last_id: "legacy-tail" } };
          assert.equal(request.body.last_id, "legacy-tail");
          return { result: { products: [], total: 2, last_id: "legacy-tail" } };
        }
        if (request.endpoint === "/v2/actions/products") {
          assert.equal(request.body.last_id, undefined);
          return { products: [{ id: 501, add_mode: "SELLER" }], total: 1, last_id: "" };
        }
        throw new Error(`Legacy-only targets must never cause ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 0);
      assert.equal(result.config.lastResult.actionSummaries[0].detectedCount, 0);
      assert.ok(!requests.some(row => /products\/(?:deactivate|update|delete)$/.test(row.endpoint)));
      assert.deepEqual(requests.filter(row => row.endpoint === "/v1/actions/products").map(row => row.body.last_id), [undefined, "legacy-tail"]);
      assert.ok(requests.some(row => row.endpoint === "/v2/actions/products"));
    });

    await t.test("a unified-price refusal on a later legacy page restarts independent v2 pagination and targets", async () => {
      await reset();
      let exited = false;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") {
          if (!request.body.last_id) return { result: { products: [{ id: 901, add_mode: "AUTO" }], total: 2, last_id: "legacy-tail" } };
          assert.equal(request.body.last_id, "legacy-tail");
          return unifiedPriceRefusal();
        }
        if (request.endpoint === "/v2/actions/products") {
          assert.notEqual(request.body.last_id, "legacy-tail");
          if (exited) return { products: [{ id: 502, add_mode: "SELLER" }], total: 1, last_id: "" };
          if (!request.body.last_id) return { products: [automaticProduct(501)], total: 2, last_id: "v2-tail" };
          assert.equal(request.body.last_id, "v2-tail");
          return { products: [{ id: 502, add_mode: "SELLER" }], total: 2, last_id: "" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.deepEqual(request.body.products.map(row => row.product_id), [501]);
          exited = true;
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected mid-pagination fallback request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 1);
      const v2 = requests.filter(row => row.endpoint === "/v2/actions/products");
      assert.equal(v2[0].body.last_id, undefined);
      assert.ok(v2.some(row => row.body.last_id === "v2-tail"));
      assert.ok(!v2.some(row => row.body.last_id === "legacy-tail"));
    });

    await t.test("fallback does not bypass invalid v2 cursors or an inconsistent terminal confirmation", async () => {
      for (const failure of ["missing_cursor", "repeated_cursor", "changed_terminal_total"]) {
        await reset();
        let terminalReads = 0;
        respond = async request => {
          if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
          if (request.endpoint === "/v1/actions/products") return { result: { products: [{ id: 901, add_mode: "AUTO" }], total: 2, last_id: "" } };
          if (request.endpoint === "/v2/actions/products") {
            if (failure === "missing_cursor") return { products: [automaticProduct(501)], total: 2, last_id: "" };
            if (!request.body.last_id) return { products: [automaticProduct(501)], total: 2, last_id: "v2-tail" };
            assert.equal(request.body.last_id, "v2-tail");
            if (failure === "repeated_cursor") return { products: [automaticProduct(503)], total: 2, last_id: "v2-tail" };
            terminalReads += 1;
            return { products: [], total: terminalReads === 1 ? 2 : 3, last_id: "v2-tail" };
          }
          throw new Error(`An unverified v2 traversal must not cause ${request.endpoint}`);
        };
        const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
        assert.equal(result.success, false, failure);
        assert.equal(result.immediateRun.count, 0, failure);
        assert.ok(result.config.lastError, failure);
        assert.ok(!requests.some(row => /products\/(?:deactivate|update|delete)$/.test(row.endpoint)), failure);
      }
    });

    await t.test("a confirmed terminal empty cursor permits an overstated v2 total while recording its warning", async () => {
      await reset();
      let exited = false;
      let terminalEmptyReads = 0;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") {
          if (!request.body.last_id) {
            terminalEmptyReads = 0;
            return { products: exited ? [{ id: 502, add_mode: "SELLER" }] : [automaticProduct(501), { id: 502, add_mode: "SELLER" }], total: exited ? 2 : 3, last_id: "terminal-cursor" };
          }
          assert.equal(request.body.last_id, "terminal-cursor");
          terminalEmptyReads += 1;
          return { products: [], total: exited ? 2 : 3, last_id: "terminal-cursor" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.ok(terminalEmptyReads >= 2, "the same empty terminal page must be confirmed before any price write");
          assert.deepEqual(request.body.products, [{ product_id: 501, action_price: money("50.01") }]);
          exited = true;
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 1);
      assert.ok(terminalEmptyReads >= 2, "post-write verification must also confirm the terminal empty cursor");
      const summary = result.config.lastResult.actionSummaries.find(row => row.actionId === 123);
      assert.equal(summary.verified, true);
      assert.ok(summary.totalMismatch, "the platform total discrepancy must remain visible in the execution record");
      assert.ok(summary.paginationWarning, "a confirmed discrepancy must not silently disappear from the scan result");
    });

    await t.test("future auto-add cleanup scans every offset page and deletes only explicit automatic rows for the supplied date", async () => {
      await reset();
      const autoAddDate = new Date(Date.now() + 86400000).toISOString();
      let future = [
        { product_id: 701, add_mode: false },
        { product_id: 702, add_mode: true },
        { product_id: 703, is_manually_added: false },
        { product_id: 704, add_mode: false, is_manually_added: true },
        { product_id: 705 }
      ];
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING", auto_add_dates: [autoAddDate] }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") return { products: [], total: 0, last_id: "" };
        if (request.endpoint === "/v2/actions/auto-add/products/list") {
          assert.equal(request.body.action_id, 123);
          assert.equal(request.body.auto_add_date, autoAddDate);
          assert.equal(request.body.limit, 100);
          const offset = request.body.offset;
          return { products: future.slice(offset, offset + 2), total: future.length };
        }
        if (request.endpoint === "/v2/actions/auto-add/products/delete") {
          assert.equal(request.body.action_id, 123);
          assert.equal(request.body.auto_add_date, autoAddDate);
          assert.deepEqual(request.body.product_ids.map(Number), [701, 703]);
          const before = requests.slice(0, -1).filter(row => row.endpoint === "/v2/actions/auto-add/products/list");
          assert.deepEqual(before.map(row => row.body.offset), [0, 2, 4], "all offset pages must be read before the list is mutated");
          future = future.filter(row => ![701, 703].includes(row.product_id));
          return { product_ids: ["701", "703"] };
        }
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, true);
      assert.equal(result.immediateRun.count, 2);
      assert.deepEqual(future.map(row => row.product_id), [702, 704, 705]);
      const summary = result.config.lastResult.actionSummaries.find(row => row.scope === "scheduled_auto_add");
      assert.equal(summary.autoAddDate, autoAddDate);
      assert.equal(summary.detectedCount, 2);
      assert.equal(summary.removedCount, 2);
      assert.equal(summary.verified, true);
      assert.ok(requests.filter(row => row.endpoint === "/v2/actions/auto-add/products/list").length > 3, "future-list removal must be verified against the same action/date");
    });

    await t.test("duplicate future-list identities with conflicting automatic and manual flags prevent deletion", async () => {
      await reset();
      const autoAddDate = new Date(Date.now() + 86400000).toISOString();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING", auto_add_dates: [autoAddDate] }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") return { products: [], total: 0, last_id: "" };
        if (request.endpoint === "/v2/actions/auto-add/products/list") return { products: [{ product_id: 701, add_mode: request.body.offset === 0 ? false : true }], total: 2 };
        throw new Error(`Conflicting future-list evidence must not cause ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.equal(result.immediateRun.count, 0);
      assert.ok(result.config.lastError);
      assert.ok(!requests.some(row => row.endpoint === "/v2/actions/auto-add/products/delete"));
      assert.deepEqual(requests.filter(row => row.endpoint === "/v2/actions/auto-add/products/list").map(row => row.body.offset), [0, 1]);
    });

    await t.test("a product manually enrolled in another promotion is protected from shared-price updates", async () => {
      await reset();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }, { id: 124, action_type: "STOCK_DISCOUNT" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") return { products: request.body.action_id === 123 ? [automaticProduct(501)] : [{ id: 501, add_mode: "SELLER" }], total: 1, last_id: "" };
        throw new Error(`A protected product must not cause ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.equal(result.immediateRun.count, 0);
      assert.ok(!requests.some(row => /products\/(?:update|delete|deactivate)$/.test(row.endpoint)));
      const blocked = result.config.lastResult.actionSummaries.find(row => row.actionId === 123);
      assert.equal(blocked.detectedCount, 1);
      assert.equal(blocked.blockedCount, 1);
      assert.match(blocked.error, /手动/);
    });

    await t.test("a mixed automatic batch exits safe products while retaining products manually enrolled elsewhere", async () => {
      await reset();
      let exitedSafe = false;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }, { id: 124, action_type: "STOCK_DISCOUNT" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") {
          const products = request.body.action_id === 123
            ? [...(exitedSafe ? [] : [automaticProduct(501)]), automaticProduct(503)]
            : [{ id: 503, add_mode: "SELLER" }];
          return { products, total: products.length, last_id: "" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.equal(request.body.action_id, 123);
          assert.deepEqual(request.body.products, [{ product_id: 501, action_price: money("50.01") }], "one protected product must not block the other safe products or be updated with them");
          exitedSafe = true;
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false, "the protected remainder must not be reported as complete success");
      assert.equal(result.immediateRun.count, 1, "the safe confirmed exit must still be counted");
      const summary = result.config.lastResult.actionSummaries.find(row => row.actionId === 123);
      assert.equal(summary.detectedCount, 2);
      assert.equal(summary.removedCount, 1);
      assert.equal(summary.remainingCount, 1);
      assert.equal(summary.blockedCount, 1);
      assert.match(summary.error, /手动/);
      assert.equal(requests.filter(row => row.endpoint === "/v1/actions/products/update").length, 1);
    });

    await t.test("a later automatic promotion cannot lower the attempted shared price after an unknown earlier receipt", async () => {
      await reset();
      const exited = new Set();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }, { id: 124, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") {
          const actionId = request.body.action_id;
          const products = exited.has(actionId) ? [] : [automaticProduct(501, { max_action_price: money(actionId === 123 ? "200.00" : "100.00"), action_price: money("90.00"), min_seller_price: money("90.00"), price: money("250.00") })];
          return { products, total: products.length, last_id: "" };
        }
        if (request.endpoint === "/v1/actions/products/update") {
          assert.deepEqual(request.body.products, [{ product_id: 501, action_price: money("200.01") }]);
          if (request.body.action_id === 123) return { __status: 503, message: "Fixture supplier response is unknown after submission" };
          exited.add(request.body.action_id);
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false, "the unknown first receipt must remain an unresolved failure");
      assert.equal(result.immediateRun.count, 1, "only the second promotion has a confirmed exit");
      const updates = requests.filter(row => row.endpoint === "/v1/actions/products/update");
      assert.deepEqual(updates.map(row => row.body.action_id), [123, 124]);
      assert.deepEqual(updates.map(row => row.body.products[0].action_price), [money("200.01"), money("200.01")]);
    });

    await t.test("unknown prices, excessive precision and mixed currencies cannot produce automatic price updates", async () => {
      for (const fields of [
        { max_action_price: { amount: "50.001", currency: "RUB" } },
        { max_action_price: { amount: "50.00" }, action_price: { amount: "40.00" }, min_seller_price: null, price: null },
        { action_price: { amount: "40.00", currency: "CNY" } },
        { action_price: { amount: "500.001", currency: "RUB" } },
        { min_seller_price: { amount: "500.001", currency: "RUB" } },
        { min_seller_price: { amount: "51.00" } },
        { action_price: null },
        { action_price: undefined }
      ]) {
        await reset();
        respond = async request => {
          if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
          if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
          if (request.endpoint === "/v2/actions/products") return { products: [automaticProduct(501, fields)], total: 1, last_id: "" };
          throw new Error(`Invalid Money must not cause ${request.endpoint}`);
        };
        const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
        assert.equal(result.success, false);
        assert.equal(result.immediateRun.count, 0);
        assert.ok(result.config.lastError);
        assert.ok(!requests.some(row => row.endpoint === "/v1/actions/products/update"));
      }
    });

    await t.test("unified product pagination cannot finish before its declared total or use an invalid total", async () => {
      for (const pagination of [{ total: 2, last_id: "" }, { total: -1, last_id: "" }, { last_id: "" }]) {
        await reset();
        respond = async request => {
          if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
          if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
          if (request.endpoint === "/v2/actions/products") return { products: [automaticProduct(501)], ...pagination };
          throw new Error(`An incomplete promotion scan must not cause ${request.endpoint}`);
        };
        const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
        assert.equal(result.success, false);
        assert.ok(result.config.lastError);
        assert.ok(!requests.some(row => row.endpoint === "/v1/actions/products/update"));
      }
    });

    await t.test("HTTP 200 active-product receipts are not treated as confirmed exits", async () => {
      await reset();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") return { products: [automaticProduct(501)], total: 1, last_id: "" };
        if (request.endpoint === "/v1/actions/products/update") return { active_product_ids: ["501"], deactivated_product_ids: [], rejected: [] };
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.equal(result.immediateRun.count, 0);
      assert.ok(result.config.lastError);
      assert.ok(!result.config.lastResult.actionSummaries.some(row => row.verified));
    });

    await t.test("future-list deletion receipts do not count as removals while the automatic product remains", async () => {
      await reset();
      const autoAddDate = new Date(Date.now() + 86400000).toISOString();
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING", auto_add_dates: [autoAddDate] }] };
        if (request.endpoint === "/v1/actions/products") return unifiedPriceRefusal();
        if (request.endpoint === "/v2/actions/products") return { products: [], total: 0, last_id: "" };
        if (request.endpoint === "/v2/actions/auto-add/products/list") return { products: [{ product_id: 701, add_mode: false }], total: 1 };
        if (request.endpoint === "/v2/actions/auto-add/products/delete") return { product_ids: ["701"] };
        throw new Error(`Unexpected promotion request ${request.endpoint}`);
      };
      const result = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      assert.equal(result.success, false);
      assert.equal(result.immediateRun.count, 0);
      const summary = result.config.lastResult.actionSummaries.find(row => row.scope === "scheduled_auto_add");
      assert.equal(summary.removedCount, 0);
      assert.equal(summary.remainingCount, 1);
      assert.equal(summary.verified, false);
      assert.ok(summary.error);
      assert.ok(requests.filter(row => row.endpoint === "/v2/actions/auto-add/products/list").length >= 2);
    });

    await t.test("finishing a pending scan cannot switch a shop back on after the user disables it", async () => {
      await reset();
      let release;
      let started;
      const held = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      respond = async request => {
        assert.equal(request.endpoint, "/v1/actions");
        started();
        await held;
        return { result: [] };
      };
      const running = actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      try {
        await Promise.race([entered, running.then(() => { throw new Error("The scan finished before requesting its promotion catalog"); })]);
        const disabled = await actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: false }, session(2));
        assert.equal(disabled.config.enabled, false);
        release();
        await running;
        const saved = await actions.getOzonActionCleanupConfigMysql({ storeId: 20 }, session(2));
        assert.equal(saved.enabled, false);
        assert.equal(saved.taskEnabled, false);
        const before = requests.length;
        const next = await actions.runOzonActionCleanupForStoreMysql(20, null, { session: session(2) });
        assert.equal(next.skippedDisabled, true);
        assert.equal(requests.length, before);
      } finally { release(); }
    });

    await t.test("revoking the operator's business permission while a scan waits prevents the next supplier request", async () => {
      await reset();
      let release;
      let started;
      const held = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      respond = async request => {
        assert.equal(request.endpoint, "/v1/actions");
        started();
        await held;
        return { result: [{ id: 123, title: "Promotion" }] };
      };
      const running = actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session(2));
      try {
        await Promise.race([entered, running.then(() => { throw new Error("The scan finished before requesting its promotion catalog"); })]);
        await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
        release();
        const outcome = await running.then(result => ({ result }), error => ({ error }));
        if (outcome.error) assert.equal(Number(outcome.error.statusCode || outcome.error.status), 403);
        else assert.equal(outcome.result.success, false);
        assert.equal(requests.length, 1);
      } finally { release(); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});

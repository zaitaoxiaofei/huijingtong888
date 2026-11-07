import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session = id => ({ personId: 7, tenant: { id, slug: `enterprise-${id}` } });
const money = amount => ({ amount, currency: "RUB" });
const joined = (id, fields = {}) => ({ id, add_mode: "SELLER", max_action_price: money("50.00"), action_price: money("40.00"), min_seller_price: money("45.00"), price: money("60.00"), ...fields });
const isWrite = request => /products\/(?:deactivate|delete|update)$/.test(request.endpoint);

test("manual promotion removal verifies current-shop products and confirmed official outcomes", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET",
  timeout: 90000
}, async t => {
  const fixture = await createTenantMysqlFixture("action_manual");
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    const columns = await query("SHOW COLUMNS FROM tenants");
    if (!columns.some(column => column.Field === "subscription_status")) await query("ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'");
    if (!columns.some(column => column.Field === "subscription_expires_at")) await query("ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL");
    const shopColumns = await query("SHOW COLUMNS FROM shops");
    if (!shopColumns.some(column => column.Field === "ozon_api_key")) await query("ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL");
    await query("INSERT INTO tenants (id,slug,name) VALUES (2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (20,2,'A','client-20','fixture-key'),(30,3,'B','client-30','fixture-key')");
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(new URL(url).origin, "https://api-seller.ozon.ru");
      const request = { endpoint: new URL(url).pathname, client: options.headers?.["Client-Id"], body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      const { __status: status = 200, ...body } = await respond(request);
      return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
    };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const actions = await import("../src/services/ozon-actions.js");
    const remove = (products = [{ id: 501 }], body = {}) => actions.removeOzonActionProductsMysql({ storeId: 20, actionId: 123, mode: "official", products, confirmSharedPrice: true, ...body }, { session: session(2) });
    const configure = async ({ unified = true, voucher = false, type = "ELASTIC_BOOSTING", rows = [joined(501)], receipt = null, applyReceipt = true } = {}) => {
      requests.length = 0;
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
      let currentRows = rows;
      const acknowledge = (result, ids) => {
        const removed = new Set((Array.isArray(ids) ? ids : []).map(Number));
        if (applyReceipt) currentRows = currentRows.filter(row => !removed.has(Number(row.product_id ?? row.id)));
        return result;
      };
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: type, is_voucher_action: voucher }] };
        if (request.endpoint === "/v1/actions/products") {
          if (unified) return { __status: 400, message: "the method is blocked due to unified price logic. To resume management via promotions, please switch to the new methods" };
          return { result: { products: currentRows, total: currentRows.length, last_id: "" } };
        }
        if (request.endpoint === "/v2/actions/products") return { products: currentRows, total: currentRows.length, last_id: "" };
        if (request.endpoint === "/v1/actions/products/deactivate") {
          const result = receipt || { result: { product_ids: [501], rejected: [] } };
          return acknowledge(result, result.result?.product_ids);
        }
        if (request.endpoint === "/v2/actions/products/deactivate") {
          const result = receipt || { product_ids: ["501"] };
          return acknowledge(result, result.product_ids);
        }
        if (request.endpoint === "/v1/actions/products/update") {
          const result = receipt || { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
          return acknowledge(result, result.deactivated_product_ids);
        }
        throw new Error(`Unexpected manual promotion request ${request.endpoint}`);
      };
    };
    const assertNoWrite = () => assert.ok(!requests.some(isWrite), "a failed preflight must not submit any product mutation");
    const assertFailedWithoutWrite = async promise => {
      const outcome = await promise.then(value => ({ value }), error => ({ error }));
      assert.ok(outcome.error || outcome.value.success === false);
      assertNoWrite();
    };

    await t.test("legacy shops retain v1 removal with per-product official confirmation", async () => {
      await configure({ unified: false });
      const result = await remove();
      assert.equal(result.success, true);
      assert.equal(result.apiVersion, "v1");
      assert.equal(result.count, 1);
      assert.deepEqual(result.removedProductIds, [501]);
      assert.deepEqual(result.failedProductIds, []);
      assert.deepEqual(result.result.product_ids, [501]);
      assert.deepEqual(requests.filter(isWrite).map(row => row.endpoint), ["/v1/actions/products/deactivate"]);
    });

    await t.test("unified manual removal accepts SELLER rows and uses official Money rather than submitted metadata", async () => {
      await configure({ rows: [joined(501, { action_price: money("70.00"), min_seller_price: money("75.00"), price: money("100.00") })] });
      const result = await remove([{ id: 501, add_mode: "AUTO", max_action_price: money("0.01"), action_price: money("0.01"), min_seller_price: money("0.01") }], { action_type: "FAKE", is_voucher_action: true });
      assert.equal(result.success, true);
      assert.equal(result.apiVersion, "v2");
      assert.deepEqual(result.removedProductIds, [501]);
      const writes = requests.filter(isWrite);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].endpoint, "/v1/actions/products/update");
      assert.deepEqual(writes[0].body, { action_id: 123, products: [{ product_id: 501, action_price: money("75.00") }] });
      assert.ok(requests.some(row => row.endpoint === "/v2/actions/products"));
    });

    await t.test("a shop allowing legacy reads but refusing legacy deletion is reread with v2 Money before retrying", async () => {
      await configure();
      let exited = false;
      respond = async request => {
        if (request.endpoint === "/v1/actions") return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
        if (request.endpoint === "/v1/actions/products") return { result: { products: [{ id: 501, add_mode: "MANUAL", action_price: 1, price: 2 }], total: 1, last_id: "" } };
        if (request.endpoint === "/v1/actions/products/deactivate") return { __status: 400, message: "the method is blocked due to unified price logic" };
        if (request.endpoint === "/v2/actions/products") return { products: exited ? [] : [joined(501, { action_price: money("70.00"), min_seller_price: money("75.00") })], total: exited ? 0 : 1, last_id: "" };
        if (request.endpoint === "/v1/actions/products/update") {
          assert.deepEqual(request.body.products, [{ product_id: 501, action_price: money("75.00") }]);
          exited = true;
          return { deactivated_product_ids: ["501"], active_product_ids: [], rejected: [] };
        }
        throw new Error(`Unexpected legacy-to-unified request ${request.endpoint}`);
      };
      const result = await remove();
      assert.equal(result.success, true);
      assert.equal(result.apiVersion, "v2");
      assert.deepEqual(result.removedProductIds, [501]);
      assert.deepEqual(requests.filter(isWrite).map(row => row.endpoint), ["/v1/actions/products/deactivate", "/v1/actions/products/update"]);
      const freshRead = requests.findIndex(row => row.endpoint === "/v2/actions/products");
      const priceWrite = requests.findIndex(row => row.endpoint === "/v1/actions/products/update");
      assert.ok(freshRead >= 0 && freshRead < priceWrite);
    });

    await t.test("voucher promotions use v2 deactivate without requiring shared-price approval", async () => {
      await configure({ voucher: true });
      const result = await remove([{ id: 501 }], { confirmSharedPrice: false });
      assert.equal(result.success, true);
      assert.deepEqual(result.removedProductIds, [501]);
      const writes = requests.filter(isWrite);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].endpoint, "/v2/actions/products/deactivate");
      assert.deepEqual(writes[0].body.product_ids.map(Number), [501]);
    });

    await t.test("shared-price changes require an explicit confirmation after read-only preflight", async () => {
      await configure();
      await assert.rejects(remove([{ id: 501 }], { confirmSharedPrice: false }), error => Number(error.statusCode || error.status) === 409 && error.code === "PROMOTION_SHARED_PRICE_CONFIRMATION_REQUIRED");
      assertNoWrite();
    });

    await t.test("partial receipts retain both confirmed products and precise rejected outcomes", async () => {
      await configure({ rows: [joined(501), joined(502)], receipt: { deactivated_product_ids: ["501"], active_product_ids: ["502"], rejected: [{ product_id: 502, reason: "Official fixture rejection" }] } });
      const result = await remove([{ id: 501 }, { id: 502 }]);
      assert.equal(result.success, false);
      assert.equal(result.count, 1);
      assert.deepEqual(result.removedProductIds, [501]);
      assert.deepEqual(result.failedProductIds, [502]);
      assert.deepEqual(result.result.product_ids, [501]);
      assert.equal(result.result.rejected[0].product_id, 502);
      assert.match(result.result.rejected[0].reason, /Official fixture rejection/);
      assert.ok(result.error);
    });

    await t.test("HTTP 200 without a confirmed deactivation never becomes successful removal", async () => {
      for (const receipt of [{ active_product_ids: ["501"], deactivated_product_ids: [], rejected: [] }, {}]) {
        await configure({ receipt });
        const result = await remove();
        assert.equal(result.success, false);
        assert.equal(result.count, 0);
        assert.deepEqual(result.removedProductIds, []);
        assert.deepEqual(result.failedProductIds, [501]);
        assert.equal(result.result.rejected[0].product_id, 501);
      }
    });

    await t.test("a deactivation receipt is not counted while read-back still shows the selected product", async () => {
      await configure({ applyReceipt: false });
      const result = await remove();
      assert.equal(result.success, false);
      assert.equal(result.count, 0);
      assert.deepEqual(result.removedProductIds, []);
      assert.deepEqual(result.failedProductIds, [501]);
      assert.match(result.result.rejected[0].reason, /复查/);
      assert.ok(requests.filter(row => row.endpoint === "/v2/actions/products").length >= 3);
      assert.equal(requests.filter(isWrite).length, 1);
    });

    await t.test("malformed selected IDs reject the whole request before catalog reads or product writes", async () => {
      for (const products of [[{ id: 0 }], [{ id: 501 }, { id: "not-an-id" }], [{ id: Number.MAX_SAFE_INTEGER + 2 }]]) {
        await configure();
        await assert.rejects(remove(products), error => Number(error.statusCode || error.status) === 400);
        assert.equal(requests.length, 0);
      }
    });

    await t.test("missing selected products and foreign shop IDs can never be written", async () => {
      await configure();
      await assertFailedWithoutWrite(remove([{ id: 999 }]));
      await configure();
      const partial = await remove([{ id: 501 }, { id: 999 }]);
      assert.equal(partial.success, false);
      assert.deepEqual(partial.removedProductIds, [501]);
      assert.deepEqual(partial.failedProductIds, [999]);
      const writes = requests.filter(isWrite);
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body.products.map(row => row.product_id), [501]);
      await configure();
      await assert.rejects(remove([{ id: 501 }], { storeId: 30 }), /店铺不存在/);
      assert.equal(requests.length, 0);
    });

    await t.test("unknown promotion types and incomplete official Money fail closed", async () => {
      for (const setup of [
        { type: "UNKNOWN_NEW_PROMOTION" },
        { rows: [joined(501, { max_action_price: { amount: "50.00" } })] },
        { rows: [joined(501, { action_price: { amount: "40.00", currency: "CNY" } })] }
      ]) {
        await configure(setup);
        await assertFailedWithoutWrite(remove());
      }
    });

    await t.test("revoking operations while catalog reading waits prevents every later supplier call", async () => {
      await configure();
      let release;
      let entered;
      const held = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      respond = async request => {
        assert.equal(request.endpoint, "/v1/actions");
        entered();
        await held;
        return { result: [{ id: 123, action_type: "ELASTIC_BOOSTING" }] };
      };
      const pending = remove();
      try {
        await Promise.race([started, pending.then(() => { throw new Error("Manual removal completed before reading its catalog"); })]);
        await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
        release();
        const outcome = await pending.then(value => ({ value }), error => ({ error }));
        assert.ok(outcome.error || outcome.value.success === false);
        assert.equal(requests.length, 1);
        assertNoWrite();
      } finally { release(); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});

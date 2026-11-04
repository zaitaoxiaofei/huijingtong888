import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("official enrollment uses update Money and verifies each result under current enterprise", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated MySQL", timeout: 60000
}, async t => {
  const fixture = await createTenantMysqlFixture("action_enrollment");
  const previousFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const q = fixture.query;
    const tenantColumns = await q("SHOW COLUMNS FROM tenants");
    if (!tenantColumns.some(row => row.Field === "subscription_status")) await q("ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'");
    if (!tenantColumns.some(row => row.Field === "subscription_expires_at")) await q("ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL");
    const shopColumns = await q("SHOW COLUMNS FROM shops");
    if (!shopColumns.some(row => row.Field === "ozon_api_key")) await q("ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL");
    await q("INSERT INTO tenants (id,slug,name) VALUES (2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await q("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await q("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (2,7,JSON_ARRAY('operations'))");
    await q("INSERT INTO shops (id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (20,2,'A','client-20','fake-key'),(30,3,'B','client-30','fake-key')");
    const session = { personId: 7, tenant: { id: 2, slug: "enterprise-2" } };
    const requests = [];
    let receipt, joined, status = 200, revoke = false;
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, "https://api-seller.ozon.ru");
      assert.equal(options.headers["Client-Id"], "client-20");
      const path = new URL(url).pathname;
      requests.push({ path, payload: JSON.parse(options.body) });
      let body;
      if (path === "/v1/actions/products/update") {
        body = receipt;
        if (revoke) await q("UPDATE tenant_members SET active=0 WHERE tenant_id=2");
      } else if (path === "/v2/actions/products") body = { products: joined, total: joined.length, last_id: "" };
      else throw new Error(`Unexpected endpoint ${path}`);
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const { addOzonActionProductsMysql: add } = await import("../src/services/ozon-actions.js");
    const products = [{ product_id: 501, action_price: 88, currency: "CNY", stock: 0 }, { product_id: 502, action_price: 99, currency: "RUB" }];
    const run = patch => add({ storeId: 20, actionId: 123, products, confirmSharedPrice: true, ...patch }, { session });
    await t.test("partial receipt only confirms matching read-back products", async () => {
      receipt = { active_product_ids: ["501"], deactivated_product_ids: [], rejected: [{ product_id: "502", reason: "price too high" }], warnings: [] };
      joined = [{ id: 501, action_price: { amount: "88.00", currency: "CNY" } }];
      const result = await run();
      assert.equal(result.success, false);
      assert.deepEqual(result.confirmedProductIds, [501]);
      assert.equal(result.failures[0].product_id, 502);
      assert.deepEqual(requests[0].payload.products[0], { product_id: 501, action_price: { amount: "88", currency: "CNY" }, stock: "0" });
      assert.deepEqual(requests.map(row => row.path), ["/v1/actions/products/update", "/v2/actions/products"]);
    });
    await t.test("foreign shop, missing confirmation and invalid Money make no request", async () => {
      requests.length = 0;
      await assert.rejects(run({ storeId: 30 }), /店铺不存在/);
      await assert.rejects(run({ confirmSharedPrice: false }), /共享/);
      await assert.rejects(run({ products: [{ product_id: 501, action_price: 88 }] }), /币种/);
      assert.equal(requests.length, 0);
    });
    await t.test("429 never retries a write or falls back to activate", async () => {
      requests.length = 0; status = 429; receipt = { message: "limited" };
      await assert.rejects(run(), /limited/);
      assert.equal(requests.length, 1);
      status = 200;
    });
    await t.test("revoked membership after mutation prevents false verified success", async () => {
      requests.length = 0; revoke = true;
      receipt = { active_product_ids: [501, 502] };
      const result = await run();
      assert.equal(result.success, false);
      assert.equal(result.count, 0);
      assert.equal(requests.length, 1);
      assert.match(result.failures[0].reason, /回读未完成/);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});

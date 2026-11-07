import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("verified advertising bids update only owned metadata and never fabricate statistics freshness", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated MySQL", timeout: 60000
}, async t => {
  const f = await createTenantMysqlFixture("ad_bid");
  const originalFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    f.useEnvironment();
    const q = f.query;
    const service = await import("../src/services/advertising-analytics.js");
    const { withAdvertisingTenant, withAdvertisingTenantSession } = await import("../src/services/advertising-tenant-context.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    await q("INSERT INTO tenants(id,slug,name) VALUES(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(2,'Staff','operations')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('operations'))");
    for (const id of [2, 3]) {
      await q("INSERT INTO shops(id,tenant_id,name,performance_client_id,performance_client_secret) VALUES(?,?,?,?,?)", [id * 10, id, `Shop ${id}`, `fake-client-${id}`, "fake-secret"]);
      await withAdvertisingTenant(id, () => service.upsertAdvertisingDailyRowsMysql({ rows: [{ shop_id: id * 10, date_key: "2026-10-02", ozon_sku: "456", campaign_id: "123", spend_rub: 100, campaign_bid_rub: 1 }] }));
    }
    await q("UPDATE ozon_ad_sku_daily SET synced_at='2026-10-02 12:00:00'");
    const session = { personId: 2, tenant: { id: 2, slug: "a" } };
    const body = { shop_id: 20, campaign_id: "123", ozon_sku: "456", mode: "bid", bid_rub: "2.5", confirmKeywordReset: true, from: "2026-10-01", to: "2026-10-31" };
    const run = patch => withAdvertisingTenantSession(session, () => service.updateAdvertisingCampaignProductSettingMysql({ ...body, ...patch }));
    const calls = [];
    let applied = false, readValue = "2500000", failWrite = false, rotate = false, revoke = false;
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, "https://api-performance.ozon.ru");
      const path = new URL(url).pathname;
      const payload = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, method: options.method, payload });
      let result = {};
      if (path === "/api/client/token") {
        assert.equal(payload.client_id, "fake-client-2");
        result = { access_token: "fake-token" };
        if (rotate) await q("UPDATE shops SET performance_client_secret='rotated' WHERE id=20");
      } else if (path === "/api/client/campaign") result = { list: [{ id: "123", productAutopilotStrategy: "TARGET_BIDS" }] };
      else if (options.method === "GET") result = { products: [{ sku: "456", bid: applied ? readValue : "1000000" }] };
      else if (path === "/api/client/campaign/123/products" && options.method === "PUT") {
        assert.deepEqual(payload, { bids: [{ sku: "456", bid: "2500000" }] });
        if (failWrite) return new Response(JSON.stringify({ error: "HTTP 405" }), { status: 405 });
        applied = true;
        if (revoke) await q("UPDATE tenant_members SET active=0 WHERE tenant_id=2");
      } else throw new Error(`Unexpected ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    };
    const rows = () => q("SELECT shop_id,campaign_bid_rub,spend_rub,synced_at FROM ozon_ad_sku_daily ORDER BY shop_id");
    await t.test("verified write updates own bid while preserving foreign rows and sync timestamps", async () => {
      const before = await rows();
      assert.equal((await run()).verified, true);
      const after = await rows();
      assert.equal(Number(after[0].campaign_bid_rub), 2.5);
      assert.deepEqual(after[1], before[1]);
      assert.equal(after[0].synced_at.getTime(), before[0].synced_at.getTime());
      assert.equal(Number(after[0].spend_rub), 100);
    });
    await t.test("mismatched read-back and HTTP 405 keep every local fact unchanged", async () => {
      const before = await rows();
      calls.length = 0; applied = false; readValue = "1000000";
      assert.equal((await run()).pending_verification, true);
      assert.deepEqual(await rows(), before);
      applied = false; failWrite = true; calls.length = 0;
      await assert.rejects(run(), /405.*核对/);
      assert.equal(calls.filter(c => c.method === "PUT").length, 1);
      assert.equal(calls.some(c => c.path.endsWith("v2/products") && c.method !== "GET"), false);
      assert.deepEqual(await rows(), before);
      failWrite = false;
    });
    await t.test("foreign shop and invalid input fail before provider traffic", async () => {
      calls.length = 0;
      await assert.rejects(run({ shop_id: 30 }), /当前企业/);
      await assert.rejects(run({ confirmKeywordReset: false }), /否定词/);
      await assert.rejects(run({ bid_rub: "NaN" }), /大于零/);
      assert.equal(calls.length, 0);
    });
    await t.test("key rotation at token receipt stops all later requests", async () => {
      calls.length = 0; rotate = true;
      await assert.rejects(run(), /授权.*变化/);
      assert.equal(calls.length, 1);
      rotate = false;
      await q("UPDATE shops SET performance_client_secret='fake-secret' WHERE id=20");
    });
    await t.test("revocation after a provider write cannot update local facts", async () => {
      calls.length = 0; revoke = true; applied = false;
      const before = await rows();
      await assert.rejects(run(), /核对/);
      assert.deepEqual(await rows(), before);
      assert.equal(calls.at(-1).method, "PUT");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await f.cleanup();
  }
});

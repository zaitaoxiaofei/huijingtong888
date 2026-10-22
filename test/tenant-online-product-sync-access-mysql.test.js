import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { createSyncRoutes } from "../src/server/routes/sync.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { createTenantBackgroundTasks } from "../src/services/tenant-background-tasks.js";
import { authorizeBusinessTaskSession } from "../src/services/business-task-tenant.js";
import { assertInventoryRecord, resolveInventoryTenantScope } from "../src/services/inventory-tenant-scope.js";

const session = id => ({ personId: 7, roles: ["operations"], tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}`, role: "member" } });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async condition => { for (let i = 0; i < 1000; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error("Fixture task did not reach the expected state"); };

test("online sync routes and task handles preserve live A/B/default authority in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL"
}, async t => {
  const database = `ozon_online_access_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root" });
  let created = false;
  const pending = [];
  try {
    const [[server]] = await connection.query("SELECT @@skip_networking AS disabled");
    assert.equal(Number(server.disabled), 1);
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants(id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people(id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32), roles_json JSON NULL)",
      "CREATE TABLE tenant_members(tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON, PRIMARY KEY(tenant_id,person_id))",
      "CREATE TABLE shops(id BIGINT PRIMARY KEY, tenant_id BIGINT NULL, name VARCHAR(80), status VARCHAR(32) DEFAULT 'active')"
    ]) await query(sql);
    await query("INSERT INTO tenants(id,slug) VALUES(1,'default'),(2,'enterprise-2'),(3,'enterprise-3')");
    await query("INSERT INTO people(id,role) VALUES(7,'operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Default legacy'),(11,1,'Default'),(20,2,'A'),(30,3,'B')");
    const authorize = current => authorizeBusinessTaskSession(current, query);
    const restore = async () => {
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
      await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
    };
    const build = service => {
      const tasks = createTenantBackgroundTasks({ authorize });
      const routes = createSyncRoutes({ services: { syncOzonOnlineProducts: service }, tasks, authorize, readJson: async req => req.body || {} });
      const call = async (current, method, path, body = {}) => {
        const parts = ["api", ...path.split("/")];
        const req = { _session: current, method, body, headers: { "x-tenant-id": "3" }, _abortSignal: new AbortController().signal };
        for (const check of [authorizeApiRequest(req, parts), tenantIsolationDecision(current, parts, method)]) {
          if (!check.allowed) throw Object.assign(new Error(check.error), { statusCode: 403, code: check.code });
        }
        return routes[`${method} /api/${path}`](req);
      };
      return { tasks, call };
    };
    await t.test("session enterprise and actor override forged selectors before shop ownership checks", async () => {
      const calls = [];
      // Scope and shop verification use real SQL; external Ozon and product writes
      // are an adapter here and are covered by the separate worker SQL suite.
      const { call } = build(async (body, options) => {
        const scope = await resolveInventoryTenantScope(options.tenantId, query);
        await assertInventoryRecord(scope, "shop", body.shop_id, query);
        calls.push({ tenant: scope.id, actor: options.session.personId, shop: body.shop_id });
        return { upserted: 1, tenant: scope.id };
      });
      for (const [id, shop] of [[1, 10], [2, 20], [3, 30]]) {
        const start = await call(session(id), "POST", "sync/online-products", { shop_id: shop, tenant_id: 999, created_by_person_id: 999 });
        assert.equal(start.started, true);
        await until(async () => !(await call(session(id), "GET", "sync/online-products/status")).running);
        assert.deepEqual((await call(session(id), "GET", "sync/online-products/status")).result, { upserted: 1, tenant: id });
      }
      assert.deepEqual(calls, [{ tenant: 1, actor: 7, shop: 10 }, { tenant: 2, actor: 7, shop: 20 }, { tenant: 3, actor: 7, shop: 30 }]);
      await call(session(2), "POST", "sync/online-products", { shop_id: 30, tenant_id: 3 });
      await until(async () => !(await call(session(2), "GET", "sync/online-products/status")).running);
      assert.match((await call(session(2), "GET", "sync/online-products/status")).error, /不属于当前企业/);
      assert.equal(calls.length, 3);
    });
    await t.test("concurrent enterprises have separate progress, results and busy handles", async () => {
      const controls = new Map(), actors = [];
      const { call } = build(async (_body, options) => {
        const id = Number(options.session.tenant.id), control = defer(); pending.push(control); controls.set(id, control);
        actors.push({ tenant: id, actor: options.session.personId });
        assert.equal(typeof options.onProgress, "function");
        options.onProgress({ phase: "products", shop_id: id * 10, completed: id, total: 10 });
        return control.promise;
      });
      const handles = [];
      for (const id of [1, 2, 3]) handles.push(await call(session(id), "POST", "sync/online-products", { pending_listing: true }));
      await until(() => controls.size === 3);
      assert.equal(new Set(handles.map(item => item.task_id)).size, 3);
      for (const id of [1, 2, 3]) {
        const snapshot = await call(session(id), "GET", "sync/online-products/status");
        assert.deepEqual(snapshot.progress, { phase: "products", shop_id: id * 10, completed: id, total: 10 });
        const busy = await call(session(id), "POST", "sync/online-products", { scope: "all", tenant_id: 999 });
        assert.equal(busy.started, false); assert.equal(busy.task_id, handles[id - 1].task_id);
        controls.get(id).resolve({ tenant: id, fetched: id });
      }
      for (const id of [1, 2, 3]) {
        await until(async () => !(await call(session(id), "GET", "sync/online-products/status")).running);
        assert.deepEqual((await call(session(id), "GET", "sync/online-products/status")).result, { tenant: id, fetched: id });
      }
      assert.deepEqual(actors, [1, 2, 3].map(tenant => ({ tenant, actor: 7 })));
    });
    for (const [name, revoke] of [
      ["operations duty", () => query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2")],
      ["membership", () => query("UPDATE tenant_members SET active=0 WHERE tenant_id=2")],
      ["person", () => query("UPDATE people SET active=0")],
      ["subscription", () => query("UPDATE tenants SET subscription_status='paused' WHERE id=2")],
      ["subscription expiry", () => query("UPDATE tenants SET subscription_expires_at='2000-01-01' WHERE id=2")]
    ]) await t.test(`stale sessions lose start and status access after ${name} is revoked`, async () => {
      await restore(); let runs = 0;
      const { call } = build(async () => { runs++; return {}; });
      await revoke();
      for (const [method, path] of [["POST", "sync/online-products"], ["GET", "sync/online-products/status"]]) {
        await assert.rejects(call(session(2), method, path), { statusCode: 403 });
      }
      assert.equal(runs, 0);
    });
    await restore();
  } finally {
    for (const control of pending) control.resolve({ cleanup: true });
    await new Promise(resolve => setImmediate(resolve));
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});

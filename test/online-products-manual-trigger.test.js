import assert from "node:assert/strict";
import test from "node:test";
import { createSyncRoutes } from "../src/server/routes/sync.js";
import { createCatalogRoutes } from "../src/server/routes/catalog.js";
import { createTenantBackgroundTasks } from "../src/services/tenant-background-tasks.js";

const actor = (id, personId = 7) => ({ personId, roles: ["operations"], tenant: { id, slug: `enterprise-${id}`, role: "member" } });
const request = (session = actor(2), body = {}) => ({ _session: session, body, _abortSignal: new AbortController().signal });
const turn = () => new Promise(resolve => setImmediate(resolve));

test("online-product route initialization, list reads and status polls never start a catalog synchronization", async () => {
  let starts = 0, listReads = 0;
  const authorize = async session => session;
  const services = {
    syncOzonOnlineProducts: async () => { starts++; return { upserted: 1 }; },
    onlineProducts: async (params, tenant) => { listReads++; return { rows: [{ id: 1 }], params, tenant }; }
  };
  const routes = createSyncRoutes({ services, authorize, tasks: createTenantBackgroundTasks({ authorize }), readJson: async req => req.body });
  const catalog = createCatalogRoutes({ services, readJson: async req => req.body });
  await turn();
  assert.equal(starts, 0);
  for (let index = 0; index < 3; index++) {
    const req = request();
    assert.equal((await routes["GET /api/sync/online-products/status"](req)).running, false);
    const page = await catalog["GET /api/online-products"](req, new URL("http://localhost:8788/api/online-products?page=1&refresh=1"));
    assert.equal(page.tenant, "2");
    assert.equal(page.rows.length, 1);
  }
  await turn();
  assert.equal(listReads, 3);
  assert.equal(starts, 0);
  assert.equal(routes["GET /api/sync/online-products"], undefined);
});

test("explicit concurrent starts reuse the running enterprise task and polls do not restart completed work", async () => {
  const authorize = async session => session;
  const calls = [], release = new Map();
  const tasks = createTenantBackgroundTasks({ authorize });
  const routes = createSyncRoutes({
    authorize, tasks, readJson: async req => req.body,
    services: { syncOzonOnlineProducts: async (body, options) => {
      calls.push({ body, options });
      options.onProgress({ phase: "saving", fetched: 2 });
      await new Promise(resolve => release.set(options.tenantId, resolve));
      return { upserted: 2 };
    } }
  });
  const httpController = new AbortController();
  const firstRequest = { ...request(actor(2), { shop_id: 20 }), _abortSignal: httpController.signal };
  const [first, second] = await Promise.all([
    routes["POST /api/sync/online-products"](firstRequest),
    routes["POST /api/sync/online-products"](request(actor(2, 8), { shop_id: 21 }))
  ]);
  await turn();
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.reason, "already_running");
  assert.equal(first.task_id, second.task_id);
  assert.equal(second.payload.shop_id, 20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.tenantId, "2");
  assert.equal(calls[0].options.session.personId, 7);
  assert.notEqual(calls[0].options.signal, httpController.signal);
  httpController.abort();
  assert.equal(calls[0].options.signal.aborted, false, "The authorized background task retains its independent lifetime");
  for (let index = 0; index < 3; index++) {
    const status = await routes["GET /api/sync/online-products/status"](request());
    assert.equal(status.task_id, first.task_id);
    assert.equal(status.running, true);
    assert.equal(status.progress.phase, "saving");
  }
  const separate = await routes["POST /api/sync/online-products"](request(actor(3), { shop_id: 30 }));
  await turn();
  assert.equal(separate.started, true);
  assert.notEqual(separate.task_id, first.task_id);
  assert.equal(calls.length, 2);
  release.get("2")();
  release.get("3")();
  await turn();
  for (const tenant of [2, 3]) for (let index = 0; index < 3; index++) {
    const status = await routes["GET /api/sync/online-products/status"](request(actor(tenant)));
    assert.equal(status.running, false);
    assert.equal(status.result.upserted, 2);
  }
  assert.equal(calls.length, 2);
});

test("current duties are checked before a manual catalog task can start", async () => {
  let starts = 0;
  const authorize = async session => ({ ...session, roles: ["packing"] });
  const routes = createSyncRoutes({ authorize, tasks: createTenantBackgroundTasks({ authorize }), readJson: async req => req.body,
    services: { syncOzonOnlineProducts: async () => { starts++; } } });
  for (const route of ["GET /api/sync/online-products/status", "POST /api/sync/online-products"]) {
    await assert.rejects(routes[route](request()), error => Number(error.statusCode || error.status) === 403);
  }
  await turn();
  assert.equal(starts, 0);
});

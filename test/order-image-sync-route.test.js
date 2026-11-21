import assert from "node:assert/strict";
import test from "node:test";
import { handleOrderRestRoute } from "../src/server/routes/orders.js";

function fixture({ path = "/api/orders/23/sync-images", method = "POST", body = {}, session, service } = {}) {
  const responses = [];
  const calls = [];
  const signal = new AbortController().signal;
  const url = new URL(`http://localhost${path}`);
  let reads = 0;
  const req = { method, _session: session ?? { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "enterprise-a", role: "member" } }, _abortSignal: signal };
  return {
    req, responses, calls, signal, reads: () => reads,
    args: {
      req, res: {}, url, parts: url.pathname.split("/").filter(Boolean),
      services: { syncOrderImages: service ?? (async (...args) => { calls.push(args); return { ok: true, updated: 1 }; }), orderDetail: async () => null },
      readJson: async current => { assert.equal(current, req); reads += 1; return body; },
      json: (_res, value) => { responses.push(value); return value; }, notFound: () => null, writeHead() {}
    }
  };
}

test("single order image route passes numeric order, authenticated tenant, session and cancellation signal", async () => {
  const body = { item_id: 41 };
  const f = fixture({ body });
  assert.deepEqual(await handleOrderRestRoute(f.args), { ok: true, updated: 1 });
  assert.equal(f.calls.length, 1);
  const [orderId, payload, tenantId, options] = f.calls[0];
  assert.equal(orderId, 23);
  assert.equal(payload, body);
  assert.equal(tenantId, "2");
  assert.equal(options.session, f.req._session);
  assert.equal(options.signal, f.signal);
  assert.equal(f.reads(), 1);
});

test("image route cannot take enterprise ownership from request body or query", async () => {
  const f = fixture({ path: "/api/orders/23/sync-images?tenantId=3&tenant_id=3", body: { tenantId: 3, tenant_id: 3 } });
  await handleOrderRestRoute(f.args);
  assert.equal(f.calls[0][2], "2");
  const legacy = fixture({ session: { personId: 7, roles: ["operations"], tenant: { id: 1, slug: "default" } } });
  await handleOrderRestRoute(legacy.args);
  assert.equal(legacy.calls[0][2], "admin");
});

test("image route requires the exact numeric single-order POST path", async () => {
  for (const [method, path] of [
    ["POST", "/api/orders/sync-images"], ["POST", "/api/orders/batch/sync-images"],
    ["POST", "/api/orders/23,24/sync-images"], ["POST", "/api/orders/-23/sync-images"],
    ["POST", "/api/orders/2.3/sync-images"], ["POST", "/api/orders/2e3/sync-images"],
    ["POST", "/api/orders/23/sync-images/extra"], ["POST", "/api/orders/23/sync-images-batch"],
    ["PUT", "/api/orders/23/sync-images"], ["DELETE", "/api/orders/23/sync-images"],
    ["POST", "/api/online-products/23/sync-images"]
  ]) {
    const f = fixture({ path, method });
    assert.equal(await handleOrderRestRoute(f.args), false, `${method} ${path}`);
    assert.deepEqual(f.calls, []);
    assert.equal(f.reads(), 0);
  }
});

test("image route waits for persistence and propagates service validation or download failures", async () => {
  let finish;
  const f = fixture({ service: () => new Promise(resolve => { finish = resolve; }) });
  const pending = handleOrderRestRoute(f.args);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.responses, []);
  const saved = { ok: true, updated: 0, failed: 1 };
  finish(saved);
  assert.equal(await pending, saved);
  assert.deepEqual(f.responses, [saved]);
  const failure = fixture({ service: async () => { throw Object.assign(new Error("Image request rejected"), { statusCode: 400 }); } });
  await assert.rejects(handleOrderRestRoute(failure.args), error => error.statusCode === 400);
  assert.deepEqual(failure.responses, []);
});

test("image route fails closed without an enterprise or a supported data service", async () => {
  const f = fixture();
  delete f.req._session.tenant;
  await assert.rejects(handleOrderRestRoute(f.args), error => error.statusCode === 403);
  assert.deepEqual(f.calls, []);
  const unsupported = fixture();
  delete unsupported.args.services.syncOrderImages;
  await assert.rejects(handleOrderRestRoute(unsupported.args), error => error.statusCode === 503);
  assert.equal(unsupported.reads(), 0);
  assert.deepEqual(unsupported.responses, []);
});

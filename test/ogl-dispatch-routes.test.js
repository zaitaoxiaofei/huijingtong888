import assert from "node:assert/strict";
import test from "node:test";
import { createOglDispatchRoutes, handleOglDispatchFileRoute } from "../src/server/routes/ogl-dispatch.js";

const session = { personId: 7, tenant: { id: 12 } };

test("OGL routes forward authenticated session independently from payload or query tenant", async () => {
  const calls = [];
  const dispatch = Object.fromEntries(["bootstrap", "saveSettings", "preview", "createBatch", "listBatches", "detail", "listOfficial", "officialDetail", "officialTracking", "discover", "action"].map((method) => [method, async (...args) => { calls.push({ method, args }); return { ok: true }; }]));
  const payload = { order_ids: [2, 3], tenant_id: 999 };
  const routes = createOglDispatchRoutes({ dispatch, readJson: async () => payload });
  const url = new URL("http://localhost/api/ogl-dispatch/batch?id=8&tenant_id=999");
  for (const handler of Object.values(routes)) assert.deepEqual(await handler({ _session: session }, url), { ok: true });
  for (const call of calls) assert.equal(call.args[0], session);
  assert.deepEqual(calls.find((call) => call.method === "listBatches").args[1], { id: "8", tenant_id: "999" });
  assert.equal(calls.find((call) => call.method === "detail").args[1], "8");
  assert.equal(calls.find((call) => call.method === "createBatch").args[1], payload);
  assert.equal(routes["GET /api/ogl-dispatch/file"], undefined);
  assert.deepEqual(calls.find((call) => call.method === "listOfficial").args[1], { id: "8", tenant_id: "999" });
  assert.deepEqual(calls.find((call) => call.method === "officialDetail").args[1], { id: "8", tenant_id: "999" });
  assert.deepEqual(calls.find((call) => call.method === "officialTracking").args[1], { id: "8", tenant_id: "999" });
});

test("existing official carriage queries stay read-only and propagate dates without a local batch", async () => {
  const calls=[];
  const routes=createOglDispatchRoutes({dispatch:{listOfficial:async(...args)=>{calls.push(args);return {rows:[]};},officialDetail:async(...args)=>{calls.push(args);return {carriage:{id:321}};}},readJson:()=>assert.fail('GET must not read or mutate a body')});
  const url=new URL('http://localhost/api/ogl-dispatch/official-carriage?id=321&date=2026-10-21&shop_id=999&tenant_id=999');
  await routes['GET /api/ogl-dispatch/official-carriages']({_session:session},url);
  await routes['GET /api/ogl-dispatch/official-carriage']({_session:session},url);
  assert.equal(calls.length,2);
  for(const [current,query] of calls){assert.equal(current,session);assert.equal(query.date,'2026-10-21');assert.equal(query.id,'321');}
  assert.equal(routes['POST /api/ogl-dispatch/official-carriage'],undefined);
});

test("OGL routes await mutations and preserve service rejection", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const routes = createOglDispatchRoutes({ dispatch: { action: () => pending, createBatch: () => { throw new Error("validation failed"); } }, readJson: async () => ({}) });
  let completed = false;
  const request = routes["POST /api/ogl-dispatch/action"]({ _session: session }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finish({ ok: true });
  await request;
  await assert.rejects(routes["POST /api/ogl-dispatch/batches"]({ _session: session }), /validation failed/);
});

test("OGL file route writes raw binary and safe download headers after service authorization", async () => {
  const buffer = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.from([128, 255, 0])]);
  const calls = [];
  let output;
  let responseHeaders;
  const req = { method: "GET", _session: session };
  const res = { end: (value) => { output = value; } };
  const handled = await handleOglDispatchFileRoute({
    req, res,
    url: new URL("http://localhost/api/ogl-dispatch/file?batch_id=8&type=labels&tenant_id=999"),
    dispatch: { file: async (...args) => { calls.push(args); return { buffer, contentType: "application/pdf", filename: "../货位标签\r\n.pdf" }; } },
    writeHead: (_res, status, headers) => { assert.equal(status, 200); responseHeaders = headers; }
  });
  assert.equal(handled, true);
  assert.deepEqual(calls, [[session, "8", "labels"]]);
  assert.equal(output, buffer);
  assert.equal(responseHeaders["Content-Type"], "application/pdf");
  assert.equal(responseHeaders["Content-Length"], buffer.length);
  assert.equal(responseHeaders["Cache-Control"], "no-store");
  assert.equal(responseHeaders["X-Content-Type-Options"], "nosniff");
  assert.doesNotMatch(responseHeaders["Content-Disposition"], /[\r\n]|\.\.\//);
  assert.match(responseHeaders["Content-Disposition"], /filename\*=UTF-8''/);
});

test("file authorization failure writes no headers or body and wrong routes return false", async () => {
  let writes = 0;
  const args = {
    req: { method: "GET", _session: session }, res: { end: () => { writes += 1; } },
    url: new URL("http://localhost/api/ogl-dispatch/file?batch_id=9&type=barcode"),
    dispatch: { file: async () => { throw Object.assign(new Error("forbidden"), { statusCode: 403 }); } },
    writeHead: () => { writes += 1; }
  };
  await assert.rejects(handleOglDispatchFileRoute(args), { statusCode: 403 });
  assert.equal(writes, 0);
  assert.equal(await handleOglDispatchFileRoute({ ...args, req: { method: "POST" } }), false);
  assert.equal(await handleOglDispatchFileRoute({ ...args, url: new URL("http://localhost/api/other") }), false);
});

test("file route refuses JSON masquerading as a binary download", async () => {
  await assert.rejects(handleOglDispatchFileRoute({
    req: { method: "GET", _session: session },
    res: { end: () => assert.fail("must not deliver JSON") },
    url: new URL("http://localhost/api/ogl-dispatch/file?batch_id=9&type=labels"),
    dispatch: { file: async () => ({ buffer: Buffer.from("{}"), contentType: "application/json" }) }
  }), { statusCode: 502 });
});

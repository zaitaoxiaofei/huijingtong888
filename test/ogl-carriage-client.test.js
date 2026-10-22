import assert from "node:assert/strict";
import test from "node:test";
import { createOglCarriageClient } from "../src/services/ogl-carriage-client.js";

const shop = { ozon_client_id: "12345", ozon_api_key: "private-api-key" };
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 128, 255, 13, 10])]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("OGL client uses fixed Seller API host, original JSON and selected shop credentials", async () => {
  const calls = [];
  const response = { carriage_id: 91 };
  const client = createOglCarriageClient({ fetchImpl: async (...args) => { calls.push(args); return jsonResponse(response); } });
  const body = { delivery_method_id: 12, departure_date: "2026-10-23" };
  assert.deepEqual(await client.request(shop, "/v1/carriage/create", body), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api-seller.ozon.ru/v1/carriage/create");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers["Client-Id"], shop.ozon_client_id);
  assert.equal(calls[0][1].headers["Api-Key"], shop.ozon_api_key);
  assert.deepEqual(JSON.parse(calls[0][1].body), body);
});

test("OGL client rejects unknown paths and demo/missing credentials without making a request", async () => {
  let calls = 0;
  const client = createOglCarriageClient({ fetchImpl: async () => { calls += 1; } });
  for (const path of ["https://attacker.invalid/", "/v1/carriage/create?x=1", "/v3/posting/fbs/get"]) {
    await assert.rejects(client.request(shop, path, {}), { code: "OGL_ENDPOINT_NOT_ALLOWED" });
  }
  for (const invalid of [{}, { ...shop, ozon_api_key: "demo-key" }, { ...shop, ozon_client_id: "DEMO" }]) {
    await assert.rejects(client.request(invalid, "/v1/carriage/get", {}), { code: "OGL_SHOP_CREDENTIALS_REQUIRED" });
  }
  assert.equal(calls, 0);
});

test("OGL client supports legacy real api_key_hint without changing selected shop", async () => {
  let headers;
  const client = createOglCarriageClient({ fetchImpl: async (_url, options) => { headers = options.headers; return jsonResponse({ status: "new" }); } });
  await client.request({ ozon_client_id: "567", api_key_hint: "real-key" }, "/v1/carriage/get", { carriage_id: 91 });
  assert.equal(headers["Client-Id"], "567");
  assert.equal(headers["Api-Key"], "real-key");
});

test("OGL mutation timeouts have unknown outcomes and are never automatically retried", async () => {
  let calls = 0;
  const client = createOglCarriageClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("private-api-key", "AbortError")), { once: true }));
  } });
  await assert.rejects(client.request(shop, "/v1/carriage/create", { delivery_method_id: 1 }), (error) => {
    assert.equal(error.code, "OGL_REQUEST_TIMEOUT");
    assert.equal(error.operationOutcome, "unknown");
    assert.equal(error.unknown, true);
    assert.equal(error.statusCode, 504);
    assert.doesNotMatch(String(error), /private-api-key/);
    return true;
  });
  assert.equal(calls, 1);
});

test("OGL client never echoes remote error body and marks ambiguous mutation failures", async () => {
  let calls = 0;
  const client = createOglCarriageClient({ fetchImpl: async () => { calls += 1; return jsonResponse({ message: "private-api-key customer-phone posting-number" }, 503); } });
  await assert.rejects(client.request(shop, "/v1/carriage/approve", { carriage_id: 91, containers_count: 3 }), (error) => {
    assert.equal(error.operationOutcome, "unknown");
    assert.equal(error.remoteStatus, 503);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /private-api-key|customer-phone|posting-number/);
    return true;
  });
  assert.equal(calls, 1);
});

test("connection failure and unreadable mutation response preserve unknown outcome", async () => {
  const disconnected = createOglCarriageClient({ fetchImpl: async () => { throw new Error("secret-data"); } });
  await assert.rejects(disconnected.request(shop, "/v1/carriage/set-postings", {}), { code: "OGL_REQUEST_CONNECTION_FAILED", unknown: true });
  const malformed = createOglCarriageClient({ fetchImpl: async () => new Response("gateway html") });
  await assert.rejects(malformed.request(shop, "/v1/carriage/create", {}), { code: "OGL_INVALID_RESPONSE", unknown: true });
  await assert.rejects(malformed.request(shop, "/v1/carriage/get", {}), { code: "OGL_INVALID_RESPONSE", unknown: false });
});

test("set-postings keeps per-posting failures and get-postings uses id without guessed pagination", async () => {
  const calls = [];
  const partial = { result: [{ posting_number: "a", result: true }, { posting_number: "b", result: false, error: "not_found" }] };
  const client = createOglCarriageClient({ fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return jsonResponse(partial); } });
  assert.deepEqual(await client.request(shop, "/v1/carriage/set-postings", { carriage_id: 91, posting_numbers: ["a", "b"] }), partial);
  await client.request(shop, "/v2/posting/fbs/act/get-postings", { id: 91 });
  assert.deepEqual(calls[1], { id: 91 });
});

test("PDF and PNG downloads preserve every byte even with misleading headers", async () => {
  for (const [buffer, expectedType] of [[pdf, "application/pdf"], [png, "image/png"]]) {
    const client = createOglCarriageClient({ fetchImpl: async () => new Response(buffer, { headers: { "content-type": "application/octet-stream" } }) });
    const file = await client.request(shop, "/v2/posting/fbs/act/get-container-labels", { id: 91 }, { binary: true });
    assert.equal(file.contentType, expectedType);
    assert.deepEqual(file.buffer, buffer);
  }
});

test("JSON file_content envelopes decode as validated PDF/PNG rather than returning JSON bytes", async () => {
  for (const data of [{ file_content: pdf.toString("base64") }, { result: { file_content: `data:image/png;base64,${png.toString("base64")}` } }]) {
    const client = createOglCarriageClient({ fetchImpl: async () => jsonResponse(data) });
    const file = await client.request(shop, "/v2/posting/fbs/act/get-barcode", { id: 91 }, { binary: true });
    assert.ok(file.buffer.equals(pdf) || file.buffer.equals(png));
  }
});

test("official binary-string JSON envelopes preserve Latin-1 PDF/PNG bytes even with binary headers", async () => {
  for (const [buffer, contentType] of [[pdf, "application/pdf"], [png, "image/png"]]) {
    const envelope = { file_content: buffer.toString("latin1"), file_name: "official-file", content_type: contentType };
    const client = createOglCarriageClient({ fetchImpl: async () => new Response(JSON.stringify(envelope), { headers: { "content-type": contentType } }) });
    const file = await client.request(shop, "/v2/posting/fbs/act/get-container-labels", { id: 91 }, { binary: true });
    assert.deepEqual(file, { buffer, contentType });
  }
});

test("binary strings with code points outside a byte are rejected instead of truncated", async () => {
  const client = createOglCarriageClient({ fetchImpl: async () => jsonResponse({ file_content: "%PDF-1.7\n\u0100" }) });
  await assert.rejects(client.request(shop, "/v2/posting/fbs/act/get-container-labels", { id: 91 }, { binary: true }), { code: "OGL_FILE_NOT_READY" });
});

test("courier contact allows documented empty HTTP 200 while creation stays unknown without an ID response", async () => {
  const client = createOglCarriageClient({ fetchImpl: async () => new Response(null, { status: 200 }) });
  assert.deepEqual(await client.request(shop, "/v1/carriage/courier-contact/set", { carriage_id: 91, phone: "+86(123)4567-8901" }), {});
  await assert.rejects(client.request(shop, "/v1/carriage/create", {}), { code: "OGL_INVALID_RESPONSE", unknown: true });
});

test("JSON file errors or invalid file_content cannot be delivered as labels", async () => {
  for (const data of [{ error: "private customer detail" }, { file_content: "invalid base64" }, { file_content: Buffer.from("not a PDF").toString("base64") }]) {
    const client = createOglCarriageClient({ fetchImpl: async () => jsonResponse(data) });
    await assert.rejects(client.request(shop, "/v2/posting/fbs/act/get-container-labels", { id: 91 }, { binary: true }), (error) => {
      assert.equal(error.code, "OGL_FILE_NOT_READY");
      assert.doesNotMatch(error.message, /private customer detail/);
      return true;
    });
  }
});

test("deliveryMethods paginates with official cursor and only known filter fields", async () => {
  const bodies = [];
  const replies = [{ methods: [{ id: 1 }], has_next: true, cursor: "next" }, { methods: [{ id: 2 }], has_next: false }];
  const client = createOglCarriageClient({ fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse(replies.shift()); } });
  assert.deepEqual(await client.deliveryMethods(shop, { delivery_method_id: 7, departure_date: "2026-10-23", tenant_id: 999 }), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(bodies, [
    { cursor: "", filter: { delivery_method_id: 7, departure_date: "2026-10-23" }, limit: 1000 },
    { cursor: "next", filter: { delivery_method_id: 7, departure_date: "2026-10-23" }, limit: 1000 }
  ]);
});

test("deliveryMethods rejects repeated or missing cursors and incomplete schema", async () => {
  for (const reply of [{ methods: [], has_next: true, cursor: "" }, { methods: [], has_next: true }, { methods: [] }]) {
    const client = createOglCarriageClient({ fetchImpl: async () => jsonResponse(reply) });
    await assert.rejects(client.deliveryMethods(shop), /Ozon/);
  }
  let calls = 0;
  const client = createOglCarriageClient({ fetchImpl: async () => { calls += 1; return jsonResponse({ methods: [], has_next: true, cursor: "repeated" }); } });
  await assert.rejects(client.deliveryMethods(shop), { code: "OGL_DELIVERY_CURSOR_INVALID" });
  assert.equal(calls, 2);
});

test('daily discovery can bound complete pagination without returning a partial successful list',async()=>{
  let calls=0;
  const client=createOglCarriageClient({fetchImpl:async()=>jsonResponse({methods:[],has_next:true,cursor:`next-${++calls}`})});
  await assert.rejects(client.deliveryMethods(shop,{departure_date:'2026-10-22'},{maxPages:2}),{code:'OGL_DELIVERY_PAGE_LIMIT'});
  assert.equal(calls,2);
});

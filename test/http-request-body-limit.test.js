import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readJson, readText } from "../src/http/request.js";

function requestFromText(text, headers = {}) {
  const req = Readable.from([text]);
  req.headers = headers;
  return req;
}

test("readText rejects content-length larger than the configured limit", async () => {
  await assert.rejects(
    () => readText(requestFromText("{}", { "content-length": "12" }), { limitBytes: 4 }),
    (error) => error?.status === 413 && error?.code === "REQUEST_BODY_TOO_LARGE"
  );
});

test("readText rejects streamed bodies that exceed the configured limit", async () => {
  await assert.rejects(
    () => readText(requestFromText("abcdef"), { limitBytes: 4 }),
    (error) => error?.status === 413 && error?.code === "REQUEST_BODY_TOO_LARGE"
  );
});

test("readJson still parses normal JSON bodies", async () => {
  const payload = await readJson(requestFromText("{\"ok\":true}"));
  assert.deepEqual(payload, { ok: true });
});

test("readJson supports route-specific body limits", async () => {
  await assert.rejects(
    () => readJson(requestFromText("{\"ok\":true}"), { limitBytes: 4 }),
    (error) => error?.status === 413 && error?.code === "REQUEST_BODY_TOO_LARGE"
  );

  const payload = await readJson(requestFromText("{\"ok\":true}"), { limitBytes: 32 });
  assert.deepEqual(payload, { ok: true });
});

test("catalog product saves use the larger product body limit", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/server/routes/catalog.js", import.meta.url), "utf8"));
  assert.match(source, /const PRODUCT_SAVE_BODY_LIMIT_BYTES = 128 \* 1024 \* 1024/);
  assert.match(source, /function readProductSaveJson\(readJson, req\)/);
  assert.match(source, /"POST \/api\/products"[\s\S]*readProductSaveJson\(readJson, req\)/);
  assert.match(source, /updateProduct\(productId, await readProductSaveJson\(readJson, req\)\)/);
});

test("mysql pool initializes connection timezone once per connection", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/mysql-pool.js", import.meta.url), "utf8"));
  assert.match(source, /const initializedMysqlSessions = new WeakSet\(\)/);
  assert.match(source, /initializedMysqlSessions\.has\(connection\)/);
  assert.match(source, /initializedMysqlSessions\.add\(connection\)/);
});

test("mysql pool records connection acquisition pressure", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/mysql-pool.js", import.meta.url), "utf8"));
  assert.match(source, /export function getMysqlPoolMetrics/);
  assert.match(source, /slow acquire wait=/);
  assert.match(source, /acquireTimeouts/);
  assert.match(source, /peakActiveConnections/);
});

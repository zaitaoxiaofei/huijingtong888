import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("order synchronization fetches and persists one shop at a time", () => {
  const sync = service.slice(service.indexOf("export async function syncDemoOrdersMysql"), service.indexOf("async function ensurePurchaseCostVersionSchemaMysql"));
  assert.doesNotMatch(sync, /Promise\.all\(activeShops\.map/);
  assert.match(sync, /for \(const shop of activeShops\)/);
  assert.match(sync, /const result = await fetchOzonPostings/);
});

test("cancelled order catch-up skips unrelated heavy post processing", () => {
  const handler = server.slice(server.indexOf("async function runBackgroundCancelledOrderSync"), server.indexOf("async function runBackgroundPostingDetailSync"));
  assert.match(handler, /statuses:\s*\["cancelled"\]/);
  assert.match(handler, /skip_post_processing:\s*true/);
});

test("scheduled order status sync skips unrelated heavy post processing", () => {
  const handler = server.slice(server.indexOf("async function runBackgroundOrderStatusSync"), server.indexOf("async function runBackgroundCancelledOrderSync"));
  assert.match(handler, /skip_post_processing:\s*true/);
  const incremental = service.slice(service.indexOf("export async function syncOzonIncrementalOrdersMysql"), service.indexOf("export async function syncOzonPostingsByNumberMysql"));
  assert.match(incremental, /if \(body\.skip_post_processing !== true && body\.skipPostProcessing !== true\)/);
});

test("customer message dispatch does not load full order JSON payloads", () => {
  const dispatch = service.slice(service.indexOf("export async function processCustomerMessageTasksMysql"), service.indexOf("export async function sendCustomerMessageMysql"));
  assert.doesNotMatch(dispatch, /SELECT \* FROM orders WHERE id=\? LIMIT 1/);
  assert.match(dispatch, /SELECT id, shop_id, posting_number, status, tracking_stage, logistics_status/);
});

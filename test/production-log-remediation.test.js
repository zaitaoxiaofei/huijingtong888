import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const sellerAnalyticsSource = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");

test("repeat shipping is idempotent and Ozon already-shipped responses are reconciled", () => {
  const start = mysqlSource.indexOf("export async function shipOrdersMysql");
  const end = mysqlSource.indexOf("export async function", start + 30);
  const block = mysqlSource.slice(start, end);

  assert.match(block, /alreadyShipped\.push\(order\.id\);[\s\S]*continue;/);
  assert.match(block, /rawMessage\.includes\("HAS_INCORRECT_STATUS"\) \|\| rawMessage\.includes\("POSTING_ALREADY_SHIPPED"\)/);
  assert.doesNotMatch(block, /This order may already be shipped/);
});

test("expected inventory and procurement conflicts carry HTTP 409 metadata", () => {
  assert.match(mysqlSource, /Inventory product not found or archived"\), \{ statusCode: 409 \}/);
  assert.match(mysqlSource, /Only open procurement requests can be directly inbounded"\), \{[\s\S]*statusCode: 409,[\s\S]*procurement_request\.status/);
});

test("seller authorization probes have a bounded foreground latency", () => {
  const start = sellerAnalyticsSource.indexOf("async function probeCollectorPoolAuth");
  const end = sellerAnalyticsSource.indexOf("async function", start + 30);
  const block = sellerAnalyticsSource.slice(start, end);
  assert.match(block, /AbortSignal\.timeout\(4000\)/);
  assert.doesNotMatch(block, /AbortSignal\.timeout\(20000\)/);
});

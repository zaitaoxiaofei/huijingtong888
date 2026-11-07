import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("scheduled outbound reconciliation stays scoped to the changed orders", () => {
  assert.match(source, /syncOutboundForOpenOrdersMysql\(\{ order_ids: rows\.map\(\(row\) => row\.id\) \}\)/);
  assert.match(source, /syncOutboundForOpenOrdersMysql\(\{ posting_numbers: postingNumbers \}\)/);
  assert.match(source, /syncOutboundForOpenOrdersMysql\(\{ ordered_from: recentFrom, ordered_to: to \}\)/);
});

test("empty explicit order scopes cannot fall back to a full-table scan", () => {
  assert.match(source, /Object\.hasOwn\(options, "order_ids"\)[\s\S]*?where\.push\("1 = 0"\)/);
  assert.match(source, /Object\.hasOwn\(options, "posting_numbers"\)[\s\S]*?where\.push\("1 = 0"\)/);
});

test("outbound list queries extract only logistics scalars from raw order JSON", () => {
  const start = source.indexOf("async function syncOutboundForOpenOrdersMysql");
  const end = source.indexOf("export async function repairOrderOutboundMysql", start);
  const block = source.slice(start, end);
  assert.equal(/tracking_number\s*,\s*raw\.raw_json/.test(block), false);
  assert.match(block, /JSON_UNQUOTE\(JSON_EXTRACT\(raw\.raw_json, '\$\.delivery_method\.warehouse'\)\)/);
});

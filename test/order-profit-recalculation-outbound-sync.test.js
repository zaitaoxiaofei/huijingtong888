import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("single-order profit recalculation syncs outbound records within the order scope", () => {
  const start = source.indexOf("export async function recalculateOrderProfitMysql");
  const end = source.indexOf("export async function recalculateAllMappedOrderProfitsMysql", start);
  const block = source.slice(start, end);

  assert.match(block, /syncOutboundForOpenOrdersMysql\(\{ order_ids: \[Number\(orderId\)\] \}\)/);
  assert.doesNotMatch(block, /order_item_id: item\.id/);
});

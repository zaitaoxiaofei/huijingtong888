import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const tableSource = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");

test("order logistics display separates Ozon fulfillment from frozen profit billing rule", () => {
  assert.match(serviceSource, /rule\.id = oi\.frozen_logistics_rule_id/);
  assert.match(serviceSource, /billing_logistics_rule_name/);
  assert.match(pageSource, /row\.billing_logistics_rule_name \|\| row\.resolved_logistics_rule_name/);
  assert.match(tableSource, /Ozon: \{\{ row\.logisticsSummary\.ozonMethodName/);
  assert.match(tableSource, /ruleSourceLabel/);
});

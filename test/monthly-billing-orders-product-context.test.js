import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/profit/MonthlyBillingOrdersView.vue", import.meta.url), "utf8");

test("monthly billing orders return product, inventory and terminal reason context", () => {
  assert.match(serviceSource, /AS image_url/);
  assert.match(serviceSource, /AS inventory_names/);
  assert.match(serviceSource, /outcome_reason_label: outcomeReasonLabel/);
  assert.match(serviceSource, /outcome_reason_original: cancellation\.reason_original/);
});

test("monthly billing order rows show portrait product media and an explicit outcome reason", () => {
  assert.match(viewSource, /class="order-product-image"/);
  assert.match(viewSource, /:preview-src-list="\[row\.image_url\]"/);
  assert.match(viewSource, /库存名称/);
  assert.match(viewSource, /结果 \/ 最终原因/);
  assert.match(viewSource, /width: 64px;[\s\S]{0,80}height: 84px;/);
});

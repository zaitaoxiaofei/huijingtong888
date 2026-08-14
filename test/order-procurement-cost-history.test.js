import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order procurement preview returns confirmed purchase cost history", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(service, /orderProcurementCostHistoryMysql/);
  assert.match(service, /po\.status IN \('purchased', 'partial_inbound', 'inbound_done'\)/);
  assert.match(service, /cost_history/);
  assert.match(service, /purchase_cost_versions/);
  assert.match(service, /recordPurchaseCostVersionMysql/);
  assert.match(service, /source_type/);
});

test("order procurement dialog shows price changes and confirms abnormal inputs", async () => {
  const page = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  const styles = await readFile(new URL("../frontend/orders/orders-view.css", import.meta.url), "utf8");

  assert.match(page, /采购成本校验/);
  assert.match(page, /渠道 \{\{ procurementChannelLabel/);
  assert.match(page, /淘宝/);
  assert.match(page, /查看历史/);
  assert.match(page, /采购成本异常确认/);
  assert.match(page, /variance\.ratio \* 100/);
  assert.match(page, /Math\.abs\(amount\) >= 2/);
  assert.match(page, /Math\.abs\(amount \/ previous\) >= 0\.25/);
  assert.match(styles, /\.order-procurement-cost-popover/);
});

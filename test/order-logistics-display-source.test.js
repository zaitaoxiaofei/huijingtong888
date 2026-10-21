import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const tableSource = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");

test("order logistics display separates Ozon fulfillment from frozen profit billing rule", () => {
  assert.match(serviceSource, /rule\.id = oi\.frozen_logistics_rule_id/);
  assert.match(serviceSource, /billing_logistics_rule_name/);
  assert.match(pageSource, /row\.billing_logistics_rule_name \|\| row\.resolved_logistics_rule_name/);
  assert.match(tableSource, /渠道: \{\{ row\.logisticsSummary\.serviceClass/);
  assert.match(tableSource, /运输: \{\{ row\.logisticsSummary\.transportMode/);
  assert.match(tableSource, /Ozon 原始物流名称：/);
  assert.match(tableSource, /serviceClassSourceLabel/);
});

test("order logistics uses independent classification and keeps billing provenance explicit", () => {
  const source = pageSource.match(/function buildLogisticsSummary\(row\) \{[\s\S]*?\n\}\n\nfunction buildStatusDeadlineHint/)?.[0];
  assert.ok(source);
  const buildLogisticsSummary = runInNewContext(`${source.replace(/\n\nfunction buildStatusDeadlineHint$/, "")}\n;buildLogisticsSummary`, {
    trackingLinkFor: () => ""
  });
  const row = {
    delivery_method_name: "Доставка Ozon курьеру",
    resolved_logistics_rule_name: "OGL 陆运 Extra Small",
    billing_logistics_rule_name: "旧利润规则",
    logistics_carrier_label: "OGL",
    logistics_service_class: "Extra Small",
    logistics_service_class_source: "billing_rule",
    logistics_transport_mode_label: "陆运",
    logistics_transport_mode_source: "billing_rule"
  };
  const summary = buildLogisticsSummary(row);
  assert.equal(summary.deliveryMethodLabel, "FBS · OGL");
  assert.equal(summary.serviceClass, "Extra Small");
  assert.equal(summary.serviceClassSourceLabel, "计费规则补充");
  assert.equal(summary.transportMode, "陆运");
  assert.equal(summary.transportModeSourceLabel, "计费规则补充");
  assert.equal(summary.rawOzonMethodName, "Доставка Ozon курьеру");
  assert.equal(summary.resolvedRuleName, "旧利润规则");
  assert.equal(buildLogisticsSummary({ delivery_method_name: row.delivery_method_name, billing_logistics_rule_name: "OGL 陆运 Extra Small" }).serviceClass, "未识别");
  assert.equal(buildLogisticsSummary({ resolved_logistics_rule_name: "CEL Small" }).transportMode, "未识别");
  assert.equal(buildLogisticsSummary({ delivery_method_name: row.delivery_method_name }).ozonMethodName, "Доставка Ozon курьеру");
});

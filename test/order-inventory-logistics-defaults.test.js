import assert from "node:assert/strict";
import test from "node:test";
import { orderInventoryLogisticsDefaults } from "../frontend/orders/utils/inventory-logistics-context.js";

const at = "2026-11-12T08:00:00+08:00";
const rules = [
  { id: 1, carrier: "CEL", channel: "standard", usage_count: 10000 },
  { id: 2, carrier: "OGL", channel: "economy" },
  { id: 3, carrier: "OGL", channel: "standard", enabled: 0 },
  { id: 4, carrier: "OGL", channel: "economy", effective_to: "2026-11-11 00:00:00" },
  { id: 5, carrier: "OGL", channel: "standard", effective_from: "2026-11-13 00:00:00" }
];
const defaults = extra => orderInventoryLogisticsDefaults({ rules, at, ...extra });

test("an OGL order cannot seed a new inventory item with its old CEL billing rule", () => {
  assert.deepEqual(defaults({ carrier: "OGL", sourceRuleId: 1 }), {
    preferred_logistics_carrier: "OGL", logistics_rule_id: "", shipping_method: ""
  });
});

test("only the currently effective exact rule of the actual carrier is inherited", () => {
  assert.deepEqual(defaults({ carrier: "OGL", sourceRuleId: 2 }), {
    preferred_logistics_carrier: "OGL", logistics_rule_id: 2, shipping_method: "economy"
  });
  for (const sourceRuleId of [3, 4, 5, 999]) assert.equal(defaults({ carrier: "OGL", sourceRuleId }).logistics_rule_id, "");
});

test("unknown shipping defaults to OGL without borrowing a historic carrier or a high-usage rule", () => {
  assert.equal(defaults({ sourceRuleId: 1 }).preferred_logistics_carrier, "OGL");
  assert.equal(defaults({ sourceRuleId: 1 }).logistics_rule_id, "");
  assert.equal(defaults({}).logistics_rule_id, "");
});

test("explicit non-OGL shipping and official label aliases stay selectable", () => {
  assert.equal(defaults({ carrier: "CEL", sourceRuleId: 1 }).logistics_rule_id, 1);
  assert.equal(defaults({ carrierLabel: "中国邮政" }).preferred_logistics_carrier, "POSTAL");
  assert.equal(defaults({ carrierLabel: "国邮" }).preferred_logistics_carrier, "GUOO");
  assert.equal(defaults({ carrier: "ogl", carrierLabel: "CEL" }).preferred_logistics_carrier, "OGL");
});

test("preparing an inventory form does not mutate saved rules or map an old rule to its newer version", () => {
  const versioned = [
    { id: 11, version_group_id: 10, carrier: "OGL", effective_to: "2026-11-11 00:00:00" },
    { id: 12, version_group_id: 10, carrier: "OGL", effective_from: "2026-11-11 00:00:00" }
  ];
  const before = JSON.stringify(versioned);
  assert.equal(defaults({ carrier: "OGL", sourceRuleId: 11, rules: versioned }).logistics_rule_id, "");
  assert.equal(JSON.stringify(versioned), before);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  INVENTORY_LOGISTICS_CARRIERS, inventoryLogisticsCarrier, initialInventoryLogisticsCarrier,
  inventoryLogisticsRulesForCarrier, resolveInventoryLogisticsRule
} from "../frontend/admin/utils/inventory-logistics-selection.js";

const at = "2026-11-12T12:00:00+08:00";
const rule = (id, carrier, fields = {}) => ({ id, name: `${carrier} 方式 ${id}`, carrier, enabled: 1, ...fields });

test("inventory logistics categories have the operator order and recognize saved carrier names", () => {
  assert.deepEqual(INVENTORY_LOGISTICS_CARRIERS, [
    { value: "OGL", label: "OGL" }, { value: "POSTAL", label: "邮政" },
    { value: "CEL", label: "CEL" }, { value: "GUOO", label: "国邮" }
  ]);
  for (const carrier of ["postal", "China Post", "CHINA_POST", "邮政"]) assert.equal(inventoryLogisticsCarrier({ carrier }), "POSTAL");
  assert.equal(inventoryLogisticsCarrier("guoo"), "GUOO");
  assert.equal(inventoryLogisticsCarrier("unknown-provider"), "");
});

test("new inventory defaults to OGL while an existing exact rule always owns its category", () => {
  const rules = [rule(1, "CEL"), rule(2, "GUOO")];
  assert.equal(initialInventoryLogisticsCarrier(rules, null), "OGL");
  assert.equal(initialInventoryLogisticsCarrier(rules, null, "postal"), "POSTAL");
  assert.equal(initialInventoryLogisticsCarrier(rules, 1, "OGL"), "CEL");
  assert.equal(initialInventoryLogisticsCarrier(rules, 2, "OGL"), "GUOO");
  assert.equal(initialInventoryLogisticsCarrier(rules, 999), "", "a missing saved rule is never reclassified as OGL");
});

test("category choices include all its current methods without popularity or another carrier", () => {
  const rules = [rule(1, "CEL", { usage_count: 999 }), rule(3, "OGL", { usage_count: 500 }), rule(2, "OGL"), rule(4, "OGL", { enabled: 0 }), rule(5, "OGL", { effective_from: "2027-01-01T00:00:00+08:00" })];
  assert.deepEqual(inventoryLogisticsRulesForCarrier(rules, "OGL", { at }).map(item => item.id), [2, 3]);
  assert.deepEqual(inventoryLogisticsRulesForCarrier(rules, "POSTAL", { at }), []);
});

test("opening a saved historical rule preserves its exact ID alongside the current version", () => {
  const old = rule(10, "CEL", { version_group_id: 10, effective_to: "2026-11-01T00:00:00+08:00" });
  const current = rule(11, "CEL", { version_group_id: 10, effective_from: "2026-11-01T00:00:00+08:00" });
  const choices = inventoryLogisticsRulesForCarrier([old, current], "CEL", { selectedRuleId: 10, at });
  assert.deepEqual(choices.map(item => item.id), [10, 11]);
  assert.equal(resolveInventoryLogisticsRule([old, current], "10"), old);
  assert.deepEqual(inventoryLogisticsRulesForCarrier([old, current], "CEL", { at }).map(item => item.id), [11]);
});

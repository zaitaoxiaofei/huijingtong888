import { currentEffectiveLogisticsRules } from "../../admin/utils/effective-logistics-rules.js";
import { inventoryLogisticsCarrier } from "../../admin/utils/inventory-logistics-selection.js";

export function orderInventoryLogisticsDefaults({ carrier, carrierLabel, sourceRuleId, rules = [], at = new Date() } = {}) {
  const selectedCarrier = inventoryLogisticsCarrier(carrier) || inventoryLogisticsCarrier(carrierLabel) || "OGL";
  // A frozen billing rule is evidence for this new inventory form only when it
  // still belongs to the actual shipping carrier and is currently effective.
  const sourceRule = currentEffectiveLogisticsRules(rules, at)
    .find(rule => String(rule.id) === String(sourceRuleId) && inventoryLogisticsCarrier(rule) === selectedCarrier);
  return {
    preferred_logistics_carrier: selectedCarrier,
    logistics_rule_id: sourceRule?.id || "",
    shipping_method: sourceRule?.channel || ""
  };
}

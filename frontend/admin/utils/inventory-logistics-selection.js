import { currentEffectiveLogisticsRules } from "./effective-logistics-rules.js";

export const INVENTORY_LOGISTICS_CARRIERS = [
  { value: "OGL", label: "OGL" },
  { value: "POSTAL", label: "邮政" },
  { value: "CEL", label: "CEL" },
  { value: "GUOO", label: "国邮" }
];

export function inventoryLogisticsCarrier(rule) {
  const value = String(typeof rule === "string" ? rule : rule?.carrier || "").trim().toUpperCase();
  if (["POSTAL", "POST", "CHINA_POST", "CHINA POST", "中国邮政", "邮政"].includes(value)) return "POSTAL";
  if (value === "国邮") return "GUOO";
  return ["OGL", "CEL", "GUOO"].includes(value) ? value : "";
}

export function resolveInventoryLogisticsRule(rules = [], selectedRuleId) {
  if (!selectedRuleId) return null;
  return rules.find(rule => String(rule.id) === String(selectedRuleId)) || null;
}

export function initialInventoryLogisticsCarrier(rules = [], selectedRuleId, fallbackCarrier = "") {
  if (!selectedRuleId) return inventoryLogisticsCarrier(fallbackCarrier) || "OGL";
  return inventoryLogisticsCarrier(resolveInventoryLogisticsRule(rules, selectedRuleId)) || inventoryLogisticsCarrier(fallbackCarrier);
}

export function inventoryLogisticsRulesForCarrier(rules = [], carrier, { selectedRuleId, at = new Date() } = {}) {
  const choices = currentEffectiveLogisticsRules(rules, at)
    .filter(rule => inventoryLogisticsCarrier(rule) === carrier);
  const saved = resolveInventoryLogisticsRule(rules, selectedRuleId);
  // An existing exact binding is still shown even when its version has ended.
  // Opening the editor must not migrate the product to a different rule ID.
  if (saved && inventoryLogisticsCarrier(saved) === carrier && !choices.some(rule => String(rule.id) === String(saved.id))) choices.push(saved);
  return choices.sort((left, right) => Number(left.min_weight_g || 0) - Number(right.min_weight_g || 0)
    || Number(left.max_weight_g || 0) - Number(right.max_weight_g || 0)
    || Number(left.min_price_rub || 0) - Number(right.min_price_rub || 0)
    || String(left.name || "").localeCompare(String(right.name || ""), "zh-CN", { numeric: true })
    || Number(left.id || 0) - Number(right.id || 0));
}

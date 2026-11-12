import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reactive, ref, computed, watch, nextTick } from "vue";
import { inventoryLogisticsCarrier, initialInventoryLogisticsCarrier, inventoryLogisticsRulesForCarrier, resolveInventoryLogisticsRule } from "../frontend/admin/utils/inventory-logistics-selection.js";
import { quoteLogisticsRules } from "../frontend/admin/utils/logistics-quote.js";

const source = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
const rule = (id, carrier, fields = {}) => ({ id, name: `${carrier} Small ${id}`, carrier, channel: "economy", enabled: 1, mode: "per_gram", min_weight_g: 1, max_weight_g: 1000, min_price_rub: 1, max_price_rub: 1500, per_ticket_cny: 20, per_gram_cny: 0.01, ...fields });
const value = fields => ({ name: "测试库存", purchase_cost: 20, package_weight_g: 300, sale_price_rmb: 100, listing_price_rub: 1000, exchange_rate: 10, length_cm: 20, width_cm: 15, height_cm: 10, ...fields });

function fixture(rules) {
  const form = reactive({}), availableLogisticsRules = ref(rules), selectedLogisticsCarrier = ref("OGL"), manualLogisticsRule = ref(false);
  const context = vm.createContext({
    form, props: { people: [{ id: 7 }], visible: true }, availableLogisticsRules, selectedLogisticsCarrier, manualLogisticsRule, logisticsRuleSelect: ref(null), Event,
    logisticsRuleOptions: computed(() => inventoryLogisticsRulesForCarrier(availableLogisticsRules.value, selectedLogisticsCarrier.value, { selectedRuleId: form.logistics_rule_id })),
    isInventoryTarget: ref(true), manualPackagingFee: ref(false), normalizeComponentItem: item => item, normalizeVehicleBrand: value => value || "", roundMoney: value => value,
    resolvedReturnRate: () => 0.05, requestKey: ref(""), newRequestKey: () => "fixture", componentQuery: ref(""), componentSelectId: ref(""), componentRole: ref(""), componentOptions: ref([]), componentDirectoryRows: ref([]), componentPage: ref(1), componentDirectory: reactive({}), syncPackagingFee: () => {}, syncListingPriceFromSale: () => {},
    inventoryLogisticsCarrier, initialInventoryLogisticsCarrier, resolveInventoryLogisticsRule, quoteLogisticsRules, watch
  });
  for (const name of ["createDefaultForm", "resetForm", "fillFormFromValue", "resolveSelectedLogisticsRule", "syncAutomaticLogisticsRule", "handleLogisticsCarrierChange", "handleLogisticsRuleChange"]) vm.runInContext(extract(name), context);
  const watcher = source.match(/watch\(\s*\(\) => \[form\.package_weight_g,[^]*?\n\);/)[0];
  vm.runInContext(watcher, context);
  return { context, form, availableLogisticsRules, selectedLogisticsCarrier, manualLogisticsRule };
}

test("new dialog defaults to a fitting OGL method even when another carrier is popular or cheaper", async () => {
  const f = fixture([rule(1, "CEL", { usage_count: 999, per_ticket_cny: 1 }), rule(2, "OGL"), rule(3, "GUOO")]);
  f.context.fillFormFromValue(value());
  await nextTick();
  assert.equal(f.selectedLogisticsCarrier.value, "OGL");
  assert.equal(f.form.logistics_rule_id, 2);
  assert.equal(f.context.resolveSelectedLogisticsRule(f.form).id, 2);
});

test("a saved rule and its carrier survive opening, parameter edits and asynchronously refreshed versions", async () => {
  const saved = rule(10, "CEL", { version_group_id: 10, effective_to: "2026-11-01" });
  const f = fixture([saved, rule(11, "CEL", { version_group_id: 10 }), rule(2, "OGL")]);
  f.context.fillFormFromValue(value({ logistics_rule_id: "10", preferred_logistics_carrier: "OGL", shipping_method: "standard" }));
  await nextTick();
  assert.equal(f.selectedLogisticsCarrier.value, "CEL");
  assert.equal(f.form.logistics_rule_id, 10);
  assert.equal(f.form.shipping_method, "standard");
  assert.equal("preferred_logistics_carrier" in f.form, false);
  f.form.package_weight_g = 25000;
  f.availableLogisticsRules.value = [...f.availableLogisticsRules.value, rule(12, "CEL", { usage_count: 99999 })];
  await nextTick();
  assert.equal(f.form.logistics_rule_id, 10);
  assert.equal(f.context.resolveSelectedLogisticsRule(f.form).id, 10);
});

test("switching a carrier only matches its methods and clears an unsuitable selection instead of borrowing another", async () => {
  const f = fixture([rule(1, "CEL"), rule(2, "OGL"), rule(3, "GUOO", { max_weight_g: 100 })]);
  f.context.fillFormFromValue(value({ logistics_rule_id: 1 }));
  await nextTick();
  f.selectedLogisticsCarrier.value = "GUOO";
  f.context.handleLogisticsCarrierChange();
  assert.equal(f.form.logistics_rule_id, "");
  assert.equal(f.context.resolveSelectedLogisticsRule(f.form), null);
  assert.deepEqual(Array.from(f.context.logisticsRuleOptions.value, row => row.id), [3]);
  f.selectedLogisticsCarrier.value = "OGL";
  f.context.handleLogisticsCarrierChange();
  assert.equal(f.form.logistics_rule_id, 2);
  f.form.length_cm = 201;
  await nextTick();
  assert.equal(f.form.logistics_rule_id, "", "dimension edits also clear a now-inapplicable automatic rule");
});

test("new preferred carrier is a UI-only default and a delayed saved binding never switches to a recommendation", async () => {
  const f = fixture([]);
  f.context.fillFormFromValue(value({ logistics_rule_id: "90", logistics_rule_carrier: "postal", preferred_logistics_carrier: "OGL" }));
  await nextTick();
  assert.equal(f.selectedLogisticsCarrier.value, "POSTAL");
  assert.equal(f.form.logistics_rule_id, "90");
  f.availableLogisticsRules.value = [rule(90, "China Post"), rule(2, "OGL")];
  await nextTick();
  assert.equal(f.form.logistics_rule_id, 90);
  assert.equal(f.selectedLogisticsCarrier.value, "POSTAL");
  f.context.fillFormFromValue(value({ preferred_logistics_carrier: "guoo" }));
  await nextTick();
  assert.equal(f.selectedLogisticsCarrier.value, "GUOO");
  assert.equal(f.form.logistics_rule_id, "");
  assert.equal("preferred_logistics_carrier" in f.form, false);
});

test("carrier changes clear the select's filter input without closing its dropdown", () => {
  const f = fixture([rule(1, "CEL"), rule(2, "OGL")]);
  f.context.fillFormFromValue(value());
  const events = [], input = { value: "OGL Small", dispatchEvent: event => events.push({ type: event.type, bubbles: event.bubbles }) };
  f.context.logisticsRuleSelect.value = { $el: { querySelector: () => input } };
  f.selectedLogisticsCarrier.value = "CEL";
  f.context.handleLogisticsCarrierChange();
  assert.equal(input.value, "");
  assert.deepEqual(events, [{ type: "input", bubbles: true }]);
  assert.equal(f.form.logistics_rule_id, 1);
});

test("procurement layout keeps carrier controls inside its select and has ordered four-column measurements", () => {
  const section = source.match(/class="form-section procurement-section">([^]*?)<\/el-row>/)[1];
  const labels = [...section.matchAll(/<el-form-item label="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(labels, ["采购成本", "国内运费", "打包费", "生产周期", "物流到仓时长", "物流规则", "长(cm)", "宽(cm)", "高(cm)", "重量(g)"]);
  const measures = [...section.matchAll(/<el-col class="mobile-packaging-field" v-show="showMobileSection\('measure'\)" :span="(\d+)">/g)];
  assert.equal(measures.length, 4);
  assert.ok(measures.every(match => match[1] === "6"));
  assert.match(section, /<template #header>\s*<div class="inventory-logistics-dropdown-header" @mousedown\.prevent @click\.stop>\s*<el-radio-group/);
  assert.doesNotMatch(section, /已选：/);
});


import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const nodes = parse(script, { ecmaVersion: "latest", sourceType: "module" }).body;
const declarations = nodes.filter(node => node.type === "FunctionDeclaration"
  || (node.type === "VariableDeclaration" && node.declarations.some(item => /^(ORIGIN_COUNTRY|MATERIAL|COLOR)_TRANSLATIONS$|^COLOR_ATTRIBUTE_/.test(item.id.name))))
  .map(node => script.slice(node.start, node.end)).join("\n");
const clone = value => JSON.parse(JSON.stringify(value));
function context() {
  const ctx = vm.createContext({ COLOR_ATTRIBUTE_IDS: new Set(), flatSkuAttributeOptionsCache: new Map(), attributeValueLoading: {} });
  vm.runInContext(declarations, ctx);
  return ctx;
}
function fixture() {
  const fields = [
    { attribute_id: 4389, dictionary_id: 1935, name: "原产国", type: "select", value: ["90296"], values: [{ dictionary_value_id: 90296, value: "China", label: "中国", display_value_zh: "中国" }] },
    { attribute_id: 7199, dictionary_id: 11, name: "材料", type: "select", value: ["970694380"], values: [{ dictionary_value_id: 970694380, value: "Перфорированная экокожа", label: "Перфорированная экокожа" }] },
    { attribute_id: 7202, dictionary_id: 22, name: "包装数量", type: "select", value: "45536", values: [{ dictionary_value_id: 45536, value: "1", label: "1" }] }
  ];
  const row = { id: "draft-5529", dynamic_attributes: Object.fromEntries(fields.map((field, index) => [field.attribute_id, {
    ...clone(field), value: index === 2 ? 45536 : [Number(field.value[0])],
    label: ["中国", "穿孔生态皮革", "1 pc"][index], display_value_zh: ["中国", "穿孔生态皮革", "1 pc"][index]
  }])) };
  return { fields, row };
}

test("batch draft dictionary selects resolve raw IDs to the existing option model without changing saved IDs", () => {
  const ctx = context(), { fields, row } = fixture(), before = JSON.stringify(row);
  const expectedModels = ["China", "Перфорированная экокожа", "1"];
  const expectedLabels = ["中国", "穿孔生态皮革", "1 pc"];
  fields.forEach((field, index) => {
    const model = ctx.variantAttributeSelectModelValue(row, field);
    assert.equal(model, expectedModels[index]);
    const options = clone(ctx.inactiveAttributeCellOptions(row, field));
    assert.equal(options.length, 1);
    assert.equal(ctx.attributeOptionModelValue(options[0]), model);
    assert.equal(ctx.displayAttributeOptionLabel(options[0], field), expectedLabels[index]);
    const active = ctx.flatSkuAttributeOptions(row, field).find(option => ctx.attributeOptionModelValue(option) === model);
    assert.equal(ctx.displayAttributeOptionLabel(active, field), expectedLabels[index]);
    const payload = ctx.normalizeAttributeForPayload(row.dynamic_attributes[field.attribute_id]);
    assert.deepEqual(payload.values.map(option => option.dictionary_value_id), [Number(index === 2 ? field.value : field.value[0])]);
  });
  assert.equal(JSON.stringify(row), before);
});

test("batch dictionary text cells use each row's current labels", () => {
  const ctx = context(), { fields, row } = fixture();
  assert.equal(ctx.flatSkuAttributeDisplayText(row, fields[0]), "中国");
  assert.equal(ctx.flatSkuAttributeDisplayText(row, fields[1]), "穿孔生态皮革");
  assert.equal(ctx.flatSkuAttributeDisplayText(row, fields[2]), "1 pc");
});

test("multi-selects retain exactly the row selection rather than all candidate options", () => {
  const ctx = context(), { fields, row } = fixture(), field = { ...fields[0], type: "multiselect", is_collection: true };
  field.values.push({ dictionary_value_id: 90297, value: "Russia", label: "俄罗斯" });
  row.dynamic_attributes[4389].values.push(field.values[1]);
  assert.deepEqual(clone(ctx.variantAttributeSelectModelValue(row, field)), ["China"]);
  assert.deepEqual(clone(ctx.inactiveAttributeCellOptions(row, field)).map(option => option.dictionary_value_id), [90296]);
  row.dynamic_attributes[4389].value = [90297];
  row.dynamic_attributes[4389].label = "俄罗斯";
  row.dynamic_attributes[4389].display_value_zh = "俄罗斯";
  assert.deepEqual(clone(ctx.variantAttributeSelectModelValue(row, field)), ["Russia"]);
  ctx.updateVariantAttributeSelectValue(row, field, ["China"]);
  assert.deepEqual(clone(ctx.normalizeAttributeForPayload(row.dynamic_attributes[4389])).values,
    [{ dictionary_value_id: 90296, value: "China" }]);
});

test("unresolved dictionary selections have a neutral label while numeric non-dictionary fields remain readable", () => {
  const ctx = context();
  const field = { attribute_id: 4389, dictionary_id: 1935, type: "select", value: "" };
  const row = { dynamic_attributes: { "4389": { value: 90296 } } };
  const [option] = ctx.inactiveAttributeCellOptions(row, field);
  assert.equal(ctx.displayAttributeOptionLabel(option, field), "待同步字典值");
  assert.equal(ctx.flatSkuAttributeDisplayText(row, field), "待同步字典值");
  assert.equal(ctx.flatSkuAttributeDisplayText({ dynamic_attributes: { "7202": { value: 2 } } }, { attribute_id: 7202, type: "number" }), "2");
});

test("editing a row-only dictionary selection preserves its ID without requiring the shared schema option", () => {
  for (const multiselect of [false, true]) {
    const ctx = context(), { fields } = fixture();
    const field = { ...fields[0], type: multiselect ? "multiselect" : "select", is_collection: multiselect };
    const selected = { dictionary_value_id: 90297, value: "Russia", label: "俄罗斯", display_value_zh: "俄罗斯" };
    const row = { id: "second-draft", dynamic_attributes: { "4389": {
      attribute_id: 4389, value: multiselect ? [90297] : 90297, selected_values: [selected]
    } } };
    const before = JSON.stringify(field);
    const model = ctx.variantAttributeSelectModelValue(row, field);
    assert.deepEqual(clone(model), multiselect ? ["Russia"] : "Russia");
    ctx.updateVariantAttributeSelectValue(row, field, model);
    const payload = clone(ctx.normalizeAttributeForPayload(row.dynamic_attributes[4389]));
    assert.deepEqual(payload.values, [{ dictionary_value_id: 90297, value: "Russia" }]);
    assert.equal(ctx.flatSkuAttributeDisplayText(row, field), "俄罗斯");
    ctx.updateVariantAttributeSelectValue(row, field, multiselect ? ["China"] : "China");
    assert.deepEqual(clone(ctx.normalizeAttributeForPayload(row.dynamic_attributes[4389])).values,
      [{ dictionary_value_id: 90296, value: "China" }]);
    assert.equal(JSON.stringify(field), before);
  }
});

test("an opened row-only selection has one option per model and retains the full dictionary reference", () => {
  const ctx = context(), { fields } = fixture(), field = fields[0];
  const selected = { dictionary_value_id: 90297, value: "Russia", label: "俄罗斯", display_value_zh: "俄罗斯" };
  const row = { id: "second-draft", dynamic_attributes: { "4389": {
    attribute_id: 4389, value: 90297, selected_values: [selected]
  } } };
  const options = clone(ctx.flatSkuAttributeOptions(row, field));
  const matches = options.filter(option => ctx.attributeOptionModelValue(option) === "Russia");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].dictionary_value_id, 90297);
  assert.equal(ctx.displayAttributeOptionLabel(matches[0], field), "俄罗斯");
});

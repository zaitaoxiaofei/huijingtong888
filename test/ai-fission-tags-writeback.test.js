import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const functions = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
  .map(node => source.slice(node.start, node.end)).join("\n");
const clone = value => JSON.parse(JSON.stringify(value));
const oldTags = ["#HAVAL_H3", "#HAVALH3", "#накладки_на_пороги"];
const newTags = ["#HAVAL_F7", "#HAVALF7", "#накладки_на_пороги"];
const options = tags => tags.map(value => ({ value }));
const tagEntry = tags => ({ attribute_id: 23171, name: "产品标签", type: "multiselect", value: tags,
  values: options(tags), selected_values: options(tags), selectedValues: options(tags),
  label: tags.join(" "), display_value_zh: tags.join(" "), displayValueZh: tags.join(" ") });
function fixture() {
  const context = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map(),
    PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish" });
  vm.runInContext(functions, context);
  const original = {
    title: "Накладки HAVAL H3", description: "Накладки для HAVAL H3", images: [],
    tags: oldTags, main_tags: oldTags, hashtags: oldTags,
    attributes: [tagEntry(oldTags)], logistics: { tags: oldTags }, variants: [
      { id: "target", title: "Накладки HAVAL H3", images: [], main_tags: oldTags, tags: oldTags, hashtags: oldTags,
        attributes: [tagEntry(oldTags)],
        dynamic_attributes: { "23171": tagEntry(oldTags), "7199": { attribute_id: 7199, value: "ABS" } },
        dynamicAttributes: { tags: tagEntry(oldTags), material: { attribute_id: 7199, value: "ABS" } } },
      { id: "sibling", title: "Накладки HAVAL H3", images: [], main_tags: oldTags, tags: oldTags, hashtags: oldTags,
        attributes: [tagEntry(oldTags)], dynamic_attributes: { "23171": tagEntry(oldTags) } }
    ]
  };
  return { context, original };
}
const tagAttribute = attributes => attributes.find(attribute => Number(attribute.attribute_id || attribute.id) === 23171);
const tagValues = entry => (Array.isArray(entry.value) ? entry.value : String(entry.value).split(/[,\s]+/)).filter(Boolean);

test("AI fission writes generated tags into all current first-SKU and common tag aliases", () => {
  const { context, original } = fixture(), before = JSON.stringify(original);
  const result = context.applyAiVariantDraftPatch(original, {
    title: "Накладки HAVAL F7", description: "Накладки для HAVAL F7", tags: newTags
  });
  for (const owner of [result, result.variants[0]]) {
    for (const key of ["tags", "main_tags", "hashtags"]) assert.deepEqual(clone(owner[key]), newTags, key);
    assert.deepEqual(clone(tagValues(tagAttribute(owner.attributes))), newTags);
  }
  assert.deepEqual(clone(result.logistics.tags), newTags);
  assert.equal(result.variants[0].title, "Накладки HAVAL F7");
  assert.equal(result.variants[0].description, "Накладки для HAVAL F7");
  assert.deepEqual(clone(result.variants[1]), original.variants[1]);
  assert.equal(JSON.stringify(original), before);
});

test("tag dynamic aliases replace stale selected values and display labels without touching other attributes", () => {
  const { context, original } = fixture();
  const result = context.applyAiVariantDraftPatch(original, { hashtags: newTags });
  const target = result.variants[0];
  for (const map of [target.dynamic_attributes, target.dynamicAttributes]) {
    for (const entry of Object.values(map).filter(entry => Number(entry.attribute_id || entry.id) === 23171)) {
      assert.deepEqual(clone(tagValues(entry)), newTags);
      for (const key of ["values", "selected_values", "selectedValues"]) assert.deepEqual(clone(entry[key]).map(option => option.value), newTags, key);
      for (const key of ["label", "display_value_zh", "displayValueZh"]) assert.equal(entry[key], newTags.join(" "), key);
    }
  }
  assert.deepEqual(clone(target.dynamic_attributes["7199"]), original.variants[0].dynamic_attributes["7199"]);
  assert.deepEqual(clone(target.dynamicAttributes.material), original.variants[0].dynamicAttributes.material);
});

test("a source SKU without a dynamic tag entry gains a current 23171 tag selection", () => {
  const { context, original } = fixture();
  delete original.variants[0].dynamic_attributes;
  delete original.variants[0].dynamicAttributes;
  const result = context.applyAiVariantDraftPatch(original, { tags: newTags });
  assert.deepEqual(clone(tagValues(result.variants[0].dynamic_attributes["23171"])), newTags);
  assert.deepEqual(clone(tagValues(tagAttribute(result.variants[0].attributes))), newTags);
});

test("omitted or empty tag patches preserve existing tag values and aliases", () => {
  for (const patch of [{}, { tags: [] }, { tags: "" }, { hashtags: [] }]) {
    const { context, original } = fixture();
    const result = context.applyAiVariantDraftPatch(original, patch);
    for (const owner of [result, result.variants[0]]) {
      for (const key of ["tags", "main_tags", "hashtags"]) assert.deepEqual(clone(owner[key]), oldTags);
    }
    assert.deepEqual(clone(result.variants[0].dynamic_attributes), original.variants[0].dynamic_attributes);
    assert.deepEqual(clone(result.variants[0].dynamicAttributes), original.variants[0].dynamicAttributes);
    assert.deepEqual(clone(result.variants[1]), original.variants[1]);
  }
});

test("the final snapshot and Ozon publish preview retain target tags rather than mother-SKU tags", () => {
  const { context, original } = fixture();
  const patched = context.applyAiVariantDraftPatch(original, { title: "Накладки HAVAL F7", description: "Накладки для HAVAL F7", tags: newTags });
  const merged = context.mergeAiVariantTemplateSnapshot({ editable_payload: original }, { editable_payload: patched });
  const editable = merged.editable_payload;
  const facts = { ...editable, tags: editable.tags, price: {}, dimensions: {}, descriptionCategoryId: 1, typeId: 2 };
  const preview = context.buildOzonImportPreviewPayload(facts);
  assert.deepEqual(clone(preview.items[0].tags), newTags);
  const targetAttribute = preview.items[0].attributes.find(attribute => Number(attribute.id) === 23171);
  assert.deepEqual(clone(targetAttribute.values).flatMap(option => String(option.value).split(/[,\s]+/)), newTags);
  assert.deepEqual(clone(preview.items[1].tags), oldTags);
});

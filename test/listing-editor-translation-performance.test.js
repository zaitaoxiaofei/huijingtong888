import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");

function functionBody(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("listing editor dictionary labels use selected cached labels first", () => {
  assert.match(source, /function attributeOptionLabel\(option = \{\}\)/);
  assert.match(functionBody("renderedAttributeOptions"), /field\.selected_values/);
  assert.match(functionBody("renderedAttributeOptions"), /field\.selectedValues/);
  assert.match(functionBody("attributeOptionLabel"), /display_value_zh/);
});

test("variant option rendering does not expand full dictionaries eagerly", () => {
  assert.match(functionBody("variantDictionaryOptions"), /renderedAttributeOptions\(field\)/);
  assert.match(functionBody("renderedAttributeOptions"), /field\.selected_values/);
  assert.match(functionBody("renderedAttributeOptions"), /slice\(0, ATTRIBUTE_OPTION_RENDER_LIMIT\)/);
});

test("dictionary selects display Chinese labels without changing Ozon values", () => {
  assert.match(source, /function attributeOptionLabel\(option = \{\}\)/);
  assert.match(functionBody("attributeOptionLabel"), /display_value_zh/);
  assert.match(functionBody("attributeOptionLabel"), /candidates\.find\(hasChineseText\)/);
  assert.match(source, /:label="attributeOptionLabel\(option\)" :value="option\.value"/);
  assert.doesNotMatch(source, /:value="attributeOptionLabel\(option\)"/);
});

test("variant titles can copy the first row from row and batch actions", () => {
  assert.match(source, /function applyFirstVariantTitleToRow\(row\)/);
  assert.match(functionBody("applyFirstVariantTitleToRow"), /row\.title = cloneVariantValue\(first\.title\)/);
  assert.match(source, /标题同首行/);
  assert.match(source, /@click="applyFirstVariantTitleToRow\(row\)"/);
  assert.match(source, /class="variant-title-cell"/);
});

test("local offer ids include source shop and random tokens", () => {
  const body = functionBody("generateLocalOfferId");
  assert.match(body, /offerIdSourceToken\(row\)/);
  assert.match(body, /offerIdShopToken\(\)/);
  assert.match(body, /offerIdRandomToken\(4\)/);
  assert.doesNotMatch(body, /const suffix = String\(index \+ offset \+ 1\)\.padStart\(3, "0"\)/);
  assert.match(source, /generateLocalOfferId\(existingIds, templateEditor\.variants\.indexOf\(row\), row\)/);
});

test("all Ozon attributes can be moved into variant overrides", () => {
  assert.match(source, /const variantAttributeFields = computed\(\(\) => templateEditor\.attributes\.filter\(\(field\) => isVariantAttributeField\(field\)\)\)/);
  assert.match(source, /function variantAttributeModeKey\(field = \{\}\)/);
  assert.match(source, /function setVariantAttributeValue\(row = \{\}, field = \{\}, value\)/);
  assert.match(source, /v-for="field in variantAttributeFields"/);
  assert.match(source, /setVariantAttributeValue\(row, field, \$event\)/);
  assert.match(source, /applyFirstVariantAttribute\(field\)/);
  assert.match(source, /disableVariantAttribute\(field\)/);
});

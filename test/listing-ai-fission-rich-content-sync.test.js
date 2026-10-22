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
const oldMain = "https://media.example/source.jpg", newMain = "https://media.example/generated.jpg";
const detailImage = "https://media.example/detail.jpg";
const rich = image => JSON.stringify({ version: 0.3, content: [{ widgetName: "custom-layout", title: "Preserve this title", blocks: [
  { img: { src: image, srcMobile: image, alt: "main", widthMobile: 1024 }, text: { value: "Operator text" } },
  { img: { src: detailImage, srcMobile: detailImage }, custom: [1, 2] }
] }] });
function fixture() {
  const context = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map() });
  vm.runInContext(functions, context);
  const original = {
    images: [oldMain, detailImage], rich_content_json: rich(oldMain),
    attributes: [{ attribute_id: 11254, value: rich(oldMain) }], variants: [
      { id: "target", images: [oldMain, detailImage], rich_content_json: rich(oldMain),
        attributes: [{ attribute_id: 11254, value: rich(oldMain) }], dynamic_attributes: { "11254": { attribute_id: 11254, value: rich(oldMain) } } },
      { id: "sibling", images: ["https://media.example/sibling.jpg"], rich_content_json: "sibling-rich", dynamic_attributes: { "11254": { value: "sibling-rich" } } }
    ]
  };
  return { context, original };
}
const attributeRich = value => value.attributes.find(item => Number(item.attribute_id || item.id) === 11254)?.value;
function assertSynced(value, expected) {
  const variant = value.variants[0];
  for (const content of [value.rich_content_json, value.richContentJson, attributeRich(value),
    variant.rich_content_json, variant.richContentJson, attributeRich(variant), variant.dynamic_attributes["11254"].value,
    variant.dynamicAttributes["11254"].value]) assert.equal(content, expected);
}

test("AI fission patch updates target variant rich content together with the generated primary image", () => {
  const { context, original } = fixture(), before = JSON.stringify(original);
  const result = context.applyAiVariantDraftPatch(original, { images: [newMain, detailImage], rich_content_json: rich(newMain) });
  assert.equal(result.variants[0].images[0].url, newMain);
  assertSynced(result, rich(newMain));
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(clone(result.variants[1]), original.variants[1]);
});

test("inherited manual rich layout keeps text, detail images and sibling variants", () => {
  const { context, original } = fixture();
  const result = context.applyAiVariantDraftPatch(original, { images: [newMain, detailImage] });
  assertSynced(result, rich(newMain));
  assert.deepEqual(JSON.parse(result.rich_content_json), JSON.parse(rich(newMain)));
  assert.deepEqual(clone(result.variants[1]), original.variants[1]);
});

test("all existing rich field and dynamic aliases are synchronized without retaining stale selections", () => {
  const { context, original } = fixture();
  const target = original.variants[0];
  target.richContentJson = rich(oldMain); target.rich_content = rich(oldMain); target.richContent = rich(oldMain);
  target.dynamicAttributes = { legacy: { id: 11254, value: rich(oldMain), selected_values: [{ value: rich(oldMain) }] } };
  const result = context.applyAiVariantDraftPatch(original, { images: [newMain], richContentJson: rich(newMain) });
  assertSynced(result, rich(newMain));
  assert.equal(result.variants[0].rich_content, rich(newMain));
  assert.equal(result.variants[0].richContent, rich(newMain));
  assert.equal(result.variants[0].dynamicAttributes.legacy.value, rich(newMain));
  assert.equal(result.variants[0].dynamicAttributes.legacy.selected_values[0].value, rich(newMain));
});

test("final snapshot merge cannot restore an old dynamic rich image over the patched content", () => {
  const { context, original } = fixture();
  const patched = context.applyAiVariantDraftPatch(original, { images: [newMain], rich_content_json: rich(newMain) });
  const staleSnapshot = clone(patched);
  staleSnapshot.variants[0].dynamic_attributes["11254"].value = rich(oldMain);
  const merged = context.mergeAiVariantTemplateSnapshot({ editable_payload: patched }, { editable_payload: staleSnapshot });
  const final = context.syncAiVariantDraftRichContent(merged.editable_payload, { richContentJson: patched.rich_content_json });
  assertSynced(final, rich(newMain));
});

test("a manual empty image set remains authoritative and does not regain an inherited main image", () => {
  const { context, original } = fixture();
  original.variants[0].images = []; original.variants[0].images_manually_edited = true;
  const result = context.syncAiVariantDraftRichContent(original, { richContentJson: rich(newMain) });
  assert.deepEqual(clone(result.variants[0].images), []);
  assert.equal(result.rich_content_json, rich(oldMain));
});

test("only first or source-primary image nodes change, retaining custom links and unrelated images", () => {
  const { context, original } = fixture();
  const custom = JSON.parse(rich(oldMain));
  custom.content[0].blocks[0].img.src = "https://media.example/stale-other.jpg";
  custom.content[0].blocks[0].img.srcMobile = custom.content[0].blocks[0].img.src;
  custom.content[0].link = oldMain;
  original.variants[0].rich_content_json = JSON.stringify(custom);
  const result = context.applyAiVariantDraftPatch(original, { images: [newMain] });
  const saved = JSON.parse(result.variants[0].rich_content_json);
  assert.equal(saved.content[0].blocks[0].img.src, newMain);
  assert.equal(saved.content[0].blocks[0].img.srcMobile, newMain);
  assert.equal(saved.content[0].blocks[1].img.src, detailImage);
  assert.equal(saved.content[0].link, oldMain);
});

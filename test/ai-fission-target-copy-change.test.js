import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const functions = parse(script, { ecmaVersion: "latest", sourceType: "module" }).body
  .filter(node => node.type === "FunctionDeclaration" || (node.type === "VariableDeclaration"
    && node.declarations.some(item => /^(UNKNOWN_FACT_RE|INTERNAL_COPY_LEAK_RE|DESCRIPTION_MIN_LENGTH|DESCRIPTION_MAX_LENGTH)$/.test(item.id.name))))
  .map(node => script.slice(node.start, node.end)).join("\n");
function fixture() {
  const context = vm.createContext({ material: { sourceTitle: "Накладки HAVAL H3", sourceDescription: "", sourceTags: "#HAVAL_H3 #HAVALH3",
    sourceVariantValue: "HAVAL H3", productName: "Накладки", targetInput: "HAVAL H9" }, sourceModel: { value: "HAVAL H3" }, state: { analysis: null } });
  vm.runInContext(functions, context);
  return context;
}

test("target replacement handles complete vehicle text in spaced, underscore and compact tags without matching longer model names", () => {
  const ctx = fixture();
  const text = "HAVAL H3, #HAVAL_H3 #havalh3 #HAVAL_H30 #HAVALH30 #OTHER_H3";
  assert.equal(ctx.replaceSpecificVariantText(text, "HAVAL H3", "HAVAL H9"),
    "HAVAL H9, #HAVAL_H9 #HAVALH9 #HAVAL_H30 #HAVALH30 #OTHER_H3");
  assert.equal(ctx.replaceVariantText("#HAVAL_H3 #HAVALH3", "HAVAL H9"), "#HAVAL_H9 #HAVALH9");
});

test("changing a target keeps manually reviewed title and description while replacing all tag spellings", () => {
  const ctx = fixture();
  const description = "Накладки для HAVAL H3 с проверенной матовой поверхностью. " +
    "Аксессуар помогает сохранить аккуратный внешний вид дверных проемов при ежедневном использовании автомобиля и защищает поверхность от повседневных следов обуви. ".repeat(2);
  const row = { target_variant_value: "HAVAL H9", raw: { target_variant_value: "HAVAL H3" }, offerId: "OLD-OFFER",
    titleText: "Накладки HAVAL H3 с проверенной матовой поверхностью", tagsText: "#HAVAL_H3 #HAVALH3 #салон", descriptionText: description };
  ctx.syncRowTarget(row);
  assert.equal(row.titleText, "Накладки HAVAL H9 с проверенной матовой поверхностью");
  assert.equal(row.descriptionText, description.replace("HAVAL H3", "HAVAL H9").trim());
  assert.deepEqual(Array.from(ctx.rowTagsOutput(row)), ["#HAVAL_H9", "#HAVALH9", "#салон"]);
  assert.equal(row.offerId, "");
});

test("source-tag fallback uses the same bounded target replacement rule", () => {
  const ctx = fixture();
  const row = ctx.toPlanRow({ target_variant_value: "HAVAL H9", title_ru: "Накладки HAVAL H9" }, 0);
  const tags = Array.from(ctx.rowTagsOutput(row));
  assert.ok(tags.includes("#HAVAL_H9"));
  assert.ok(tags.includes("#HAVALH9"));
  assert.ok(!tags.some(tag => /H3/.test(tag)));
});

test("hyphenated model identity changes in underscore and compact hashtags while longer models and body spelling stay intact", () => {
  const ctx = fixture();
  const text = "Для MAZDA CX-3: #MAZDA_CX_3 #MAZDACX3 #MAZDA_CX-3 #MAZDA_CX3 #MAZDA_CX_30 #MAZDACX30; MAZDA CX-30, MAZDA CX_3.";
  assert.equal(ctx.replaceSpecificVariantText(text, "MAZDA CX-3", "MAZDA CX-30"),
    "Для MAZDA CX-30: #MAZDA_CX_30 #MAZDACX30 #MAZDA_CX-30 #MAZDA_CX30 #MAZDA_CX_30 #MAZDACX30; MAZDA CX-30, MAZDA CX_3.");
  assert.equal(ctx.replaceSpecificVariantText("#MAZDA_CX_30 #MAZDACX30 MAZDA CX-30", "MAZDA CX-3", "HAVAL H9"),
    "#MAZDA_CX_30 #MAZDACX30 MAZDA CX-30");
  assert.equal(ctx.replaceSpecificVariantText("#для_MAZDA_CX_3 #для_MAZDACX3 #для_MAZDA_CX_30 #для_MAZDACX30 #дляMAZDACX3", "MAZDA CX-3", "MAZDA CX-30"),
    "#для_MAZDA_CX_30 #для_MAZDACX30 #для_MAZDA_CX_30 #для_MAZDACX30 #дляMAZDACX3");
});

test("bare-brand target expansion rewrites each original hashtag once without spaces or duplicated model", () => {
  const ctx = fixture();
  const text = "Для JAECOO: #JAECOO #для_JAECOO #для-JAECOO; JAECOO J6 #JAECOOJ6 #JAECOO_J6 #для_JAECOO_J6 #JAECOOJ60";
  const expected = "Для JAECOO J6: #JAECOOJ6 #для_JAECOOJ6 #для-JAECOOJ6; JAECOO J6 #JAECOOJ6 #JAECOO_J6 #для_JAECOO_J6 #JAECOOJ60";
  const actual = ctx.replaceSpecificVariantText(text, "JAECOO", "JAECOO J6");
  assert.equal(actual, expected);
  assert.equal(ctx.replaceSpecificVariantText(actual, "JAECOO", "JAECOO J6"), expected);
});

test("target extending source model is protected in body and every hashtag spelling", () => {
  const ctx = fixture();
  const text = "HAVAL H3; #HAVAL_H3 #HAVALH3 #HAVAL-H3 #для_HAVAL_H3; HAVAL H3 Pro, HAVALH3Pro #HAVAL_H3_Pro #HAVALH3Pro #HAVAL-H3-Pro #для_HAVAL_H3_Pro; HAVAL H30 #HAVAL_H30 #HAVALH30";
  const expected = "HAVAL H3 Pro; #HAVAL_H3_Pro #HAVALH3Pro #HAVAL-H3-Pro #для_HAVAL_H3_Pro; HAVAL H3 Pro, HAVALH3Pro #HAVAL_H3_Pro #HAVALH3Pro #HAVAL-H3-Pro #для_HAVAL_H3_Pro; HAVAL H30 #HAVAL_H30 #HAVALH30";
  const actual = ctx.replaceSpecificVariantText(text, "HAVAL H3", "HAVAL H3 Pro");
  assert.equal(actual, expected);
  assert.equal(ctx.replaceSpecificVariantText(actual, "HAVAL H3", "HAVAL H3 Pro"), expected);
});

test("bare-brand expansion keeps hashtag identities with an unknown model suffix intact", () => {
  const ctx = fixture();
  assert.equal(ctx.replaceSpecificVariantText("#JAECOO #для_JAECOO #JAECOO_J7 #JAECOO_J60 #JAECOO-J60 #для_JAECOO_J7 #JAECOO_J6 #салон", "JAECOO", "JAECOO J6"),
    "#JAECOOJ6 #для_JAECOOJ6 #JAECOO_J7 #JAECOO_J60 #JAECOO-J60 #для_JAECOO_J7 #JAECOO_J6 #салон");
});

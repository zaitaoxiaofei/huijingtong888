import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");
const functions = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node)
  .filter(node => node.type === "FunctionDeclaration" || node.type === "VariableDeclaration"
    && node.declarations.some(item => /^(UNKNOWN_FACT_RE|INTERNAL_COPY_LEAK_RE)$/.test(item.id.name)))
  .map(node => source.slice(node.start, node.end)).join("\n");
function fixture() {
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  return context;
}
const analysis = { source_variant_value: "HAVAL H3", product_subject_ru: "Чехол для ключа", product_type: "key case" };
const fallback = { sourceVariantValue: "HAVAL H3" };

test("source-vehicle checking detects spaced, underscored and compact known identities in tags", () => {
  const ctx = fixture();
  for (const text of ["HAVAL H3", "#HAVAL_H3", "#havalh3", "#для_HAVAL_H3"]) {
    assert.equal(ctx.hasVariantSourceLeak(text, "HAVAL F7", analysis, fallback), true, text);
  }
});

test("short source model H3 remains detectable while H30 and longer distinct model tokens do not match", () => {
  const ctx = fixture(), short = { source_variant_value: "H3" };
  for (const text of ["H3", "#H3", "#для_H3"]) assert.equal(ctx.hasVariantSourceLeak(text, "F7", short), true, text);
  for (const text of ["H30", "#H30", "#для_H30", "#H3X"]) assert.equal(ctx.hasVariantSourceLeak(text, "F7", short), false, text);
});

test("only evidenced source identities match, preserving distinct brands, longer models and generic tags", () => {
  const ctx = fixture();
  for (const text of ["#HAVAL_H30", "#HAVALH30", "#HAVAL_H3X", "#OTHER_H3", "#защита_порогов", "#салон_авто"]) {
    assert.equal(ctx.hasVariantSourceLeak(text, "HAVAL F7", analysis, fallback), false, text);
  }
});

test("tag normalization removes source spellings and keeps target and generic AI tags", () => {
  const ctx = fixture();
  const tags = Array.from(ctx.normalizeOzonVariantTags([
    "#HAVAL_H3", "#HAVALH3", "HAVAL H3", "#для_HAVAL_H3", "#защита_порогов", "#уникальный_аксессуар"
  ], "HAVAL F7", analysis, fallback));
  assert.ok(tags.includes("#HAVAL_F7"));
  assert.ok(tags.includes("#HAVALF7"));
  assert.ok(tags.includes("#защита_порогов"));
  assert.ok(tags.includes("#уникальный_аксессуар"));
  assert.ok(!tags.some(tag => /H3/i.test(tag)), JSON.stringify(tags));
  assert.equal(ctx.hasVariantSourceLeak(tags.join(" "), "HAVAL F7", analysis, fallback), false);
});

test("fallback tag candidates cannot reintroduce known source tags after AI tags were filtered", () => {
  const ctx = fixture();
  const tags = Array.from(ctx.buildOzonVariantTags("HAVAL F7", analysis, {
    ...fallback, extraTags: ["#HAVAL_H3", "#HAVALH3", "#защита_порогов"]
  }));
  assert.ok(tags.includes("#HAVAL_F7"));
  assert.ok(tags.includes("#защита_порогов"));
  assert.ok(!tags.some(tag => /H3/i.test(tag)), JSON.stringify(tags));
});

test("same source and target identity is retained across case and tag separator spellings", () => {
  const ctx = fixture();
  for (const target of ["HAVAL H3", "haval_h3", "HAVALH3"]) {
    const tags = Array.from(ctx.normalizeOzonVariantTags(["#HAVAL_H3", "#HAVALH3", "#салон"], target, analysis, fallback));
    assert.ok(tags.some(tag => tag.toLowerCase() === "#haval_h3"), target);
    assert.ok(tags.some(tag => tag.toLowerCase() === "#havalh3"), target);
    assert.ok(tags.includes("#салон"), target);
    assert.equal(ctx.hasVariantSourceLeak(tags.join(" "), target, analysis, fallback), false, target);
  }
});

test("an explicitly supplied short source model does not reject the same model within the target", () => {
  const ctx = fixture(), withShortModel = { ...analysis, source_vehicle_model: "H3" };
  for (const target of ["HAVAL H3", "HAVAL_H3", "HAVALH3"]) {
    assert.equal(ctx.hasVariantSourceLeak("#HAVAL_H3 #HAVALH3 #H3", target, withShortModel, fallback), false, target);
  }
  assert.equal(ctx.hasVariantSourceLeak("#H3", "HAVAL F7", withShortModel, fallback), true);
});

test("complete prefix-model targets are allowed while a separate source identity still fails", () => {
  const ctx = fixture();
  for (const [sourceModel, target, texts] of [
    ["HAVAL H3", "HAVAL H3 Pro", ["HAVAL H3 Pro", "#HAVAL_H3_Pro", "#HAVALH3Pro"]],
    ["RAV4", "RAV4 Prime", ["RAV4 Prime", "#RAV4_Prime", "#RAV4Prime"]]
  ]) {
    const facts = { source_variant_value: sourceModel };
    for (const text of texts) assert.equal(ctx.hasVariantSourceLeak(text, target, facts), false, text);
    for (const text of texts) assert.equal(ctx.hasVariantSourceLeak(`${text} #${sourceModel.replace(/ /g, "_")}`, target, facts), true, text);
  }
  const tags = Array.from(ctx.buildOzonVariantTags("HAVAL H3 Pro", { ...analysis, source_vehicle_model: "H3" }, fallback));
  assert.ok(tags.includes("#HAVAL_H3_Pro"));
  assert.ok(tags.includes("#HAVALH3Pro"));
  assert.ok(tags.includes("#для_H3_Pro"));
  assert.equal(ctx.hasVariantSourceLeak(tags.join(" "), "HAVAL H3 Pro", { ...analysis, source_vehicle_model: "H3" }, fallback), false);
});

test("hyphenated source models match their actual underscore and compact tag spellings without matching longer models", () => {
  const ctx = fixture(), facts = { source_variant_value: "MAZDA CX-3" };
  for (const text of ["MAZDA CX-3", "#MAZDA_CX_3", "#MAZDACX3", "#для_MAZDA_CX_3"]) {
    assert.equal(ctx.hasVariantSourceLeak(text, "MAZDA CX-30", facts), true, text);
  }
  for (const text of ["MAZDA CX-30", "#MAZDA_CX_30", "#MAZDACX30", "#OTHER_CX_3", "#салон"]) {
    assert.equal(ctx.hasVariantSourceLeak(text, "MAZDA CX-30", facts), false, text);
  }
  const tags = Array.from(ctx.normalizeOzonVariantTags(["#MAZDA_CX_3", "#MAZDACX3", "#салон"], "MAZDA CX-30", { ...analysis, ...facts }));
  assert.ok(tags.includes("#MAZDA_CX_30"));
  assert.ok(tags.includes("#салон"));
  assert.ok(!tags.includes("#MAZDA_CX_3"));
  assert.ok(!tags.includes("#MAZDACX3"));
});

test("hyphenated prefix targets remain valid after tag normalization while independent old tags still fail", () => {
  const ctx = fixture(), target = "HAVAL H3-Pro";
  for (const text of ["HAVAL H3-Pro", "#HAVAL_H3_Pro", "#HAVALH3Pro", "#для_HAVAL_H3_Pro"]) {
    assert.equal(ctx.hasVariantSourceLeak(text, target, analysis, fallback), false, text);
    assert.equal(ctx.hasVariantSourceLeak(`${text} #HAVAL_H3`, target, analysis, fallback), true, text);
  }
  const tags = Array.from(ctx.buildOzonVariantTags(target, { ...analysis, source_vehicle_model: "H3" }, fallback));
  assert.ok(tags.includes("#HAVAL_H3_Pro"));
  assert.ok(tags.includes("#для_H3_Pro"));
  assert.equal(ctx.hasVariantSourceLeak(tags.join(" "), target, { ...analysis, source_vehicle_model: "H3" }, fallback), false);
});

test("generated maker/model wrappers follow an evidenced full source identity across brands", () => {
  const ctx = fixture(), facts = { ...analysis, source_variant_value: "BELGEE X70" }, options = { sourceVariantValue: "BELGEE X70" };
  const oldTags = Array.from(ctx.buildOzonVariantTags("BELGEE X70", facts, options));
  assert.ok(oldTags.includes("#для_BELGEE")); assert.ok(oldTags.includes("#для_X70"));
  for (const tag of ["#для_BELGEE", "#для_X70", "#для_x70"]) assert.equal(ctx.hasVariantSourceLeak(tag, "UAZ Profi", facts, options), true, tag);
  const generic = ["#для_X700", "#для_OTHER_X70", "#для_BELGEE_аксессуары", "#X70", "#BELGEE", "#салон"];
  for (const tag of [...generic, "BELGEE", "X70"]) assert.equal(ctx.hasVariantSourceLeak(tag, "UAZ Profi", facts, options), false, tag);
  for (const tags of [ctx.normalizeOzonVariantTags([...oldTags, ...generic], "UAZ Profi", facts, options),
    ctx.buildOzonVariantTags("UAZ Profi", facts, { ...options, extraTags: ["#для_BELGEE", "#для_X70", "#салон"] })]) {
    const result = Array.from(tags);
    assert.ok(result.includes("#для_UAZ")); assert.ok(result.includes("#для_Profi")); assert.ok(result.includes("#салон"));
    assert.ok(!result.includes("#для_BELGEE")); assert.ok(!result.includes("#для_X70"));
    assert.equal(ctx.hasVariantSourceLeak(result.join(" "), "UAZ Profi", facts, options), false);
  }
});

test("canonical wrappers preserve shared maker/model tails and complete longer target wrappers", () => {
  const ctx = fixture();
  for (const [sourceModel, target, retained, removed] of [
    ["HAVAL H3", "HAVAL F7", ["#для_HAVAL", "#для_F7"], ["#для_H3"]],
    ["HAVAL H3", "HAVAL H3 Pro", ["#для_HAVAL", "#для_H3_Pro"], ["#для_H3"]],
    ["HAVAL H3", "HAVAL H3Pro", ["#для_HAVAL", "#для_H3Pro"], ["#для_H3"]],
    ["BELGEE X70", "UAZ X70", ["#для_UAZ", "#для_X70"], ["#для_BELGEE"]],
    ["BELGEE X70", "BELGEE X700", ["#для_BELGEE", "#для_X700"], ["#для_X70"]],
    ["MAZDA CX-3", "MAZDA CX-30", ["#для_MAZDA", "#для_CX_30"], ["#для_CX_3"]]
  ]) {
    const facts = { ...analysis, source_variant_value: sourceModel }, options = { sourceVariantValue: sourceModel };
    for (const tag of retained) assert.equal(ctx.hasVariantSourceLeak(tag, target, facts, options), false, `${sourceModel}→${target}: ${tag}`);
    for (const tag of removed) assert.equal(ctx.hasVariantSourceLeak(tag, target, facts, options), true, `${sourceModel}→${target}: ${tag}`);
    const tags = Array.from(ctx.normalizeOzonVariantTags([...retained, ...removed], target, facts, options));
    retained.forEach(tag => assert.ok(tags.includes(tag), tag)); removed.forEach(tag => assert.ok(!tags.includes(tag), tag));
  }
  assert.equal(ctx.hasVariantSourceLeak("#для_BELGEE #для_X70", "UAZ Profi", { source_vehicle_model: "BELGEE X70" }), false, "Do not infer wrappers from arbitrary source aliases");
  for (const [sourceModel, target, tags] of [["HAVAL H3", "HAVALH3", "#для_HAVAL #для_H3"], ["MAZDA CX-3", "MAZDACX3", "#для_MAZDA #для_CX_3"]]) {
    assert.equal(ctx.hasVariantSourceLeak(tags, target, { source_variant_value: sourceModel }), false, "Same complete vehicle identity stays unchanged");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMaterialAnalysis, validateMaterialPlan, validateMaterialReview, createMaterialCopyValidator
} from "../src/services/ai-credit-material-contracts.js";

function analysis() {
  return {
    product_type: "雨刮底座保护垫", visible_texts: ["HAVAL H9"], keep_facts: ["商品为黑色保护垫"],
    current_problems: ["背景过于杂乱"], improvement_opportunities: ["突出商品轮廓"],
    forbidden_changes: ["不得新增配件"], optimization_goals: ["提高主图可读性"], quality_risks: [], confidence: 0.8,
    decision_context: {
      exact_product_subtype: "雨刮底座保护垫", target_buyer_or_compatibility: "HAVAL H9", purchase_decision_order: ["确认适配车型", "确认商品用途", "确认安装位置"],
      verified_differentiators: [], visual_category: "automotive_protection", price_positioning: "mainstream", communication_tone: "clear_commercial"
    },
    display_zh: { recognition_summary: "已识别为雨刮底座保护垫", product_type: "保护垫", fixed_facts: ["商品数量为两个"],
      main_image_observation: "主体清晰", detail_image_observation: "未提供详情图", recommended_action: "保留商品并调整光线" }
  };
}

function plan() {
  const roles = ["main", "material", "installation", "structure"];
  return {
    optimization_type: "main_image_conversion_optimization", keep_facts: ["保持同一商品"], current_problems: [],
    optimization_goals: ["突出已确认商品主体"], forbidden_changes: ["不得修改商品数量"],
    copy_strategy: { exact_subject_ru: "Защитные накладки на основание дворников", title_information_order: ["精确商品名称", "适配车型"],
      verified_benefits_ru: ["Защита от пыли"], forbidden_generic_phrases_ru: ["Высокое качество"], per_shot_message_rules: ["每张图说明一个已确认事实"] },
    visual_language: { tone: "clear", headline_style: "product_specific", hierarchy: ["identity", "compatibility"], font_weights: 2,
      accent_style: "restrained", alignment: "composition_led", max_headline_lines: 2, max_benefit_words: 5, avoid: ["重复装饰"] },
    main_overlay_ru: { title_ru: "Накладки на основание дворников", compatibility_ru: "", benefits_ru: ["Защита от пыли", "Аккуратный внешний вид"] },
    main_visual_directions: [
      { title_zh: "明亮棚拍", direction_en: "Use bright studio light with a neutral background." },
      { title_zh: "深色场景", direction_en: "Use a dark background and controlled depth." }
    ],
    suite_storyboard: roles.map(role => ({ role, title_zh: "真实商品展示", objective_zh: "说明已经确认的商品特点", composition_en: "Keep the product clearly visible.",
      must_show_en: "Show only verified product details.", overlay_text_ru: "Защита от пыли", typography_role: role,
      typography_direction_en: "Keep the heading readable without covering the product." })),
    image_optimization_prompt_en: "Preserve the exact source product and improve its lighting.", negative_prompt_en: "Do not invent accessories or claims.",
    title_improvement_prompt_ru: "Сохранить точное название товара.", tags_improvement_prompt_ru: "Использовать проверенные свойства товара.",
    description_improvement_prompt_ru: "Описать только подтвержденные факты.", quality_checks: ["核对商品身份"], cost_policy: { dry_run_first: true },
    display_zh: { main_image_plan: "保留主体并提升光线", detail_image_plan: "说明已确认细节", title_plan: "保留精确商品主体", tags_plan: "使用明确关键词", description_plan: "只说明已确认事实",
      forbidden_changes: ["不得新增承诺"], quality_checks: ["检查商品数量"], suite_storyboard: ["主图展示完整商品", "详情图展示真实结构"] }
  };
}

function review(pass = true) {
  return { pass, score: pass ? 90 : 60, issues_zh: pass ? [] : ["商品数量与参考图不一致"],
    corrections_en: pass ? "" : "Restore the exact verified component count.", checks: { identity_preserved: pass } };
}

const facts = { product_title_zh: "雨刮底座保护垫", compatibility_zh: ["HAVAL H9"],
  selling_points_zh: ["保护雨刮底座", "保持商品区域整洁"], confirmed_by_operator: true };
const draft = { id: 32, product_name: "Защитные накладки на основание дворников HAVAL H9, 2 шт, резина" };
function copy() {
  return {
    titles: ["Защитные накладки на основание дворников HAVAL H9, резина, 2 шт.", "Накладки для основания дворников HAVAL H9, комплект 2 шт. из резины"],
    tags: ["#накладки", "#дворники", "#основание", "#резина", "#защита", "#пыль", "#листья", "#уход", "#чистота", "#автомобиль", "#комплект", "#машина", "#детали", "#практично", "#HAVAL_H9"],
    description: "Защитные накладки на основание дворников HAVAL H9 изготовлены из резины, комплект 2 шт. "
      + "Описание сохраняет проверенные свойства товара и его исходное назначение. ".repeat(17),
    titleZh: "HAVAL H9 雨刮底座保护垫，橡胶，两个装", tagsZh: Array.from({ length: 15 }, (_, index) => `商品标签中文释义${index + 1}`),
    descriptionZh: "该保护垫用于已确认车型的雨刮底座区域，保留原商品材质和数量，描述只使用已经确认的商品事实。"
  };
}

for (const [name, validate, fixture] of [
  ["analysis", validateMaterialAnalysis, analysis], ["plan", validateMaterialPlan, plan], ["review", validateMaterialReview, review]
]) {
  test(`${name} accepts its complete original provider JSON`, () => assert.equal(validate(JSON.stringify(fixture())), true));
  for (const [label, content] of [["empty", ""], ["malformed", "not JSON"], ["fenced", `\u0060\u0060\u0060json\n${JSON.stringify(fixture())}\n\u0060\u0060\u0060`], ["array", "[]"], ["null", "null"], ["empty object", "{}"], ["object instead of provider text", fixture()]]) {
    test(`${name} rejects ${label} without invoking legacy fallback`, () => assert.equal(validate(content), false));
  }
  test(`${name} rejects a flagged parse fallback even with valid fields`, () => {
    assert.equal(validate(JSON.stringify({ ...fixture(), parse_error: true })), false);
    assert.equal(validate(JSON.stringify({ ...fixture(), fallback: true })), false);
  });
  test(`${name} rejects replacement characters in any result field`, () => assert.equal(validate(JSON.stringify({ ...fixture(), extra: "bad\uFFFDtext" })), false));
}

test("analysis does not force invented material, quantity, compatibility or risk", () => {
  const value = analysis();
  value.visible_texts = []; value.decision_context.target_buyer_or_compatibility = ""; value.quality_risks = [];
  assert.equal(validateMaterialAnalysis(JSON.stringify(value)), true);
});
test("analysis requires raw Chinese recognition and complete decision/display fields", () => {
  for (const change of [value => { delete value.product_type; }, value => { value.product_type = "car accessory"; },
    value => { value.decision_context.purchase_decision_order = []; }, value => { delete value.display_zh.recommended_action; },
    value => { value.keep_facts = [false]; }, value => { value.confidence = "0.8"; }]) {
    const value = analysis(); change(value); assert.equal(validateMaterialAnalysis(JSON.stringify(value)), false);
  }
});

test("plan rejects a missing prompt, fallback directions, or repaired storyboard", () => {
  for (const change of [value => { delete value.image_optimization_prompt_en; }, value => { value.main_visual_directions = []; },
    value => { value.suite_storyboard[0].role = "benefit"; }, value => { value.suite_storyboard[1].overlay_text_ru = ""; },
    value => { value.suite_storyboard[1].role = "unsupported"; }, value => { value.main_overlay_ru.benefits_ru = []; },
    value => { value.suite_storyboard = value.suite_storyboard.slice(0, 3); }, value => { value.visual_language.font_weights = "2"; }]) {
    const value = plan(); change(value); assert.equal(validateMaterialPlan(JSON.stringify(value)), false);
  }
});
test("plan checks technical, operator and buyer-facing language separately", () => {
  for (const change of [value => { value.main_overlay_ru.title_ru = "保护垫"; }, value => { value.main_visual_directions[0].direction_en = "改成明亮背景"; },
    value => { value.display_zh.main_image_plan = "Improve clarity"; }, value => { value.suite_storyboard[1].overlay_text_ru = "Ozon защита товара"; },
    value => { value.suite_storyboard[1].overlay_text_ru = "This is English"; }]) {
    const value = plan(); change(value); assert.equal(validateMaterialPlan(JSON.stringify(value)), false);
  }
});

test("an explicit negative image review is a completed verdict rather than a provider failure", () => assert.equal(validateMaterialReview(JSON.stringify(review(false))), true));
test("review does not infer pass from a high score or enforce a subjective score threshold", () => {
  const value = review(); delete value.pass;
  assert.equal(validateMaterialReview(JSON.stringify(value)), false);
  assert.equal(validateMaterialReview(JSON.stringify({ ...review(), score: 0 })), true);
  assert.equal(validateMaterialReview(JSON.stringify({ ...review(false), score: 100 })), true);
});
test("review requires explicit verdict, numeric score, and actionable negative reasons", () => {
  for (const change of [value => { value.pass = "false"; }, value => { value.score = "90"; }, value => { value.score = 101; },
    value => { value.score = null; }, value => { delete value.checks; }, value => { value.issues_zh = []; },
    value => { value.corrections_en = ""; }, value => { value.corrections_en = "恢复正确数量"; }]) {
    const value = review(false); change(value); assert.equal(validateMaterialReview(JSON.stringify(value)), false);
  }
});

test("copy validates original Russian bundle against a reviewed subject and full Chinese translations", () => {
  assert.equal(createMaterialCopyValidator({ draft, operatorFacts: facts })(JSON.stringify(copy())), true);
});
test("copy blocks an unsupported product before a supplier request could start", () => {
  assert.throws(() => createMaterialCopyValidator({ draft: { product_name: "Настольная лампа" }, operatorFacts: facts }),
    error => error.code === "AI_CREDIT_CAPABILITY_DISABLED" && error.status === 409);
});
test("copy requires explicit operator confirmation", () => {
  const validate = createMaterialCopyValidator({ draft, operatorFacts: { ...facts, confirmed_by_operator: false } });
  assert.equal(validate(JSON.stringify(copy())), false);
});
test("copy gives confirmed compatibility priority over a stale source model", () => {
  const validate = createMaterialCopyValidator({ draft: { ...draft, product_name: draft.product_name.replace("HAVAL H9", "TENET T4") }, operatorFacts: facts });
  assert.equal(validate(JSON.stringify(copy())), true);
  assert.equal(validate(JSON.stringify({ ...copy(), titles: copy().titles.map(title => title.replace("HAVAL H9", "TENET T4")) })), false);
});
test("copy rejects unrelated product, missing material and quantity, including one wrong title", () => {
  const validate = createMaterialCopyValidator({ draft, operatorFacts: facts });
  for (const change of [value => { value.titles[0] = "Автоаксессуар HAVAL H9"; },
    value => { value.titles[1] = "Чехол для ключа HAVAL H9, резина, 2 шт."; },
    value => { value.description += " Накладки на пороги автомобиля."; },
    value => { value.titles = value.titles.map(title => title.replace(/резин[аы]/gu, "металл")); value.tags[3] = "#металл"; value.description = value.description.replace("резины", "металла"); },
    value => { value.titles = value.titles.map(title => title.replace(/2/gu, "3")); value.description = value.description.replace("2 шт.", "3 шт."); }]) {
    const value = copy(); change(value); assert.equal(validate(JSON.stringify(value)), false);
  }
});
test("copy cannot hide a bumper title behind shared pad wording and correct wiper description", () => {
  const validate = createMaterialCopyValidator({ draft, operatorFacts: facts });
  const value = copy();
  value.titles[0] = "Защитная накладка на бампер HAVAL H9, резина, 2 шт.";
  assert.equal(validate(JSON.stringify(value)), false);
});
test("copy rejects fields that old normalizers would silently fill or coerce", () => {
  const validate = createMaterialCopyValidator({ draft, operatorFacts: facts });
  for (const change of [value => { delete value.titles; }, value => { value.titles[0] = {}; }, value => { value.tags = []; },
    value => { value.description = ""; }, value => { value.titleZh = ""; }, value => { value.descriptionZh = ""; },
    value => { value.tagsZh.pop(); }, value => { value.tagsZh[0] = "защита"; }, value => { value.descriptionZh = "中文附带未翻译的 Описание"; }]) {
    const value = copy(); change(value); assert.equal(validate(JSON.stringify(value)), false);
  }
});
test("copy requires Russian language, unique hashtag syntax and existing prompt lengths", () => {
  const validate = createMaterialCopyValidator({ draft, operatorFacts: facts });
  for (const change of [value => { value.titles[0] = "保护垫 HAVAL H9"; }, value => { value.titles[0] = "A cover for HAVAL H9"; },
    value => { value.tags[1] = value.tags[0]; }, value => { value.tags[1] = "#НАКЛАДКИ"; }, value => { value.tags[0] = "not_a_tag"; },
    value => { value.tags[0] = "#Premium"; }, value => { value.tags[0] = "#中文"; }, value => { value.description = "Короткое описание"; },
    value => { value.description = "Описание ".repeat(251); }, value => { value.titleZh = "坏\uFFFD字符"; }]) {
    const value = copy(); change(value); assert.equal(validate(JSON.stringify(value)), false);
  }
});

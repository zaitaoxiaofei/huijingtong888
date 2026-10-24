// Offline provider replies shared by coordinator/SQL tests. Each invocation
// returns fresh objects so one test's mutation cannot alter another test.
export function materialAnalysisFixture() {
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

export function materialPlanFixture() {
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

export function materialReviewFixture(pass = true) {
  return { pass, score: pass ? 90 : 60, issues_zh: pass ? [] : ["商品数量与参考图不一致"],
    corrections_en: pass ? "" : "Restore the exact verified component count.", checks: { identity_preserved: pass } };
}

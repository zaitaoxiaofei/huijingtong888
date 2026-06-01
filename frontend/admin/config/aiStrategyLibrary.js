export const AI_STRATEGY_LIBRARY_VERSION = "2026.05.phase1";

export const AI_BUSINESS_MODES = {
  optimization: {
    key: "product_optimization",
    title: "商品优化AI",
    goals: ["low_ctr", "low_exposure", "low_conversion", "high_cart_low_order", "high_ad_cost"]
  },
  variant: {
    key: "product_variant",
    title: "商品裂变AI",
    goals: ["multi_model_variant", "multi_scene_variant", "multi_persona_variant", "multi_ratio_variant", "multi_color_variant", "multi_style_variant"]
  }
};

const GOAL_ALIASES = {
  low_ctr: ["提升点击率", "点击率低", "CTR"],
  low_exposure: ["提升曝光", "曝光低", "SEO"],
  low_conversion: ["提升转化率", "转化率低", "CVR"],
  high_cart_low_order: ["降低决策成本", "加购未下单"],
  high_ad_cost: ["降低广告成本", "广告花费高"],
  multi_model_variant: ["多车型铺货", "多型号铺货", "车型裂变"],
  multi_scene_variant: ["多场景裂变"],
  multi_ratio_variant: ["多尺寸裂变"]
};

export const AI_ASSET_TYPES = [
  { key: "main_image", title: "主图" },
  { key: "title", title: "标题" },
  { key: "tags", title: "标签" },
  { key: "detail_image", title: "详情图" },
  { key: "description", title: "描述" }
];

export const AI_STRATEGY_SEED = [
  strategy({
    id: "main-subject-70",
    title: "主体占比70%",
    aliases: ["主体占比提升到70%", "主图主体强化", "主体强化"],
    goals: ["low_ctr", "high_ad_cost"],
    assets: ["main_image"],
    priority: 90,
    positive: [
      "Make the product the dominant visual subject, occupying about 70% of the canvas.",
      "Keep clear margins for marketplace cropping while preserving a strong product silhouette."
    ],
    negative: ["Do not make the product too small or lost in the background."]
  }),
  strategy({
    id: "vehicle-model-emphasis",
    title: "车型强化",
    aliases: ["车型信息强化", "车型适配强化", "型号强化", "主图型号强化", "车型词覆盖", "车型词标签"],
    goals: ["low_ctr", "low_exposure", "multi_model_variant"],
    assets: ["main_image", "title", "tags"],
    priority: 86,
    positive: [
      "Clearly communicate the target vehicle model or compatibility context without inventing unsupported models.",
      "Use the target model variable as the source of truth for model-specific wording."
    ],
    negative: ["Do not add random vehicle models. Do not claim compatibility beyond the provided model list."]
  }),
  strategy({
    id: "high-contrast-click-composition",
    title: "高对比点击构图",
    aliases: ["高点击主图风", "高点击基础图风", "高对比构图", "高对比点击构图"],
    goals: ["low_ctr", "high_ad_cost"],
    assets: ["main_image"],
    priority: 82,
    positive: [
      "Use a high-click ecommerce composition with stronger product contrast and a clear visual hierarchy.",
      "Prioritize readability at small thumbnail size on Ozon search results."
    ],
    negative: ["Avoid cluttered collage layouts, tiny product scale, or unreadable decorative text."]
  }),
  strategy({
    id: "premium-material-texture",
    title: "高级质感强化",
    aliases: ["高级感强化", "品牌质感强化", "质感强化", "高端原厂风"],
    goals: ["low_ctr", "premium_feel"],
    assets: ["main_image", "detail_image"],
    priority: 78,
    positive: [
      "Enhance premium material texture with realistic highlights, refined shadows, and clean product edges.",
      "The image should feel polished and factory-grade while keeping the real product structure."
    ],
    negative: ["Do not over-gloss the product or change its material identity."]
  }),
  strategy({
    id: "handheld-context",
    title: "手持场景强化",
    aliases: ["手持主体", "真实使用感"],
    goals: ["low_ctr", "low_conversion"],
    assets: ["main_image", "detail_image"],
    priority: 72,
    conflicts: ["white-background-clean"],
    positive: [
      "If a scene is needed, show a realistic hand-held or in-use context that helps buyers understand product scale.",
      "Keep the product as the focus; the hand or scene must support the product, not distract from it."
    ],
    negative: ["Do not add unrealistic hands, distorted fingers, or unrelated lifestyle objects."]
  }),
  strategy({
    id: "white-background-clean",
    title: "白底清晰风",
    aliases: ["白底图补充", "白底清晰图", "白底搜索图"],
    goals: ["low_ctr", "low_exposure", "multi_ratio_variant"],
    assets: ["main_image"],
    priority: 70,
    conflicts: ["handheld-context"],
    positive: [
      "Use a clean white or near-white ecommerce background with natural shadow and crisp edges.",
      "Make the product easy to inspect with no distracting scene elements."
    ],
    negative: ["No busy background, no heavy texture, no lifestyle scene."]
  }),
  strategy({
    id: "seo-title-structure",
    title: "高搜索标题结构",
    aliases: ["高搜索标题", "Ozon爆款标题", "俄语标题结构优化"],
    goals: ["low_exposure", "title_optimize"],
    assets: ["title"],
    priority: 88,
    positive: [
      "Build the title with product type, target model, material, core function, and marketplace search terms.",
      "Prefer concise Russian marketplace wording suitable for Ozon."
    ],
    negative: ["Do not stuff irrelevant keywords or unsupported compatibility claims."]
  }),
  strategy({
    id: "tag-expansion",
    title: "标签扩展",
    aliases: ["Ozon搜索标签", "品牌词标签", "材质功能标签"],
    goals: ["low_exposure", "tag_optimize"],
    assets: ["tags"],
    priority: 68,
    positive: [
      "Generate searchable tags covering brand, model, product type, material, function, and buyer intent.",
      "Keep tags specific and deduplicated."
    ],
    negative: ["Do not include unrelated brands, random models, or misleading platform names."]
  }),
  strategy({
    id: "installation-detail",
    title: "安装场景说明",
    aliases: ["安装图", "安装方式说明", "安装步骤图", "安装路径说明", "安装位置强化"],
    goals: ["low_conversion", "high_cart_low_order"],
    assets: ["detail_image", "description"],
    priority: 76,
    positive: [
      "Explain where and how the product is installed with clear visual steps or callouts.",
      "Use practical buyer-facing language that reduces installation uncertainty."
    ],
    negative: ["Do not show impossible installation positions or unsupported vehicle parts."]
  }),
  strategy({
    id: "material-detail",
    title: "材质细节说明",
    aliases: ["材质细节图", "材质词覆盖", "材质功能词强化"],
    goals: ["low_conversion", "low_exposure"],
    assets: ["detail_image", "title", "tags", "description"],
    priority: 66,
    positive: [
      "Show or describe material texture, durability, protective function, and tactile details.",
      "Make material benefits concrete and relevant to the product."
    ],
    negative: ["Do not claim certifications or material grades not present in source data."]
  }),
  strategy({
    id: "size-fit-detail",
    title: "尺寸信息说明",
    aliases: ["尺寸说明", "尺寸适配说明", "尺寸参数说明"],
    goals: ["low_conversion", "high_cart_low_order"],
    assets: ["detail_image", "description"],
    priority: 62,
    positive: [
      "Include size or fit information using provided package and product dimensions when available.",
      "Use a clear comparison or dimension explanation to reduce buyer uncertainty."
    ],
    negative: ["Do not invent exact measurements if not provided."]
  }),
  strategy({
    id: "ab-main-image-set",
    title: "A/B主图套组",
    aliases: ["生成3套A/B主图", "多版本主图A/B测试", "A/B主图"],
    goals: ["low_ctr", "high_ad_cost"],
    assets: ["main_image"],
    priority: 54,
    positive: [
      "Prepare the image as one candidate in an A/B test set with a distinct visual angle from other candidates.",
      "Keep product identity consistent across variants."
    ],
    negative: ["Do not create a duplicate composition if other selected strategies imply a different variant."]
  }),
  strategy({
    id: "model-batch-variant",
    title: "车型变量替换",
    aliases: ["每个车型独立主图", "车型文字强化", "标题型号替换", "批量任务生成"],
    businessModes: ["product_variant"],
    goals: ["multi_model_variant"],
    assets: ["main_image", "title", "tags"],
    priority: 92,
    positive: [
      "Generate one independent task per target model.",
      "Replace only the model-specific wording or compatibility context while preserving the product structure and base creative direction."
    ],
    negative: ["Do not mix multiple target models in one generated asset."]
  })
];

export const AI_STRATEGY_LAYER_SEED = [
  {
    scope: "global",
    key: "global-default",
    title: "全局策略",
    goals: {
      low_ctr: ["main-subject-70", "vehicle-model-emphasis", "high-contrast-click-composition"],
      low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"],
      low_conversion: ["installation-detail", "material-detail", "size-fit-detail"],
      multi_model_variant: ["model-batch-variant", "vehicle-model-emphasis"]
    }
  },
  {
    scope: "platform",
    key: "ozon",
    title: "Ozon平台策略",
    goals: {
      low_ctr: ["high-contrast-click-composition"],
      low_exposure: ["seo-title-structure", "tag-expansion"]
    }
  },
  {
    scope: "category",
    key: "key-shell",
    title: "钥匙壳类目策略",
    aliases: ["钥匙壳", "key shell", "key case"],
    goals: {
      low_ctr: ["premium-material-texture", "handheld-context", "main-subject-70", "vehicle-model-emphasis"],
      low_conversion: ["material-detail", "size-fit-detail"],
      low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"]
    }
  },
  {
    scope: "category",
    key: "auto-accessory",
    title: "通用汽车配件类目策略",
    aliases: ["汽车配件", "汽车用品", "auto accessory"],
    goals: {
      low_ctr: ["main-subject-70", "vehicle-model-emphasis", "high-contrast-click-composition", "ab-main-image-set"],
      low_conversion: ["installation-detail", "material-detail", "size-fit-detail"],
      low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"]
    }
  }
];

export function resolveAiStrategyPlan({
  businessMode = "product_optimization",
  goalKey = "low_ctr",
  selectedTitles = [],
  fallbackTitles = [],
  categoryText = "",
  temporaryStrategies = []
} = {}) {
  const selected = uniqueText(selectedTitles).length ? uniqueText(selectedTitles) : uniqueText(fallbackTitles);
  const strategyById = new Map(AI_STRATEGY_SEED.filter((item) => item.enabled).map((item) => [item.id, item]));
  const strategyByTitle = new Map();
  for (const item of AI_STRATEGY_SEED) {
    [item.title, ...(item.aliases || [])].forEach((title) => {
      strategyByTitle.set(normalize(title), item);
    });
  }

  const inheritedIds = resolveInheritedStrategyIds(goalKey, categoryText);
  const selectedStrategies = selected
    .map((title) => strategyByTitle.get(normalize(title)) || createTemporaryStrategy(title, goalKey))
    .filter((item) => strategyMatches(item, businessMode, goalKey));
  const inheritedStrategies = inheritedIds
    .map((id) => strategyById.get(id))
    .filter((item) => item && strategyMatches(item, businessMode, goalKey));
  const tempStrategies = temporaryStrategies.map((item) => createTemporaryStrategy(item.title || item, goalKey));

  const merged = dedupeStrategies([...selectedStrategies, ...inheritedStrategies, ...tempStrategies])
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const conflictIds = new Set();
  const chosen = [];
  for (const item of merged) {
    if (conflictIds.has(item.id)) continue;
    chosen.push(item);
    (item.conflicts || []).forEach((id) => conflictIds.add(id));
  }

  return {
    version: AI_STRATEGY_LIBRARY_VERSION,
    businessMode,
    goalKey,
    layers: resolveStrategyLayers(goalKey, categoryText),
    strategies: chosen,
    strategyIds: chosen.map((item) => item.id),
    strategyTitles: chosen.map((item) => item.title),
    positiveModules: chosen.flatMap((item) => item.promptModules?.positive || []),
    negativeModules: chosen.flatMap((item) => item.promptModules?.negative || []),
    assets: [...new Set(chosen.flatMap((item) => item.assets || []))]
  };
}

export function createAiTaskSnapshot({ task = {}, job = {}, strategyPlan = {}, prompt = {}, result = {}, targetModel = "" } = {}) {
  return {
    snapshotVersion: "ai-task-snapshot.v1",
    createdAt: new Date().toISOString(),
    businessMode: strategyPlan.businessMode,
    goalKey: strategyPlan.goalKey,
    source: {
      type: task.sourceType,
      id: task.sourceId,
      label: task.sourceLabel,
      selectionId: task.sourceSelectionId,
      packageId: task.sourcePackageId,
      imageUrl: task.sourceImageUrl
    },
    product: {
      name: task.productName,
      categoryName: task.categoryName,
      productType: task.productType,
      brand: task.brand,
      vehicleModel: task.vehicleModel,
      targetModel,
      material: task.material,
      color: task.color,
      sellingPoints: task.sellingPoints
    },
    generation: {
      jobId: job.id,
      variantMode: task.variantMode,
      ratio: task.ratio,
      imageCount: task.imageCount,
      outputs: [...(task.outputs || [])],
      detailImageTypes: [...(task.detailImageTypes || [])],
      style: task.style
    },
    strategy: {
      libraryVersion: strategyPlan.version,
      layers: strategyPlan.layers,
      ids: strategyPlan.strategyIds,
      titles: strategyPlan.strategyTitles,
      assets: strategyPlan.assets
    },
    prompt: {
      templateId: task.selectedTemplateId || null,
      positive: prompt.finalPositivePrompt || "",
      negative: prompt.finalNegativePrompt || "",
      positiveModules: strategyPlan.positiveModules || [],
      negativeModules: strategyPlan.negativeModules || []
    },
    result
  };
}

function strategy(options) {
  return {
    businessModes: ["product_optimization", "product_variant"],
    version: 1,
    enabled: true,
    conflicts: [],
    promptModules: {
      positive: options.positive || [],
      negative: options.negative || []
    },
    ...options
  };
}

function resolveInheritedStrategyIds(goalKey, categoryText) {
  return resolveStrategyLayers(goalKey, categoryText).flatMap((layer) => layer.strategyIds);
}

function resolveStrategyLayers(goalKey, categoryText) {
  const text = normalize(categoryText);
  return AI_STRATEGY_LAYER_SEED
    .filter((layer) => layer.goals?.[goalKey]?.length)
    .filter((layer) => layer.scope !== "category" || (layer.aliases || []).some((alias) => text.includes(normalize(alias))))
    .map((layer) => ({
      scope: layer.scope,
      key: layer.key,
      title: layer.title,
      strategyIds: layer.goals[goalKey]
    }));
}

function strategyMatches(item, businessMode, goalKey) {
  const modes = item.businessModes || ["product_optimization", "product_variant"];
  const goals = item.goals || [];
  return modes.includes(businessMode) && (goals.includes(goalKey) || goals.some((goal) => (GOAL_ALIASES[goal] || []).includes(goalKey)));
}

function dedupeStrategies(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.id || map.has(item.id)) continue;
    map.set(item.id, item);
  }
  return [...map.values()];
}

function createTemporaryStrategy(title, goalKey) {
  const text = String(title || "").trim();
  return strategy({
    id: `temporary-${normalize(text).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").slice(0, 48)}`,
    title: text,
    goals: [goalKey],
    assets: ["main_image", "title", "tags", "detail_image"],
    priority: 10,
    version: 1,
    positive: [`Apply the business strategy "${text}" in a concrete, product-faithful way.`],
    negative: [`Do not apply "${text}" in a misleading or unsupported way.`]
  });
}

function uniqueText(list = []) {
  return [...new Set((Array.isArray(list) ? list : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

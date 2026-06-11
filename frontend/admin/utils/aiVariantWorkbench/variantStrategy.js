const KNOWN_BRANDS = "TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN";

export function parseVariantTarget(rawTarget = "") {
  if (rawTarget && typeof rawTarget === "object") {
    const labelText = String(rawTarget.label || rawTarget.displayName || [rawTarget.brand, rawTarget.model].filter(Boolean).join(" ") || rawTarget.rawText || "").trim();
    const brand = String(rawTarget.brand || inferBrand(labelText) || "").trim();
    return {
      label: labelText,
      brand,
      model: String(rawTarget.model || labelText.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, "i"), "") || "").trim(),
      rawText: String(rawTarget.rawText || labelText).trim()
    };
  }
  const rawText = String(rawTarget || "").trim();
  const brand = inferBrand(rawText);
  const model = brand ? rawText.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, "i"), "").trim() : rawText;
  return {
    label: rawText,
    brand,
    model,
    rawText
  };
}

export function splitVariantTargetText(value = "") {
  const source = String(value || "").trim();
  const primary = source
    .split(/\r?\n|[,，、;；/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (primary.length > 1) return primary;
  return source
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildVariantTargets(rawTargets = "", options = {}) {
  const parsed = Array.isArray(rawTargets)
    ? rawTargets
    : expandRecognizedVariantTargets(rawTargets, options);
  return parsed
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map(parseVariantTarget)
    .filter((item) => item.label)
    .slice(0, Number(options.limit || 30));
}

export function buildVariantStrategy({
  variantType = "vehicle",
  rawTargets = "",
  variantPlan = {},
  globalPrompt = "",
  extraPrompt = "",
  categoryStrategy = {},
  selectedFields = [],
  negativePrompt = ""
} = {}) {
  const targets = buildVariantTargets(rawTargets, { variantType: variantPlan.type || variantType });
  const combinedNegativePrompt = [
    categoryStrategy.negativePrompt,
    negativePrompt
  ].filter(Boolean).join("\n");
  return {
    variantType: variantPlan.type || variantType,
    targets,
    selectedFields,
    globalPrompt: globalPrompt || extraPrompt || "",
    fieldRules: {
      mainImage: categoryStrategy.mainImagePrompt || "",
      detailImages: categoryStrategy.detailPrompt || "",
      title: categoryStrategy.titlePrompt || "",
      tags: categoryStrategy.tagsPrompt || "",
      description: categoryStrategy.descriptionPrompt || "",
      richText: categoryStrategy.subTextPrompt || richTextStrategyLabel(categoryStrategy.richTextStrategy)
    },
    inheritRules: {
      reuseDetailImages: Boolean(variantPlan.commonDetailImages),
      replaceOnlyTargetWords: Boolean(variantPlan.keepBaseDescription),
      keepProductFacts: true,
      keepMaterialAndQuantity: true
    },
    riskRules: {
      negativePrompt: combinedNegativePrompt,
      forbiddenWords: ["中文", "水印", "虚假认证", "官方授权", "销量", "质保"],
      noFakeFunctions: true,
      noFakeCompatibility: true
    }
  };
}

function expandRecognizedVariantTargets(text = {}, options = {}) {
  const source = String(text || "").trim();
  const upper = source.toUpperCase();
  const variantType = options.variantType || "vehicle";
  if (variantType === "vehicle" && /(TENET|TONNET)/.test(upper) && /(全部|所有|ALL)/i.test(source)) {
    return ["TENET T4", "TENET T4L", "TENET T7", "TENET T8"];
  }
  const recognized = Array.from(new Set([
    ...upper.matchAll(new RegExp(`\\b(${KNOWN_BRANDS})\\s*[A-Z0-9-]{1,8}\\b`, "g"))
  ].map((match) => match[0].replace(/\s+/g, " ").trim())));
  if (variantType === "vehicle" && recognized.length) return recognized;
  return recognized.length ? recognized : splitVariantTargetText(source);
}

function inferBrand(text = "") {
  const match = String(text || "").match(new RegExp(`\\b(${KNOWN_BRANDS})\\b`, "i"));
  return match ? match[1].toUpperCase() : "";
}

function richTextStrategyLabel(value) {
  return {
    main_image_description: "主图 + 描述",
    detail_image_description: "详情图 + 描述",
    main_detail_description: "主图 + 详情图 + 描述",
    inherit: "继承原副文本"
  }[value] || "主图 + 描述";
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

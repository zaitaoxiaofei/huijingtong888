const KNOWN_VEHICLE_BRANDS = [
  "TENET",
  "HAVAL",
  "CHERY",
  "JAECOO",
  "GEELY",
  "BELGEE",
  "OMODA",
  "EXEED",
  "CHANGAN",
  "HONGQI",
  "LADA",
  "KIA",
  "HYUNDAI",
  "TOYOTA",
  "NISSAN",
  "RENAULT",
  "BMW",
  "AUDI",
  "VW",
  "VOLKSWAGEN"
];

const SUBJECT_RULES = [
  {
    key: "wiper_base_pad",
    labelRu: "защитные накладки на основание дворников",
    labelZh: "雨刮底座保护垫",
    match: [/дворник/i, /основан/i],
    requiredAny: ["дворник", "наклад", "основан"],
    forbidden: ["порог", "салон", "коврик", "ключ"]
  },
  {
    key: "sill_plate",
    labelRu: "накладки на пороги автомобиля",
    labelZh: "汽车门槛条",
    match: [/порог/i, /наклад/i],
    requiredAny: ["порог", "наклад"],
    forbidden: ["дворник", "ключ", "коврик", "багажник"]
  },
  {
    key: "key_case",
    labelRu: "чехол для автомобильного ключа",
    labelZh: "汽车钥匙保护壳",
    match: [/ключ/i, /чехол|корпус|защит/i],
    requiredAny: ["ключ", "чехол", "корпус"],
    forbidden: ["порог", "дворник", "коврик"]
  },
  {
    key: "bumper_guard",
    labelRu: "защитная накладка на бампер или кузов",
    labelZh: "防撞保护条",
    match: [/бампер|кузов|багажник/i, /наклад|защит|молдинг/i],
    requiredAny: ["защит", "наклад", "бампер", "багажник", "кузов"],
    forbidden: ["дворник", "ключ", "коврик"]
  }
];

export function buildCopyFactsContract(input = {}) {
  const draft = input.draft || {};
  const manual = parseJsonObject(draft.manual_facts_json) || input.manualFacts || {};
  const template = parseJsonObject(draft.template_payload_json) || input.template || {};
  const editable = template.editable_payload || {};
  const sourceRaw = template.source_raw || {};
  const collected = sourceRaw.collected_product || {};
  const attributes = [
    ...normalizeArray(manual.attributes),
    ...normalizeArray(editable.attributes),
    ...normalizeArray(template.attributes)
  ];
  const title = cleanText(input.title || manual.title || editable.title || draft.product_name || template.template_name || collected.productTitle || collected.name);
  const originalDescription = cleanText(input.description || manual.description || editable.description || "");
  const sourceTitle = cleanText(collected.productTitle || collected.name || sourceRaw.productTitle || "");
  const categoryName = cleanText(manual.category_name || editable.category_name || template.category_name || collected.category || "");
  const targetModel = cleanText(input.targetModel || input.variantTarget || extractVehicleModel(`${title} ${sourceTitle}`));
  const productSubject = detectProductSubject({ title, sourceTitle, categoryName, attributes });
  const material = normalizeMaterial(input.material || extractAttributeValue(attributes, ["材质", "材料", "material", "Материал"]) || inferMaterial(`${title} ${originalDescription}`));
  const color = normalizeColor(input.color || extractAttributeValue(attributes, ["颜色", "color", "Цвет"]) || inferColor(`${title} ${originalDescription}`));
  const quantity = cleanText(input.quantity || extractAttributeValue(attributes, ["数量", "数量，件数", "quantity", "Кол-во"]) || inferQuantity(`${title} ${originalDescription}`));
  const sourceTags = extractTags(manual, editable);

  const requiredFacts = [
    fact("target_model", "适配对象/车型", targetModel),
    fact("product_subject", "产品主体", productSubject.labelRu, productSubject.labelZh),
    fact("material", "材质", material),
    fact("color", "颜色", color),
    fact("quantity", "数量", quantity)
  ].filter((item) => item.value);

  return {
    source: {
      draftId: draft.id || input.draftId || null,
      title,
      sourceTitle,
      categoryName,
      originalDescription,
      sourceTags
    },
    requiredFacts,
    productSubject,
    targetModel,
    material,
    color,
    quantity,
    allowedVariation: [
      "表达顺序",
      "搜索词侧重",
      "功能/场景/材质角度",
      "标题长度和关键词组合"
    ],
    forbiddenClaims: [
      "官方授权",
      "原厂正品",
      "认证",
      "质保",
      "销量",
      "未提供的精确尺寸",
      "未提供的兼容车型",
      "无关产品类目"
    ],
    sourceWarnings: detectSourceWarnings({ title, originalDescription, productSubject })
  };
}

export function buildCopyBundlePrompt(contract = {}, options = {}) {
  const strategy = cleanText(options.strategy || "precision_fit");
  const promptContract = {
    requiredFacts: contract.requiredFacts || [],
    productSubject: contract.productSubject ? {
      key: contract.productSubject.key,
      labelRu: contract.productSubject.labelRu,
      labelZh: contract.productSubject.labelZh,
      requiredAny: contract.productSubject.requiredAny || [],
      forbidden: contract.productSubject.forbidden || []
    } : null,
    targetModel: contract.targetModel || "",
    material: contract.material || "",
    color: contract.color || "",
    quantity: contract.quantity || "",
    source: {
      draftId: contract.source?.draftId || null,
      categoryName: contract.source?.categoryName || ""
    },
    sourceWarnings: contract.sourceWarnings || [],
    allowedVariation: contract.allowedVariation || [],
    forbiddenClaims: contract.forbiddenClaims || []
  };
  return [
    "You generate Russian Ozon listing copy from a strict product facts contract.",
    "Do not freely reinterpret the product. The required facts are authoritative.",
    "Keep the exact target model/compatibility string when present.",
    "The product subject must stay the same. Do not replace it with a broad generic category.",
    "Important: source title, source tags, and source description may contain stale or dirty template facts.",
    "Required facts override every source field. If source fields conflict with required facts, ignore the conflicting source wording.",
    "Do not invent warranty, certification, official authorization, sales volume, exact dimensions, or unsupported compatibility.",
    "Tags may include Latin model/material facts such as TENET T4 or ABS when they are required facts.",
    "Return ONLY valid JSON with this shape:",
    '{"title":"...","tags":["#..."],"description":"...","factsUsed":["..."],"strategyApplied":"..."}',
    "Title target: 70-130 characters, natural Russian marketplace wording.",
    "Tags target: 12-20 hashtags, useful search terms, no duplicates, each shorter than 35 characters.",
    "Description target: 70-140 Russian words, natural prose, no hashtags, no markdown.",
    "Strategy:",
    strategy,
    "Product facts contract JSON:",
    JSON.stringify(promptContract, null, 2)
  ].join("\n");
}

function detectProductSubject({ title = "", sourceTitle = "", categoryName = "", attributes = [] } = {}) {
  const text = `${title} ${sourceTitle} ${categoryName} ${attributes.map((item) => `${item.name || ""} ${attributeText(item)}`).join(" ")}`;
  for (const rule of SUBJECT_RULES) {
    if (rule.match.every((pattern) => pattern.test(text))) return { ...rule };
  }
  const fallback = cleanText(title.split(/\s+для\s+|\s*,\s*/i)[0]).slice(0, 120);
  return {
    key: "generic_product",
    labelRu: fallback || "автоаксессуар",
    labelZh: "未识别商品主体",
    requiredAny: fallback ? fallback.toLowerCase().split(/\s+/).filter((item) => item.length > 4).slice(0, 3) : [],
    forbidden: []
  };
}

function detectSourceWarnings({ title = "", originalDescription = "", productSubject = {} } = {}) {
  const warnings = [];
  const lowerDescription = originalDescription.toLowerCase();
  for (const forbidden of productSubject.forbidden || []) {
    if (lowerDescription.includes(forbidden)) {
      warnings.push(`source_description_mentions_unrelated_${forbidden}`);
    }
  }
  if (title && originalDescription && productSubject.key !== "generic_product") {
    const hasSubjectInDescription = (productSubject.requiredAny || []).some((token) => lowerDescription.includes(token));
    if (!hasSubjectInDescription) warnings.push("source_description_missing_product_subject");
  }
  return warnings;
}

function fact(key, label, value, zh = "") {
  return { key, label, value: cleanText(value), zh: cleanText(zh) };
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractAttributeValue(attributes = [], names = []) {
  const lowerNames = names.map((item) => String(item).toLowerCase());
  for (const attr of attributes) {
    const name = String(attr?.name || attr?.attribute_name || attr?.label || "").toLowerCase();
    if (!lowerNames.some((needle) => name.includes(needle))) continue;
    const value = cleanText(attributeText(attr));
    if (value) return value;
  }
  return "";
}

function attributeText(attr = {}) {
  if (Array.isArray(attr.values) && attr.values.length) {
    return attr.values.map((item) => item?.value || item?.label || item?.name || item).filter(Boolean).join(", ");
  }
  if (Array.isArray(attr.value)) return attr.value.join(", ");
  return cleanText(attr.value || attr.text || attr.label || "");
}

function inferMaterial(text = "") {
  const value = cleanText(text);
  if (/\bABS\b/i.test(value)) return "ABS пластик";
  if (/резин/i.test(value)) return "резина";
  if (/нержав/i.test(value)) return "нержавеющая сталь";
  if (/силикон/i.test(value)) return "силикон";
  if (/пластик/i.test(value)) return "пластик";
  if (/металл/i.test(value)) return "металл";
  return "";
}

function normalizeMaterial(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (/\bABS\b/i.test(text)) return "ABS пластик";
  if (/нержав/i.test(text)) return "нержавеющая сталь";
  if (/резин/i.test(text)) return "резина";
  if (/силикон/i.test(text)) return "силикон";
  return text;
}

function normalizeColor(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (/silvery|silver|сереб/i.test(text)) return "серебристый";
  if (/black|черн|чёрн/i.test(text)) return "черный";
  if (/white|бел/i.test(text)) return "белый";
  if (/transparent|прозрач/i.test(text)) return "прозрачный";
  return text;
}

function inferColor(text = "") {
  const value = cleanText(text).toLowerCase();
  if (/черн|black|чёрн/i.test(value)) return "черный";
  if (/сереб|silver/i.test(value)) return "серебристый";
  if (/бел|white/i.test(value)) return "белый";
  if (/красн|red/i.test(value)) return "красный";
  if (/прозрач|transparent/i.test(value)) return "прозрачный";
  return "";
}

function inferQuantity(text = "") {
  const match = cleanText(text).match(/(?:комплект\s*)?(\d+)\s*(?:шт|штук|pcs|件)/i);
  return match ? `${match[1]} шт.` : "";
}

function extractVehicleModel(text = "") {
  const brandPattern = KNOWN_VEHICLE_BRANDS.join("|");
  const match = cleanText(text).match(new RegExp(`\\b(${brandPattern})\\s+[A-Z0-9][A-Z0-9-]{0,8}\\b`, "i"));
  return match ? match[0].replace(/\s+/g, " ").toUpperCase() : "";
}

function extractTags(manual = {}, editable = {}) {
  const raw = manual.tags || manual.logistics?.tags || editable.tags || editable.logistics?.tags || [];
  if (Array.isArray(raw)) return raw.map(cleanText).filter(Boolean).slice(0, 30);
  return String(raw || "").split(/[\n,，;；\s]+/).map(cleanText).filter(Boolean).slice(0, 30);
}

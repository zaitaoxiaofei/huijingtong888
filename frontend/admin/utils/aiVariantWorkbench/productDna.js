export function cleanDnaValue(value) {
  if (Array.isArray(value)) return value.map(cleanDnaValue).filter(Boolean);
  return String(value ?? "").trim();
}

export function compactDnaObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length;
    if (item && typeof item === "object") return Object.keys(compactDnaObject(item)).length;
    return cleanDnaValue(item);
  }));
}

export function collectTemplateAttributes(template = {}) {
  const editable = template?.editable_payload || template?.editablePayload || {};
  return [
    ...(Array.isArray(template?.attributes) ? template.attributes : []),
    ...(Array.isArray(editable?.attributes) ? editable.attributes : [])
  ];
}

export function readAttributeValue(attributes = [], names = []) {
  const lowered = names.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  const hit = attributes.find((item) => {
    const candidates = [item.name, item.attribute_name, item.title, item.label, item.id, item.attribute_id]
      .map((valueItem) => String(valueItem || "").trim().toLowerCase())
      .filter(Boolean);
    return candidates.some((candidate) => lowered.includes(candidate));
  });
  if (!hit) return "";
  if (Array.isArray(hit.values) && hit.values.length) {
    return hit.values.map((item) => item.value || item.label || item.name || item).join(", ");
  }
  return hit.value || hit.text || hit.label || "";
}

export function buildProductDNA(product = {}, row = null) {
  const template = normalizeTemplateSnapshot(row?.templateSnapshot || product.templateSnapshot, product) || {};
  const raw = product.raw || {};
  const attributes = collectTemplateAttributes(template);
  const sourceImages = normalizeImageList(template.images || template.editable_payload?.images || [
    product.imageUrl,
    ...(Array.isArray(product.detailImages) ? product.detailImages : [])
  ]);
  const knownFacts = [];
  const unknownFacts = [];
  const addKnown = (labelText, value) => {
    const cleaned = Array.isArray(value) ? cleanDnaValue(value).join(", ") : cleanDnaValue(value);
    if (cleaned) knownFacts.push(`${labelText}: ${cleaned}`);
    else unknownFacts.push(labelText);
    return value;
  };
  const compatibleModels = cleanDnaValue([
    ...(Array.isArray(product.compatibleModels) ? product.compatibleModels : []),
    row?.variantTarget,
    product.model,
    raw.vehicle_model,
    raw.model,
    readAttributeValue(attributes, ["车型", "适用车型", "型号名称", "vehicle_model", "model"])
  ]).filter(Boolean);
  const size = compactDnaObject({
    lengthCm: product.lengthCm || raw.length_cm || raw.lengthCm || template.editable_payload?.dimensions?.length_cm,
    widthCm: product.widthCm || raw.width_cm || raw.widthCm || template.editable_payload?.dimensions?.width_cm,
    heightCm: product.heightCm || raw.height_cm || raw.heightCm || template.editable_payload?.dimensions?.height_cm,
    weightG: product.packageWeightG || raw.package_weight_g || raw.packageWeightG || raw.weight_g || raw.weightG || template.editable_payload?.dimensions?.weight_g
  });
  const packageInfo = compactDnaObject({
    quantity: row?.attributes?.quantity || product.quantity || raw.quantity,
    packageWeightG: product.packageWeightG || raw.package_weight_g || raw.packageWeightG,
    packageSize: product.sizeText || raw.package_size || raw.packageSize
  });
  const sellingPoints = cleanDnaValue([
    product.description,
    row?.description,
    raw.selling_points,
    raw.summary,
    raw.annotation,
    ...(Array.isArray(product.tags) ? product.tags : [])
  ]).filter(Boolean);
  const ozonAttributes = attributes.length ? attributes : rowListingAttributes(row || { product });
  return {
    base: {
      title: addKnown("商品标题", row?.title || product.title || template.title || product.name),
      productType: addKnown("商品类型", product.category || template.category_name || raw.product_type),
      category: addKnown("类目", product.category || template.category_name || product.sourceCategory),
      brand: addKnown("品牌", product.brand || raw.brand || readAttributeValue(attributes, ["品牌", "brand"])),
      model: addKnown("车型/型号", row?.variantTarget || product.model || raw.model || raw.vehicle_model),
      compatibleModels: addKnown("适配车型", [...new Set(compatibleModels)]),
      material: addKnown("材质", row?.attributes?.material || product.material || readAttributeValue(attributes, ["材质", "材料", "material"])),
      color: addKnown("颜色", row?.attributes?.color || product.color || readAttributeValue(attributes, ["颜色", "color"])),
      quantity: addKnown("数量", row?.attributes?.quantity || product.quantity || raw.quantity),
      size: addKnown("尺寸", Object.keys(size).length ? JSON.stringify(size) : ""),
      packageInfo: addKnown("包装信息", Object.keys(packageInfo).length ? JSON.stringify(packageInfo) : "")
    },
    sellingPoints: [...new Set(sellingPoints)].slice(0, 12),
    assets: {
      mainImage: addKnown("主图", row?.generatedMainImageUrl || sourceImages[0] || product.imageUrl),
      detailImages: addKnown("详情图", row?.generatedDetailImages?.length ? row.generatedDetailImages : (sourceImages.slice(1).length ? sourceImages.slice(1) : product.detailImages)),
      video: addKnown("视频", row?.video?.url || product.videoUrls?.[0] || raw.video_url)
    },
    ozon: {
      source: product.source || raw.source || "ai_optimization_v2",
      sourceId: addKnown("来源ID", product.sourceId || raw.id || product.id),
      offerId: addKnown("Offer ID", raw.offer_id || raw.offerId || raw.offer || raw.sku),
      sku: addKnown("SKU", raw.sku || raw.code || product.sourceId || product.id),
      categoryId: addKnown("Ozon类目ID", rowListingCategoryId(row || { product })),
      typeId: addKnown("Ozon类型ID", product.typeId || raw.type_id || raw.typeId || template.type_id),
      attributes: ozonAttributes
    },
    constraints: {
      forbiddenClaims: [
        "certifications",
        "official authorization",
        "sales volume",
        "warranty",
        "exact size not present in source data",
        "unsupported accessories",
        "unsupported compatibility"
      ],
      knownFacts,
      unknownFacts: [...new Set(unknownFacts)],
      noFabricationRules: [
        "Do not invent unknown product parameters.",
        "Do not invent compatibility, certifications, authorization, warranty, sales volume, exact size, or accessories.",
        "Use only knownFacts as factual claims; treat unknownFacts as unavailable."
      ]
    }
  };
}

function normalizeImageList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string"
      ? item
      : (item?.url || item?.image_url || item?.imageUrl || item?.src || item?.preview_url || item?.previewUrl || item?.publish_url || item?.publishUrl || "")
    ).filter(Boolean);
  }
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return normalizeImageList(parsed);
  } catch {
    return text.split(/\s*\|\|\s*|\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean);
  }
}

function normalizeTemplateSnapshot(snapshot = null, product = {}) {
  const source = plainClone(snapshot, null);
  if (!source || typeof source !== "object") return null;
  const editable = plainClone(source.editable_payload || source.editablePayload || {}, {});
  const fallbackImageInput = [
    product.imageUrl,
    ...(Array.isArray(product.detailImages) ? product.detailImages : [])
  ].filter(Boolean);
  const images = Array.isArray(source.images)
    ? source.images
    : normalizeTemplateImages(editable.images || fallbackImageInput);
  const attributes = Array.isArray(source.attributes)
    ? source.attributes
    : (Array.isArray(editable.attributes) ? editable.attributes : []);
  return {
    ...source,
    ozon_category_id: source.ozon_category_id || source.ozonCategoryId || editable.category_id || product.ozonCategoryId || "",
    description_category_id: source.description_category_id || editable.description_category_id || product.descriptionCategoryId || "",
    type_id: source.type_id || editable.type_id || product.typeId || "",
    legacy_category_id: source.legacy_category_id || editable.legacy_category_id || product.legacyCategoryId || "",
    category_name: source.category_name || source.categoryName || editable.category_name || product.category || "AI 优化商品",
    template_name: source.template_name || source.templateName || editable.template_name || product.name || product.title || "AI 优化模板",
    title: source.title || editable.title || product.title || product.name || "",
    description: source.description || editable.description || product.description || "",
    attributes,
    images,
    source_raw: source.source_raw || source.sourceRaw || editable.source_raw || product.raw || {},
    editable_payload: {
      ...editable,
      title: source.title || editable.title || product.title || product.name || "",
      description: source.description || editable.description || product.description || "",
      category_name: source.category_name || source.categoryName || editable.category_name || product.category || "",
      attributes,
      images
    }
  };
}

function normalizeTemplateImages(images = []) {
  return normalizeImageList(images).map((url, index) => ({ url, sort_order: index + 1 }));
}

function plainClone(value, fallback = {}) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function rowListingCategoryId(row = {}) {
  const product = row.product || {};
  return String(
    product.ozonCategoryId
    || product.ozon_category_id
    || product.descriptionCategoryId
    || product.typeId
    || product.raw?.ozon_category_id
    || product.raw?.category_id
    || "ai_optimization_pending_category"
  ).trim();
}

function rowListingAttributes(row = {}) {
  const product = row.product || {};
  return [
    { name: "品牌", value: product.brand || "", required: true, source: "ai_optimization_v2" },
    { name: "型号名称", value: row.variantTarget || product.model || "", required: false, source: "ai_optimization_v2" },
    { name: "产品标签", value: (row.tags || []).join(", "), required: false, source: "ai_optimization_v2" },
    { name: "材质", value: row.attributes?.material || product.material || "", required: false, source: "ai_optimization_v2" },
    { name: "颜色", value: row.attributes?.color || product.color || "", required: false, source: "ai_optimization_v2" },
    { name: "简介", value: row.description || "", required: false, source: "ai_optimization_v2" }
  ].filter((item) => item.value || item.required);
}

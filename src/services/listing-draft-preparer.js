function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("{")) return parseJson(value, {});
  return {};
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const match = String(value).replace(/\s+/g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) || 0 : 0;
}

function normalizeImages(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.trim().startsWith("[") ? parseJson(value, []) : normalizeArray(value));
  const seen = new Set();
  return list.flat().map((item, index) => {
    const url = typeof item === "string" ? item : item?.url || item?.src || item?.previewUrl || "";
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl || seen.has(normalizedUrl)) return null;
    seen.add(normalizedUrl);
    return {
      ...(item && typeof item === "object" ? item : {}),
      url: normalizedUrl,
      name: String(item?.name || "").trim(),
      sort_order: Number(item?.sort_order || item?.sortOrder || index + 1)
    };
  }).filter(Boolean);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeStringList(item));
  if (value && typeof value === "object") return normalizeStringList(value.value || value.name || value.text || "");
  return String(value || "").split(/[,，\s\r\n]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeTagList(value) {
  return [...new Set(normalizeStringList(value).map((item) => item.startsWith("#") ? item : `#${item}`))];
}

function normalizeAttributeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") return item.value ?? item.name ?? item.text ?? JSON.stringify(item);
      return item;
    }).map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "").trim();
}

function normalizeAttributes(value) {
  return normalizeArray(value).map((item, index) => {
    if (typeof item === "string") return { name: item, value: "", type: "text", required: false, values: [], sort_order: index + 1 };
    const attributeId = item?.attribute_id || item?.attributeId || item?.id || "";
    const values = normalizeArray(item?.values).map((option) => ({
      id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim()
    })).filter((option) => option.value);
    return {
      name: String(item?.name || item?.attribute_name || item?.title || (attributeId ? `属性 ${attributeId}` : "")).trim(),
      value: normalizeAttributeValue(item?.value ?? item?.attribute_value ?? (values.length ? values : "")),
      required: Boolean(item?.required || item?.is_required),
      attribute_id: attributeId,
      type: String(item?.type || item?.value_type || (item?.dictionary_id ? "select" : "text")).trim(),
      dictionary_id: item?.dictionary_id || "",
      is_collection: Boolean(item?.is_collection || item?.collection),
      group: String(item?.group || item?.group_name || "").trim(),
      hint: String(item?.hint || item?.description || "").trim(),
      source: String(item?.source || "source").trim(),
      values,
      raw: item?.raw || item,
      sort_order: Number(item?.sort_order || index + 1)
    };
  }).filter((item) => item.name || item.value || item.attribute_id);
}

function attributeValueByIdsOrNames(attributes, ids = [], names = []) {
  const idSet = new Set(ids.map(String));
  const nameKeys = names.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  const matched = normalizeArray(attributes).find((item) => {
    if (item.attribute_id && idSet.has(String(item.attribute_id))) return true;
    const name = String(item.name || "").trim().toLowerCase();
    return name && nameKeys.some((key) => name.includes(key));
  });
  return matched?.value || "";
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return "";
}

function attributesToDynamicAttributes(attributes = []) {
  const result = {};
  for (const item of normalizeAttributes(attributes)) {
    const key = String(item.attribute_id || item.name || "").trim();
    if (!key || item.value === undefined || item.value === null || item.value === "") continue;
    result[key] = {
      attribute_id: item.attribute_id || "",
      name: item.name || "",
      value: item.value,
      values: item.values || [],
      dictionary_id: item.dictionary_id || "",
      type: item.type || "text",
      source: item.source || "variant_attribute"
    };
  }
  return result;
}

function mergeDynamicAttributes(...sources) {
  return Object.assign({}, ...sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};
    return source;
  }));
}

function pickAttributeValue(attributes = [], ids = [], names = []) {
  return attributeValueByIdsOrNames(normalizeAttributes(attributes), ids, names);
}

function upsertAttribute(attributes, names, value, defaults = {}) {
  if (value === undefined || value === null || value === "") return;
  const nameKeys = normalizeArray(names).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  const existing = attributes.find((item) => {
    if (defaults.attribute_id && String(item.attribute_id || "") === String(defaults.attribute_id)) return true;
    const name = String(item.name || "").trim().toLowerCase();
    return name && nameKeys.some((key) => name.includes(key));
  });
  if (existing) {
    existing.value = value;
    if (defaults.attribute_id && !existing.attribute_id) existing.attribute_id = defaults.attribute_id;
    return;
  }
  attributes.push({
    name: normalizeArray(names)[0] || defaults.name || "",
    value,
    required: Boolean(defaults.required),
    attribute_id: defaults.attribute_id || "",
    type: defaults.type || "text",
    source: defaults.source || "listing_draft_preparer",
    sort_order: attributes.length + 1
  });
}

function parseDimensionText(value) {
  if (!value || typeof value === "object") return {};
  const match = String(value).replace(/,/g, ".").replace(/\s+/g, "").match(/(\d+(?:\.\d+)?)[xX×*](\d+(?:\.\d+)?)[xX×*](\d+(?:\.\d+)?)/);
  if (!match) return {};
  return { length: Number(match[1]) || 0, width: Number(match[2]) || 0, height: Number(match[3]) || 0 };
}

function dimensionToCm(value, unit = "") {
  const numeric = numberValue(value);
  if (!numeric) return 0;
  const normalizedUnit = String(unit || "").toLowerCase();
  if (["mm", "мм"].includes(normalizedUnit)) return Number((numeric / 10).toFixed(2));
  if (["m", "м"].includes(normalizedUnit)) return Number((numeric * 100).toFixed(2));
  return numeric;
}

function normalizeDimensions(...sources) {
  const list = sources.filter(Boolean);
  const firstValue = (...keys) => {
    for (const source of list) {
      for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
    }
    return "";
  };
  const rawDims = firstValue("dimensions", "real_dimensions", "custom_volume");
  const dims = objectValue(rawDims);
  const parsed = parseDimensionText(rawDims);
  const unit = String(dims.unit || firstValue("dimension_unit", "dimensions_unit", "unit") || "").toLowerCase();
  return {
    length_cm: dimensionToCm(firstValue("length_cm") || dims.length_cm || firstValue("length_mm", "depth", "length") || dims.depth || dims.length || parsed.length || 0, firstValue("length_cm") || dims.length_cm ? "cm" : unit || "mm"),
    width_cm: dimensionToCm(firstValue("width_cm") || dims.width_cm || firstValue("width_mm", "width") || dims.width || parsed.width || 0, firstValue("width_cm") || dims.width_cm ? "cm" : unit || "mm"),
    height_cm: dimensionToCm(firstValue("height_cm") || dims.height_cm || firstValue("height_mm", "height") || dims.height || parsed.height || 0, firstValue("height_cm") || dims.height_cm ? "cm" : unit || "mm"),
    weight_g: numberValue(firstValue("weight_g", "custom_weight", "weight") || 0)
  };
}

function collectVariantRows(source = {}, editPayload = {}, followPayload = {}) {
  const payload = objectValue(source.payload || source.rawPayload || {});
  const normalized = objectValue(source.normalized || {});
  const nestedFollow = objectValue(source.followEditPayload || source.follow_edit_payload || editPayload.followEditPayload || editPayload.follow_edit_payload || payload.followEditPayload || payload.follow_edit_payload || normalized.followEditPayload || {});
  const rows = [
    ...normalizeArray(source.editorVariants || source.editor_variants || editPayload.editorVariants || editPayload.editor_variants || payload.editorVariants || normalized.editorVariants),
    ...normalizeArray(source.rows || editPayload.rows || followPayload.rows || nestedFollow.rows || payload.rows || normalized.rows),
    ...normalizeArray(source.variants || source.variantRows || source.productVariants || source.skuVariants || source.offerVariants || editPayload.variants || payload.variants || normalized.variants),
    ...normalizeArray(source.offers || source.children || source.products || payload.offers || payload.products),
    ...normalizeArray(source.skus).map((item) => typeof item === "string" ? { sku: item } : item)
  ];
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row?.sku || row?.source_sku || row?.offer_id || row?.variantId || row?.variant_id || row?.id || "").trim();
    if (!key) continue;
    const next = { ...row, sku: row.sku || row.source_sku || key };
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeVariantRow(previous, next) : next);
  }
  return [...byKey.values()];
}

function mergeVariantRow(previous = {}, next = {}) {
  const merged = { ...previous, ...next };
  for (const key of ["images", "image_urls", "imageUrls", "video_urls", "videos", "hashtags", "attributes", "attribute_values", "characteristics"]) {
    const values = [...normalizeArray(previous[key]), ...normalizeArray(next[key])];
    if (values.length) merged[key] = dedupeLoose(values);
  }
  merged.dynamic_attributes = mergeDynamicAttributes(previous.dynamic_attributes, previous.dynamicAttributes, next.dynamic_attributes, next.dynamicAttributes);
  for (const key of ["title", "name", "cover_image", "coverImage", "primary_image", "primaryImage", "main_image", "mainImage", "searchable_text", "searchableText"]) {
    merged[key] = next[key] || previous[key] || "";
  }
  return merged;
}

function dedupeLoose(values = []) {
  const seen = new Set();
  return values.filter((item) => {
    const key = typeof item === "object" ? JSON.stringify(item) : String(item || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function variantImages(row = {}, productImages = [], multiVariant = false) {
  const own = normalizeImages([
    row.cover_image || row.coverImage || row.primary_image || row.primaryImage || row.main_image || row.mainImage || "",
    ...normalizeArray(row.images || row.image_urls || row.imageUrls)
  ]);
  if (own.length) return own;
  return multiVariant ? normalizeImages(productImages).slice(0, 1) : normalizeImages(productImages);
}

function normalizeVariant(row = {}, source = {}, dimensions = {}, tags = [], productImages = [], multiVariant = false, index = 0) {
  const rowDimensions = normalizeDimensions(row, dimensions);
  const sku = String(row.sku || row.source_sku || source.sku || "").trim();
  const rowAttributes = normalizeAttributes(row.attributes || row.attribute_values || row.characteristics || []);
  const dynamicAttributes = mergeDynamicAttributes(
    attributesToDynamicAttributes(rowAttributes),
    row.dynamic_attributes,
    row.dynamicAttributes
  );
  return {
    sku,
    source_sku: sku,
    source_offer_id: String(row.source_offer_id || row.seller_offer_id || row.offer_id || "").trim(),
    offer_id: "",
    name: String(row.name || row.title || source.title || source.productTitle || "").trim(),
    title: String(row.title || row.name || source.title || source.productTitle || "").trim(),
    images: variantImages(row, productImages, multiVariant),
    video_cover_urls: normalizeStringList(row.video_cover_urls || row.cover_video_urls || row.cover_video || row.video_cover),
    video_urls: normalizeStringList(row.video_urls || row.videos || row.videoUrls || row.video_url),
    barcode: String(row.barcode || normalizeArray(row.barcodes)[0] || "").trim(),
    cost_price: 0,
    price: numberValue(row.price || row.sell_price || row.cardPrice || source.price || 0),
    old_price: numberValue(row.old_price || row.oldPrice || row.originalPrice || source.old_price || source.originalPrice || 0),
    color: String(row.color || "").trim(),
    spec: String(row.spec || row.searchable_text || row.searchableText || "").trim(),
    main_tags: normalizeTagList(row.hashtags || row.main_tags || tags),
    attributes: rowAttributes,
    dynamic_attributes: dynamicAttributes,
    weight_g: rowDimensions.weight_g || dimensions.weight_g || 0,
    length_cm: rowDimensions.length_cm || dimensions.length_cm || 0,
    width_cm: rowDimensions.width_cm || dimensions.width_cm || 0,
    height_cm: rowDimensions.height_cm || dimensions.height_cm || 0,
    length_mm: Math.round(Number(rowDimensions.length_cm || dimensions.length_cm || 0) * 10),
    width_mm: Math.round(Number(rowDimensions.width_cm || dimensions.width_cm || 0) * 10),
    height_mm: Math.round(Number(rowDimensions.height_cm || dimensions.height_cm || 0) * 10),
    stock: Number(row.stock || row.quantity || 0),
    sort_order: Number(row.sort_order || index + 1)
  };
}

function buildOzonCategoryKey({ description_category_id = "", type_id = "", category_id = "", fallback = "" } = {}) {
  const descriptionCategoryId = String(description_category_id || "").trim();
  const typeId = String(type_id || "").trim();
  if (descriptionCategoryId && typeId) return `${descriptionCategoryId}:${typeId}`;
  return String(category_id || fallback || "").trim();
}

function unwrapSource(body = {}) {
  const data = body.data || body.detail || body.normalized || body.payload || body;
  if (data?.editPayload && Object.keys(data).length <= 3) return { ...data.editPayload, collectionId: data.collectionId || data.id };
  return data;
}

export function prepareListingDraftFromCollectedSource(body = {}, options = {}) {
  const source = unwrapSource(body);
  const editPayload = objectValue(source.editPayload || source.edit_payload || source.editable_payload || {});
  const followPayload = objectValue(source.followEditPayload || source.follow_edit_payload || editPayload.followEditPayload || {});
  const rows = collectVariantRows(source, editPayload, followPayload);
  const attributes = normalizeAttributes(source.attributes || editPayload.attributes || followPayload.attributes || []);
  const hashtags = normalizeTagList(firstFilled(
    source.hashtags, source.tags, source.keywords, source.main_tags,
    editPayload.hashtags, editPayload.tags, editPayload.keywords,
    followPayload.hashtags, followPayload.tags,
    pickAttributeValue(attributes, [], ["tag", "keyword", "hashtag", "标签"])
  ));
  const images = normalizeImages(
    source.images ||
    editPayload.images ||
    [source.mainImage || source.main_image || source.productImage || editPayload.mainImage || editPayload.main_image].concat(rows.flatMap((item) => item.images || []))
  );
  const title = String(source.title || source.productTitle || source.name || editPayload.title || rows[0]?.title || "").trim();
  const description = String(firstFilled(
    source.description,
    source.annotation,
    source.description_text,
    source.short_description,
    editPayload.description,
    editPayload.summary,
    followPayload.description,
    rows[0]?.description,
    pickAttributeValue(attributes, [4191], ["description", "annotation", "简介", "Описание"])
  )).trim();
  const jsonContent = firstFilled(
    source.jsonContent,
    source.json_content,
    source.richContent,
    source.rich_content,
    source.richContentJson,
    source.rich_content_json,
    editPayload.jsonContent,
    editPayload.json_content,
    editPayload.richContent,
    editPayload.rich_content,
    editPayload.richContentJson,
    editPayload.rich_content_json,
    followPayload.jsonContent,
    followPayload.json_content,
    followPayload.richContent,
    followPayload.rich_content,
    pickAttributeValue(attributes, [11254], ["rich", "json", "富内容"])
  );
  const richText = typeof jsonContent === "string" ? jsonContent : (jsonContent ? JSON.stringify(jsonContent, null, 2) : "");
  const dimensions = normalizeDimensions(source, editPayload, rows[0]);
  const rawCategoryIds = Array.isArray(source.category_ids) ? source.category_ids : [];
  const descriptionCategoryId = String(
    options.description_category_id || options.descriptionCategoryId ||
    body.description_category_id || body.descriptionCategoryId ||
    editPayload.description_category_id || editPayload.descriptionCategoryId ||
    source.description_category_id || source.descriptionCategoryId ||
    source.category2Id || (rawCategoryIds.length >= 3 ? rawCategoryIds[rawCategoryIds.length - 2] : "") ||
    ""
  ).trim();
  const typeId = String(
    options.type_id || options.typeId ||
    body.type_id || body.typeId ||
    source.type_id || source.typeId || editPayload.type_id || editPayload.typeId ||
    source.category3Id || (rawCategoryIds.length >= 3 ? rawCategoryIds[rawCategoryIds.length - 1] : "") ||
    ""
  ).trim();
  const legacyCategoryId = String(source.ozon_category_id || source.category_id || editPayload.category_id || "").trim();
  const ozonCategoryId = buildOzonCategoryKey({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_id: legacyCategoryId,
    fallback: `frontend:${source.sku || source.productId || source.collectionId || source.id || Date.now()}`
  });
  const categoryName = String(
    options.category_name || options.categoryName ||
    body.category_name || body.categoryName ||
    source.category || source.category_name || source.categoryName ||
    (ozonCategoryId ? `Ozon 类目 ${ozonCategoryId}` : "")
  ).trim();
  const enrichedAttributes = attributes.slice();
  upsertAttribute(enrichedAttributes, ["Brand", "品牌", "Бренд"], attributeValueByIdsOrNames(attributes, [85], ["brand", "бренд", "品牌"]) || source.brand || "无品牌", { attribute_id: 85, required: true });
  upsertAttribute(enrichedAttributes, ["Model name", "型号名称", "Модель"], attributeValueByIdsOrNames(attributes, [9048], ["model", "型号", "модель"]) || rows[0]?.spec || String(source.sku || source.productId || ""), { attribute_id: 9048, required: true });
  upsertAttribute(enrichedAttributes, ["Product tags", "主题标签"], hashtags.join(" "), { source: "listing_draft_preparer" });
  upsertAttribute(enrichedAttributes, ["Description", "简介"], description, { attribute_id: 4191, type: "textarea" });
  upsertAttribute(enrichedAttributes, ["Rich content JSON", "JSON富内容"], richText, { attribute_id: 11254, type: "rich_json" });
  const variants = rows.length
    ? rows.map((item, index) => normalizeVariant(item, { ...source, title }, dimensions, hashtags, images, rows.length > 1, index))
    : [normalizeVariant({
      sku: source.sku || source.productId || "",
      title,
      images,
      price: source.price || editPayload.price,
      old_price: source.originalPrice || source.old_price,
      hashtags
    }, source, dimensions, hashtags, images, false, 0)];
  const sku = String(source.sku || source.productId || editPayload.sku || variants[0]?.source_sku || "").trim();
  const editablePayload = {
    sku,
    product_id: String(source.productId || source.product_id || sku || ""),
    title,
    description,
    rich_content: jsonContent || null,
    rich_content_json: richText,
    category_id: ozonCategoryId,
    legacy_category_id: legacyCategoryId,
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_name: categoryName || "Ozon 前台采集模板",
    price: {
      value: numberValue(source.price || editPayload.price || rows[0]?.price || 0),
      old_price: numberValue(source.originalPrice || source.old_price || rows[0]?.old_price || 0),
      currency_code: source.currency || editPayload.currency || followPayload.currecny || "RUB",
      vat: String(source.vat || editPayload.vat || "0")
    },
    dimensions,
    logistics: {
      brand: attributeValueByIdsOrNames(enrichedAttributes, [85], ["brand", "бренд", "品牌"]) || "无品牌",
      color: attributeValueByIdsOrNames(enrichedAttributes, [10096, 8229], ["color", "цвет", "颜色"]) || "",
      spec: attributeValueByIdsOrNames(enrichedAttributes, [9048], ["model", "型号", "модель"]) || "",
      tags: hashtags,
      quantity: 0
    },
    images,
    attributes: enrichedAttributes,
    variants,
    source_raw: {
      source_type: options.sourceType || "ozon_frontend_collect",
      source_id: options.sourceId || sku || source.collectionId || source.id || "",
      collected_product: body
    }
  };
  return {
    sourceType: options.sourceType || "ozon_frontend_collect",
    sourceId: options.sourceId || sku || source.collectionId || source.id || "",
    source,
    editPayload,
    followPayload,
    rows,
    category: {
      ozon_category_id: ozonCategoryId,
      category_name: categoryName || "Ozon 前台采集模板",
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      legacy_category_id: legacyCategoryId
    },
    title,
    description,
    images,
    attributes: enrichedAttributes,
    variants,
    editablePayload,
    missingFields: [
      title ? "" : "标题",
      images.length || variants.some((item) => item.images?.length) ? "" : "图片",
      descriptionCategoryId && typeId ? "" : "Ozon类目",
      dimensions.weight_g ? "" : "重量"
    ].filter(Boolean)
  };
}

export function listingDraftToTemplatePayload(draft = {}, body = {}) {
  const editablePayload = draft.editablePayload || {};
  return {
    ozon_category_id: draft.category?.ozon_category_id || editablePayload.category_id || "",
    category_name: draft.category?.category_name || editablePayload.category_name || "Ozon 前台采集模板",
    template_name: String(body.template_name || body.templateName || draft.source?.local_template_name || draft.source?.template_name || draft.title || `Ozon ${draft.sourceId || ""} 采集模板`).trim(),
    source_ozon_sku: String(draft.source?.sku || draft.source?.productId || draft.sourceId || "").trim(),
    source_raw: editablePayload.source_raw || {
      source_type: draft.sourceType || "ozon_frontend_collect",
      source_id: draft.sourceId || "",
      collected_product: body
    },
    required_attributes: [],
    ai_rules: {},
    image_rules: {},
    title: draft.title || "",
    description: draft.description || "",
    attributes: draft.attributes || [],
    images: draft.images || [],
    editable_payload: editablePayload
  };
}

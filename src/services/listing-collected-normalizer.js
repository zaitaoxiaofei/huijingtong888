import {
  listingDraftToTemplatePayload,
  prepareListingDraftFromCollectedSource
} from "./listing-draft-preparer.js";

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value && typeof value === "object") return numberValue(value.value ?? value.amount ?? value.price ?? "");
  const normalized = String(value || "").replace(",", ".").replace(/[^\d.-]/g, "");
  return Number(normalized || 0);
}

function normalizeImages(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.trim().startsWith("[") ? parseJson(value, []) : normalizeArray(value));
  const seen = new Set();
  return list.flat().map((item, index) => {
    const url = typeof item === "string" ? item : item?.url || item?.src || "";
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
  return String(value || "").split(/[,\s\r\n]+/).map((item) => item.trim()).filter(Boolean);
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
  return {
    length_cm: numberValue(firstValue("length_cm", "length")),
    width_cm: numberValue(firstValue("width_cm", "width")),
    height_cm: numberValue(firstValue("height_cm", "height")),
    weight_g: numberValue(firstValue("weight_g", "weight", "custom_weight"))
  };
}

function attributesToDynamicAttributes(attributes = []) {
  const result = {};
  for (const item of normalizeArray(attributes)) {
    if (!item || typeof item !== "object") continue;
    const attributeId = item.attribute_id || item.attributeId || item.id || "";
    const key = String(attributeId || item.name || item.attribute_name || "").trim();
    if (!key) continue;
    const values = normalizeArray(item.values).map((option) => ({
      id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      dictionary_value_id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim()
    })).filter((option) => option.value);
    const value = String(item.value ?? item.attribute_value ?? values.map((option) => option.value).join(", ") ?? "").trim();
    if (!value && !values.length) continue;
    result[key] = {
      attribute_id: attributeId,
      name: String(item.name || item.attribute_name || item.title || "").trim(),
      value,
      values,
      dictionary_id: item.dictionary_id || "",
      type: item.type || item.value_type || "text",
      source: item.source || "variant_attribute"
    };
  }
  return result;
}

function normalizeVariant(row = {}, source = {}, dimensions = {}, tags = [], index = 0) {
  const rowDimensions = normalizeDimensions(row, dimensions);
  const images = normalizeImages(row.images || row.image_urls || row.imageUrls || source.images || []);
  const sku = String(row.sku || row.source_sku || row.offer_id || source.sku || "").trim();
  const rowAttributes = normalizeArray(row.attributes || row.attribute_values || row.characteristics);
  return {
    sku,
    source_sku: sku,
    source_offer_id: String(row.source_offer_id || row.seller_offer_id || row.offer_id || "").trim(),
    offer_id: "",
    name: String(row.name || row.title || source.title || "").trim(),
    title: String(row.title || row.name || source.title || "").trim(),
    images,
    video_cover_urls: normalizeStringList(row.video_cover_urls || row.cover_video_urls || row.cover_video || row.video_cover),
    video_urls: normalizeStringList(row.video_urls || row.videos || row.videoUrls || row.video_url),
    barcode: String(row.barcode || normalizeArray(row.barcodes)[0] || "").trim(),
    cost_price: 0,
    price: numberValue(row.price || row.sell_price || row.cardPrice || source.price || 0),
    old_price: numberValue(row.old_price || row.oldPrice || row.originalPrice || source.old_price || 0),
    color: String(row.color || "").trim(),
    spec: String(row.spec || row.searchable_text || row.searchableText || "").trim(),
    main_tags: normalizeStringList(row.hashtags || row.main_tags || tags).map((item) => item.startsWith("#") ? item : `#${item}`),
    attributes: rowAttributes,
    dynamic_attributes: { ...attributesToDynamicAttributes(rowAttributes), ...(row.dynamic_attributes || row.dynamicAttributes || {}) },
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

function collectVariantRows(source = {}, editPayload = {}) {
  const payload = objectValue(source.payload || source.rawPayload || {});
  const normalized = objectValue(source.normalized || {});
  const sellerVariantBySku = collectSellerVariantBySku(source, editPayload, payload, normalized);
  const rows = [
    ...normalizeArray(source.editorVariants || source.editor_variants || editPayload.editorVariants || editPayload.editor_variants || payload.editorVariants || normalized.editorVariants),
    ...normalizeArray(source.rows || editPayload.rows || payload.rows || normalized.rows),
    ...normalizeArray(source.variants || source.variantRows || source.productVariants || source.skuVariants || source.offerVariants || editPayload.variants || payload.variants || normalized.variants),
    ...normalizeArray(source.offers || source.children || source.products || payload.offers || payload.products),
    ...normalizeArray(source.skus).map((item) => typeof item === "string" ? { sku: item } : item)
  ];
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row?.sku || row?.source_sku || row?.offer_id || row?.variantId || row?.variant_id || row?.id || "").trim();
    if (!key) continue;
    const next = mergeSellerVariantPatch({ ...row, sku: row.sku || row.source_sku || key }, sellerVariantBySku[key]);
    byKey.set(key, { ...(byKey.get(key) || {}), ...next });
  }
  return [...byKey.values()];
}

function collectSellerVariantBySku(...sources) {
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [sku, patch] of Object.entries(objectValue(source.sellerVariantBySku || source.seller_variant_by_sku))) {
      if (sku && patch && typeof patch === "object") result[String(sku).trim()] = patch;
    }
    for (const [sku, fallback] of Object.entries(objectValue(source.variantSellerFallbacks || source.variant_seller_fallbacks))) {
      const fields = objectValue(fallback?.fields || fallback);
      if (sku && Object.keys(fields).length) result[String(sku).trim()] = { ...(result[String(sku).trim()] || {}), ...fields };
    }
  }
  return result;
}

function mergeSellerVariantPatch(row = {}, patch = {}) {
  if (!patch || typeof patch !== "object") return row;
  const attributes = mergeAttributesByKey(row.attributes || row.attribute_values || row.characteristics || [], patch.attributes || []);
  return {
    ...row,
    ...(patch.variantId ? { variantId: patch.variantId } : {}),
    ...(patch.variantName ? { variantName: patch.variantName } : {}),
    ...(patch.origin_variant_id ? { origin_variant_id: patch.origin_variant_id } : {}),
    ...(patch.bundle_id ? { bundle_id: patch.bundle_id } : {}),
    ...(patch.barcode && !row.barcode ? { barcode: patch.barcode } : {}),
    attributes: attributes.length ? attributes : row.attributes
  };
}

function mergeAttributesByKey(...sources) {
  const byKey = new Map();
  for (const attr of sources.flatMap((source) => normalizeArray(source))) {
    if (!attr || typeof attr !== "object") continue;
    const key = String(attr.attribute_id || attr.attributeId || attr.id || attr.name || attr.attribute_name || "").trim();
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) || {}), ...attr });
  }
  return [...byKey.values()];
}

function categoryNameFromResolved(resolvedCategory = {}, editPayload = {}, detail = {}, raw = {}) {
  return resolvedCategory?.path_zh ||
    resolvedCategory?.pathZh ||
    resolvedCategory?.name_zh ||
    resolvedCategory?.nameZh ||
    editPayload.category_name ||
    detail.category_name ||
    raw.category_name ||
    raw.category ||
    "";
}

function buildDiagnostics({ descriptionCategoryId, typeId, categoryName, attributes = [], variants = [], images = [], draft = {} } = {}) {
  const missingRequiredAttributes = normalizeArray(attributes)
    .filter((item) => Boolean(item.required || item.is_required) && (item.value === undefined || item.value === null || item.value === "" || (Array.isArray(item.value) && !item.value.length)))
    .map((item) => ({
      attribute_id: item.attribute_id || item.id || "",
      name: item.name || "",
      type: item.type || ""
    }));
  const unknownAttributes = normalizeArray(attributes)
    .filter((item) => item.value && !item.attribute_id)
    .map((item) => ({ name: item.name || "", value: item.value, source: item.source || "" }));
  return {
    version: 1,
    category: {
      ok: Boolean(descriptionCategoryId && typeId),
      description_category_id: descriptionCategoryId || "",
      type_id: typeId || "",
      name: categoryName || "",
      confidence: descriptionCategoryId && typeId ? "resolved" : "manual_needed"
    },
    attributes: {
      total: normalizeArray(attributes).length,
      missing_required: missingRequiredAttributes,
      unknown: unknownAttributes
    },
    variants: {
      total: normalizeArray(variants).length,
      with_images: normalizeArray(variants).filter((item) => normalizeArray(item.images).length).length
    },
    media: {
      images: normalizeArray(images).length
    },
    missing_fields: normalizeArray(draft.missingFields)
  };
}

export async function normalizeCollectedListingDraft(input = {}, options = {}) {
  const detail = input.detail || {};
  const body = input.body || {};
  const raw = detail.rawPayload || detail.raw_payload || input.raw || {};
  const normalizeEditPayload = options.normalizeEditPayload || ((value) => objectValue(value));
  const editPayload = input.editPayload || normalizeEditPayload(body.editPayload || body.edit_payload || {}, detail);
  const resolvedCategory = input.resolvedCategory || (options.resolveCategory ? await options.resolveCategory(detail, body) : null);
  const resolvedDescriptionCategoryId = resolvedCategory?.description_category_id || resolvedCategory?.descriptionCategoryId || "";
  const resolvedTypeId = resolvedCategory?.type_id || resolvedCategory?.typeId || "";
  const directDescriptionCategoryId = editPayload.description_category_id || raw.description_category_id || raw.descriptionCategoryId || "";
  const directTypeId = editPayload.type_id || raw.type_id || raw.typeId || "";
  const descriptionCategoryId = String(resolvedDescriptionCategoryId || (directDescriptionCategoryId && directTypeId ? directDescriptionCategoryId : "") || "").trim();
  const typeId = String(resolvedTypeId || (directDescriptionCategoryId && directTypeId ? directTypeId : "") || "").trim();
  const categoryName = categoryNameFromResolved(resolvedCategory, editPayload, detail, raw);
  const ozonCategoryId = resolvedCategory?.ozon_category_id ||
    resolvedCategory?.ozonCategoryId ||
    editPayload.ozon_category_id ||
    (descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "") ||
    raw.ozon_category_id ||
    raw.category_id ||
    "";
  const imageNormalizer = options.normalizeImages || normalizeImages;
  const images = imageNormalizer([
    ...(normalizeArray(editPayload.images).length ? normalizeArray(editPayload.images) : []),
    ...normalizeArray(raw.images),
    ...normalizeArray(raw.secondary_images || raw.secondaryImages),
    detail.image_url
  ]);
  const buildAttributes = options.buildAttributes || (() => normalizeArray(raw.attributes || raw.attribute_values || raw.characteristics || editPayload.attributes));
  const mergeAttributes = options.mergeAttributeDefinitions || (async (items) => items);
  const attributes = await mergeAttributes(buildAttributes(editPayload, raw), descriptionCategoryId, typeId);
  const rowCollector = options.collectVariantRows || collectVariantRows;
  const variantNormalizer = options.normalizeVariant || normalizeVariant;
  const variantImagePicker = options.variantImages || ((item, productImages) => imageNormalizer(item.images || item.image_urls || item.imageUrls || productImages));
  const dimensionNormalizer = options.normalizeDimensions || normalizeDimensions;
  const dimensions = dimensionNormalizer(editPayload, raw);
  const variantRows = rowCollector(raw, editPayload, {});
  const variants = variantRows.map((item, index) => variantNormalizer({
    ...item,
    title: item.title || item.name || editPayload.title || detail.title,
    price: item.price || item.sell_price || item.cardPrice || editPayload.price || detail.price,
    old_price: item.old_price || item.oldPrice || raw.old_price || raw.originalPrice,
    images: variantImagePicker(item, images, variantRows.length > 1),
    barcode: item.barcode || normalizeArray(raw.barcodes)[index] || normalizeArray(raw.barcodes)[0] || "",
    stock: item.stock || raw.stock || raw.fbsStock || raw.fboStock || 0
  }, { ...raw, title: editPayload.title || detail.title, images }, dimensions, editPayload.tags || raw.hashtags || [], index));
  const finalVariants = variants.length ? variants : [variantNormalizer({
    sku: detail.sku,
    title: editPayload.title || detail.title,
    price: editPayload.price || detail.price || 0,
    old_price: editPayload.old_price || raw.old_price || raw.originalPrice || 0,
    images,
    color: editPayload.color || "",
    spec: editPayload.model || "",
    hashtags: editPayload.tags || [],
    barcode: normalizeArray(raw.barcodes)[0] || ""
  }, { ...raw, title: editPayload.title || detail.title, images }, dimensions, editPayload.tags || raw.hashtags || [], 0)];
  const payload = {
    ...raw,
    ...editPayload,
    sku: detail.sku,
    productId: detail.product_id || raw.productId || raw.product_id || "",
    productTitle: editPayload.title || detail.title,
    title: editPayload.title || detail.title,
    name: editPayload.title || detail.title,
    productUrl: detail.product_url || raw.productUrl || "",
    productImage: images[0]?.url || detail.image_url || raw.productImage || "",
    images,
    category_name: categoryName,
    category: categoryName,
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    ozon_category_id: ozonCategoryId,
    price: editPayload.price || detail.price || raw.price || "",
    currency: editPayload.currency || detail.currency || raw.currency || "RUB",
    description: editPayload.description || raw.description || "",
    attributes,
    hashtags: editPayload.tags || raw.hashtags || [],
    dimensions,
    variants: finalVariants,
    editPayload
  };
  const draft = prepareListingDraftFromCollectedSource(payload, {
    sourceType: options.sourceType || "collector_box",
    sourceId: detail.sku,
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_name: categoryName
  });
  const diagnostics = buildDiagnostics({
    descriptionCategoryId,
    typeId,
    categoryName,
    attributes: draft.attributes || attributes,
    variants: finalVariants,
    images,
    draft
  });
  draft.editablePayload = {
    ...draft.editablePayload,
    normalization_diagnostics: diagnostics,
    source_raw: {
      ...(draft.editablePayload?.source_raw || {}),
      normalization_diagnostics: diagnostics
    }
  };
  const templatePayload = listingDraftToTemplatePayload(draft, {
    ...payload,
    template_name: body.template_name || editPayload.template_name || `${editPayload.title || detail.title || detail.sku} listing template`
  });
  templatePayload.source_raw = {
    ...(templatePayload.source_raw || {}),
    normalization_diagnostics: diagnostics
  };
  templatePayload.editable_payload = {
    ...(templatePayload.editable_payload || {}),
    normalization_diagnostics: diagnostics
  };
  return {
    editPayload,
    raw,
    resolvedCategory,
    payload,
    draft,
    templatePayload,
    diagnostics
  };
}

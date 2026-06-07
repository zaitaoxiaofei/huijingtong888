function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function parseCategoryKey(value = "") {
  const [descriptionCategoryId, typeId] = String(value || "").split(":").map((item) => Number(item || 0));
  return {
    descriptionCategoryId: Number.isFinite(descriptionCategoryId) ? descriptionCategoryId : 0,
    typeId: Number.isFinite(typeId) ? typeId : 0
  };
}

function buildCategoryKey(descriptionCategoryId, typeId, fallback = "") {
  const descriptionId = Number(descriptionCategoryId || 0);
  const productTypeId = Number(typeId || 0);
  return descriptionId && productTypeId ? `${descriptionId}:${productTypeId}` : String(fallback || "").trim();
}

function categoryIdsFromPayload(payload = {}) {
  const editable = objectValue(payload.editable_payload || payload.editablePayload || {});
  const category = objectValue(payload.category || {});
  const key = String(
    payload.ozon_category_id
    || payload.ozonCategoryId
    || editable.ozon_category_id
    || editable.ozonCategoryId
    || editable.category_id
    || editable.categoryId
    || editable.legacy_category_id
    || editable.legacyCategoryId
    || category.ozon_category_id
    || category.ozonCategoryId
    || ""
  ).trim();
  const parsed = parseCategoryKey(key);
  const descriptionCategoryId = Number(
    payload.description_category_id
    || payload.descriptionCategoryId
    || editable.description_category_id
    || editable.descriptionCategoryId
    || category.description_category_id
    || category.descriptionCategoryId
    || parsed.descriptionCategoryId
    || 0
  );
  const typeId = Number(
    payload.type_id
    || payload.typeId
    || editable.type_id
    || editable.typeId
    || category.type_id
    || category.typeId
    || parsed.typeId
    || 0
  );
  return {
    descriptionCategoryId: Number.isFinite(descriptionCategoryId) ? descriptionCategoryId : 0,
    typeId: Number.isFinite(typeId) ? typeId : 0,
    categoryKey: buildCategoryKey(descriptionCategoryId || parsed.descriptionCategoryId, typeId || parsed.typeId, key)
  };
}

function categoryNameFrom(payload = {}, resolvedCategory = null) {
  const editable = objectValue(payload.editable_payload || payload.editablePayload || {});
  const category = objectValue(payload.category || {});
  return String(
    resolvedCategory?.path_zh
    || resolvedCategory?.category_name
    || resolvedCategory?.name_zh
    || resolvedCategory?.pathZh
    || resolvedCategory?.nameZh
    || payload.category_name
    || payload.categoryName
    || editable.category_name
    || editable.categoryName
    || category.category_name
    || category.name
    || ""
  ).trim();
}

function mergeStandardizerMeta(sourceRaw = {}, meta = {}) {
  return {
    ...objectValue(sourceRaw),
    listing_template_standardizer: {
      ...(objectValue(sourceRaw).listing_template_standardizer || {}),
      ...meta,
      standardized_at: new Date().toISOString()
    }
  };
}

export async function standardizeListingTemplatePayload(payload = {}, options = {}) {
  const editable = objectValue(payload.editable_payload || payload.editablePayload || {});
  const sourceRaw = objectValue(payload.source_raw || payload.sourceRaw || editable.source_raw || editable.sourceRaw || {});
  const sourceType = String(options.sourceType || payload.source_type || sourceRaw.source_type || "").trim();
  const sourceId = String(options.sourceId || payload.source_ozon_sku || editable.sku || sourceRaw.offer_id || "").trim();
  const baseAttributes = normalizeArray(payload.attributes && payload.attributes.length ? payload.attributes : editable.attributes);
  const baseImages = normalizeArray(payload.images && payload.images.length ? payload.images : editable.images);
  let categoryIds = categoryIdsFromPayload(payload);
  let resolvedCategory = null;

  if ((!categoryIds.descriptionCategoryId || !categoryIds.typeId) && typeof options.resolveCategory === "function") {
    resolvedCategory = await options.resolveCategory(payload, baseAttributes).catch(() => null);
    categoryIds = {
      descriptionCategoryId: Number(resolvedCategory?.description_category_id || resolvedCategory?.descriptionCategoryId || 0),
      typeId: Number(resolvedCategory?.type_id || resolvedCategory?.typeId || 0),
      categoryKey: buildCategoryKey(
        resolvedCategory?.description_category_id || resolvedCategory?.descriptionCategoryId,
        resolvedCategory?.type_id || resolvedCategory?.typeId,
        categoryIds.categoryKey
      )
    };
  }

  const categoryKey = buildCategoryKey(categoryIds.descriptionCategoryId, categoryIds.typeId, categoryIds.categoryKey);
  const categoryName = categoryNameFrom(payload, resolvedCategory);
  const normalizedAttributes = categoryIds.descriptionCategoryId && categoryIds.typeId && typeof options.mergeCategoryAttributeDefinitions === "function"
    ? await options.mergeCategoryAttributeDefinitions(baseAttributes, categoryIds.descriptionCategoryId, categoryIds.typeId, {
      autoSync: options.autoSync,
      auto_sync: options.autoSync,
      syncValues: options.syncValues,
      sync_values: options.syncValues
    }).catch(() => baseAttributes)
    : baseAttributes;

  const nextSourceRaw = mergeStandardizerMeta(sourceRaw, {
    source_type: sourceType,
    source_id: sourceId,
    category_resolved_from: resolvedCategory?.source || "",
    description_category_id: categoryIds.descriptionCategoryId || "",
    type_id: categoryIds.typeId || "",
    attribute_count: normalizedAttributes.length
  });

  const nextPayload = {
    ...payload,
    ozon_category_id: categoryKey,
    category_name: categoryName,
    source_raw: nextSourceRaw,
    attributes: normalizedAttributes,
    images: baseImages,
    editable_payload: {
      ...editable,
      category_id: categoryKey,
      ozon_category_id: categoryKey,
      legacy_category_id: categoryKey,
      category_name: categoryName,
      description_category_id: categoryIds.descriptionCategoryId ? String(categoryIds.descriptionCategoryId) : "",
      type_id: categoryIds.typeId ? String(categoryIds.typeId) : "",
      attributes: normalizedAttributes,
      images: baseImages,
      source_raw: nextSourceRaw
    }
  };

  if (typeof options.buildDiagnostics === "function") {
    const diagnostics = await options.buildDiagnostics({
      sourceType,
      sourceId,
      title: nextPayload.title || nextPayload.editable_payload.title || "",
      category: {
        ozon_category_id: categoryKey,
        category_name: categoryName,
        description_category_id: categoryIds.descriptionCategoryId,
        type_id: categoryIds.typeId
      },
      attributes: normalizedAttributes,
      variants: nextPayload.editable_payload.variants || nextPayload.variants || [],
      images: baseImages,
      normalizationDiagnostics: nextSourceRaw.listing_template_standardizer,
      shopId: options.shopId,
      autoSync: options.autoSync !== false
    }).catch(() => null);
    if (diagnostics) {
      nextPayload.mapping_diagnostics = diagnostics;
      nextPayload.editable_payload.mapping_diagnostics = diagnostics;
      nextPayload.source_raw = mergeStandardizerMeta(nextSourceRaw, {
        diagnostics_summary: diagnostics.summary || {}
      });
      nextPayload.editable_payload.source_raw = nextPayload.source_raw;
    }
  }

  return nextPayload;
}

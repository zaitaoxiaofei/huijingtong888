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

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeStringList(item));
  if (value && typeof value === "object") return normalizeStringList(value.value || value.name || value.text || "");
  return String(value || "").split(/[,\s\r\n]+/).map((item) => item.trim()).filter(Boolean);
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
    const normalizedUrl = normalizeString(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) return null;
    seen.add(normalizedUrl);
    return {
      ...(item && typeof item === "object" ? item : {}),
      url: normalizedUrl,
      name: normalizeString(item?.name || ""),
      sort_order: Number(item?.sort_order || item?.sortOrder || index + 1)
    };
  }).filter(Boolean);
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

function normalizeAttributeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") return item.value ?? item.name ?? item.text ?? JSON.stringify(item);
      return item;
    }).map((item) => normalizeString(item)).filter(Boolean);
  }
  if (value && typeof value === "object") {
    const text = firstFilled(value.value, value.name, value.text, value.label);
    return text ? [normalizeString(text)] : [];
  }
  const text = normalizeString(value);
  return text ? [text] : [];
}

function normalizeAttributes(value) {
  return normalizeArray(value).map((item, index) => {
    if (typeof item === "string") {
      return {
        attribute_id: "",
        name: normalizeString(item),
        values: [],
        source: "raw_attribute",
        sort_order: index + 1
      };
    }
    const values = normalizeArray(item?.values).flatMap((option) => {
      if (option && typeof option === "object") {
        const valueText = normalizeString(option.value ?? option.name ?? option.text ?? option.label ?? "");
        if (!valueText && !Number(option.dictionary_value_id || option.id || option.value_id || 0)) return [];
        return [{
          value: valueText,
          dictionary_value_id: option.dictionary_value_id ?? option.id ?? option.value_id ?? "",
          label: normalizeString(option.label || option.display_value_zh || "")
        }];
      }
      const valueText = normalizeString(option);
      return valueText ? [{ value: valueText, dictionary_value_id: "", label: "" }] : [];
    });
    const flatValues = values.length
      ? values
      : normalizeAttributeValue(item?.value ?? item?.attribute_value).map((text) => ({ value: text, dictionary_value_id: "", label: "" }));
    return {
      attribute_id: normalizeString(item?.attribute_id || item?.attributeId || item?.id || ""),
      name: normalizeString(item?.name || item?.attribute_name || item?.title || ""),
      values: flatValues,
      dictionary_id: normalizeString(item?.dictionary_id || ""),
      required: Boolean(item?.required || item?.is_required),
      source: normalizeString(item?.source || "raw_attribute"),
      sort_order: Number(item?.sort_order || index + 1)
    };
  }).filter((item) => item.attribute_id || item.name || item.values.length);
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

function buildCategoryHints(detail = {}, raw = {}, editPayload = {}) {
  const categoryIds = normalizeArray(firstFilled(raw.category_ids, detail.category_ids, editPayload.category_ids))
    .map((item) => normalizeString(item))
    .filter(Boolean);
  return {
    category_name: normalizeString(firstFilled(detail.category_name, raw.category_name, raw.category, editPayload.category_name)),
    category_text: normalizeString(firstFilled(raw.category, raw.category_name, detail.category_name)),
    leaf_name: normalizeString(firstFilled(raw.category3, raw.categoryName)),
    description_category_id: normalizeString(firstFilled(editPayload.description_category_id, raw.description_category_id, raw.descriptionCategoryId)),
    type_id: normalizeString(firstFilled(editPayload.type_id, raw.type_id, raw.typeId)),
    category_ids: categoryIds
  };
}

function buildSourceCoverage({ rawAttributes = [], normalizedAttributes = [], variants = [], images = [], detail = {}, editPayload = {}, raw = {} } = {}) {
  return {
    raw_attribute_count: normalizeAttributes(rawAttributes).length,
    normalized_attribute_count: normalizeAttributes(normalizedAttributes).length,
    variant_count: normalizeArray(variants).length,
    image_count: normalizeImages(images).length,
    has_description: Boolean(normalizeString(firstFilled(editPayload.description, detail.description))),
    has_rich_content: Boolean(firstFilled(editPayload.rich_content_json, editPayload.richContentJson, raw?.rich_content_json, raw?.json_content))
  };
}

function normalizeVariantFacts(row = {}, productImages = [], fallbackAttributes = [], index = 0) {
  const images = normalizeImages(row.images || row.image_urls || row.imageUrls || productImages);
  const attributes = normalizeAttributes(row.attributes || row.attribute_values || row.characteristics || fallbackAttributes);
  const dimensions = normalizeDimensions(row);
  return {
    sku: normalizeString(row.sku || row.source_sku || row.offer_id || ""),
    title: normalizeString(row.title || row.name || ""),
    images,
    attributes,
    logistics: {
      weight_g: dimensions.weight_g,
      length_cm: dimensions.length_cm,
      width_cm: dimensions.width_cm,
      height_cm: dimensions.height_cm
    },
    tags: normalizeStringList(row.hashtags || row.main_tags),
    sort_order: Number(row.sort_order || index + 1)
  };
}

export function buildCollectedProductFacts(input = {}, options = {}) {
  const detail = objectValue(input.detail || {});
  const body = objectValue(input.body || {});
  const raw = objectValue(detail.rawPayload || detail.raw_payload || input.raw || {});
  const normalizeEditPayload = options.normalizeEditPayload || ((value) => objectValue(value));
  const editPayload = objectValue(input.editPayload || normalizeEditPayload(body.editPayload || body.edit_payload || {}, detail));
  const productImages = normalizeImages([
    ...normalizeArray(editPayload.images),
    ...normalizeArray(raw.images),
    ...normalizeArray(raw.secondary_images || raw.secondaryImages),
    detail.image_url
  ]);
  const rawAttributes = [
    ...normalizeArray(raw.attributes || raw.attribute_values || raw.characteristics || []),
    ...normalizeArray(editPayload.attributes)
  ];
  const normalizedAttributes = normalizeAttributes(rawAttributes);
  const rowCollector = options.collectVariantRows || (() => []);
  const rawRows = rowCollector(raw, editPayload, {});
  const variantFacts = rawRows.map((row, index) => normalizeVariantFacts(
    row,
    productImages,
    rawRows.length > 1 ? [] : normalizedAttributes,
    index
  )).filter((item) => item.sku || item.title || item.images.length || item.attributes.length);
  const logistics = normalizeDimensions(editPayload, raw);
  return {
    version: 1,
    base: {
      sku: normalizeString(detail.sku || raw.sku || editPayload.sku || ""),
      title: normalizeString(firstFilled(editPayload.title, detail.title, raw.title, raw.name)),
      description: normalizeString(firstFilled(editPayload.description, raw.description, detail.description)),
      currency: normalizeString(firstFilled(editPayload.currency, detail.currency, raw.currency, "RUB")),
      price: numberValue(firstFilled(editPayload.price, detail.price, raw.price, 0)),
      old_price: numberValue(firstFilled(editPayload.old_price, raw.old_price, raw.originalPrice, 0)),
      brand: normalizeString(firstFilled(editPayload.brand, raw.brand, detail.brand)),
      color: normalizeString(firstFilled(editPayload.color, raw.color, detail.color)),
      tags: [...new Set(normalizeStringList(firstFilled(editPayload.tags, raw.hashtags, detail.hashtags)))]
    },
    media: {
      images: productImages,
      video_urls: [...new Set(normalizeStringList(firstFilled(editPayload.video_urls, raw.video_urls, raw.videos, detail.video_urls, detail.videos)))]
    },
    logistics,
    categoryHints: buildCategoryHints(detail, raw, editPayload),
    attributes: normalizedAttributes,
    variants: variantFacts,
    sourceCoverage: buildSourceCoverage({
      rawAttributes,
      normalizedAttributes,
      variants: variantFacts,
      images: productImages,
      detail,
      editPayload,
      raw
    }),
    rawSources: {
      has_raw_payload: Boolean(Object.keys(raw).length),
      has_edit_payload: Boolean(Object.keys(editPayload).length),
      has_detail: Boolean(Object.keys(detail).length)
    }
  };
}

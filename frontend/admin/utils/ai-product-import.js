export function normalizeImportRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function normalizeImportCandidate(row = {}, source = "collector", index = 0) {
  const payload = parseMaybeJson(row.template_payload_json) || parseMaybeJson(row.template_payload) || parseMaybeJson(row.templatePayload) || parseMaybeJson(row.template_snapshot) || parseMaybeJson(row.templateSnapshot) || parseMaybeJson(row.listing_template) || parseMaybeJson(row.listingTemplate) || parseMaybeJson(row.editable_payload) || parseMaybeJson(row.editablePayload) || parseMaybeJson(row.payload) || {};
  const editable = payload.editable_payload || payload.editablePayload || parseMaybeJson(row.editable_payload_json) || parseMaybeJson(row.editable_payload) || parseMaybeJson(row.editablePayload) || {};
  const normalized = row.normalized || payload.normalized || {};
  const normalizedPayload = normalized.payload || {};
  const normalizedEditable = normalized.editPayload || normalized.edit_payload || normalized.editable_payload || {};
  const manualFacts = parseMaybeJson(row.manual_facts_json) || parseMaybeJson(row.manual_facts) || row.manualFacts || {};
  const productDetail = row.productDetail || row.product_detail || normalized.productDetail || normalized.product_detail || {};
  const firstVariant = Array.isArray(editable.variants) ? editable.variants[0] : (Array.isArray(payload.variants) ? payload.variants[0] : {});
  const images = uniqueList(normalizeImageList([
    row.draft_variant_primary_image,
    row.list_image_url,
    row.listImageUrl,
    row.draft_template_primary_image,
    row.image_url,
    row.main_image_url,
    row.primary_image,
    row.productImage,
    row.mainImage,
    firstVariant?.primary_image,
    firstVariant?.primaryImage,
    firstVariant?.images,
    editable.primary_image,
    editable.primaryImage,
    editable.images,
    payload.productImage,
    payload.mainImage,
    payload.image_url,
    payload.primary_image,
    payload.images,
    row.source_images,
    row.source_images_json,
    row.images,
    row.image_urls,
    productDetail.images,
    normalized.images,
    normalizedPayload.images
  ]));
  const details = uniqueList(normalizeImageList([
    row.detail_image_urls, row.detailImageUrls, row.detail_images, row.detailImages,
    payload.detail_image_urls, payload.detailImageUrls, payload.detail_images, payload.detailImages,
    editable.detail_image_urls, editable.detailImageUrls, editable.detail_images, editable.detailImages,
    normalized.detail_image_urls, normalized.detailImageUrls, normalized.detail_images, normalized.detailImages,
    normalizedPayload.detail_image_urls, normalizedPayload.detailImageUrls, normalizedPayload.detail_images, normalizedPayload.detailImages,
    normalizedEditable.detail_image_urls, normalizedEditable.detailImageUrls, normalizedEditable.detail_images, normalizedEditable.detailImages,
    productDetail.detail_image_urls, productDetail.detailImageUrls, productDetail.detail_images, productDetail.detailImages,
    firstVariant?.detail_image_urls, firstVariant?.detailImageUrls, firstVariant?.detail_images, firstVariant?.detailImages,
    images.slice(1)
  ])).filter((url) => url !== images[0]);
  const title = firstValue(editable.title, firstVariant?.title, firstVariant?.name, manualFacts.title, payload.title, payload.name, row.title, row.name, row.product_name, row.subject, payload.product_name);
  const description = firstValue(row.description, row.description_text, row.selling_points, payload.description, payload.selling_points);
  const tags = normalizeTags(firstValue(row.tags, row.keywords, payload.tags, payload.keywords));
  const sourceSku = String(firstValue(row.sku, row.offer_id, row.product_id, row.internal_code, row.id, payload.sku, payload.offer_id) || "").trim();
  const sourceRaw = payload.source_raw || payload.sourceRaw || editable.source_raw || editable.sourceRaw || {};
  const sourceShopIds = normalizeShopIds([row.shop_ids, row.shopIds, row.shop_id, row.shopId, payload.shop_ids, payload.shopIds, payload.shop_id, payload.shopId, editable.shop_ids, editable.shopIds, editable.shop_id, editable.shopId, sourceRaw.shop_ids, sourceRaw.shopIds, sourceRaw.shop_id, sourceRaw.shopId]);
  const videoUrls = uniqueList(normalizeStringList(firstValue(row.video_urls, row.videoUrls, row.videos, payload.video_urls, payload.videoUrls, payload.videos, editable.video_urls, editable.videoUrls, editable.videos, firstVariant?.video_urls, firstVariant?.videoUrls, firstVariant?.videos)));
  const richContentJson = String(firstValue(row.rich_content_json, row.richContentJson, payload.rich_content_json, payload.richContentJson, editable.rich_content_json, editable.richContentJson, firstVariant?.rich_content_json, firstVariant?.richContentJson) || "").trim();
  return {
    id: `${source}-${sourceSku || index}`,
    index,
    source,
    sourceId: source === "draft" ? String(row.id || "").trim() : sourceSku || row.id || "",
    sourceDraftId: source === "draft" ? String(row.id || sourceSku || "").trim() : "",
    sourceShopIds,
    sourceSku,
    title: title || `商品 ${index + 1}`,
    description,
    tags,
    templateId: String(firstValue(row.template_id, row.templateId, row.listing_template_id, row.listingTemplateId, payload.template_id, payload.templateId) || "").trim(),
    imageUrl: images[0] || "",
    detailImages: details,
    videoUrls,
    richContentJson,
    templatePayload: payload,
    status: String(firstValue(row.status, payload.status, editable.status) || "").trim(),
    sourceVariantValue: inferVehicleModel([title, tags.join(" "), description].join(" ")),
    raw: row
  };
}

export function normalizeImportVariants(candidate = {}) {
  const payload = candidate.templatePayload || {};
  const editable = payload.editable_payload || payload.editablePayload || {};
  const variants = Array.isArray(editable.variants) && editable.variants.length
    ? editable.variants
    : (Array.isArray(payload.variants) ? payload.variants : []);
  if (variants.length <= 1) return [{ ...candidate, sourceVariantKey: variantKey(variants[0], 0), sourceVariantIndex: 0 }];
  return variants.map((variant, index) => {
    const variantImages = uniqueList(normalizeImageList([
      variant.primary_image, variant.primaryImage, variant.cover_image, variant.coverImage,
      variant.main_image, variant.mainImage, variant.images
    ]));
    const variantDetails = uniqueList(normalizeImageList([
      variant.detail_image_urls, variant.detailImageUrls, variant.detail_images, variant.detailImages,
      variantImages.slice(1)
    ])).filter((url) => url !== variantImages[0]);
    const key = variantKey(variant, index);
    const isolatedEditable = { ...editable, variants: [{ ...variant }] };
    return {
      ...candidate,
      id: `${candidate.id || "material"}-variant-${key}`,
      sourceSku: key || candidate.sourceSku,
      sourceVariantKey: key,
      sourceVariantIndex: index,
      title: firstValue(variant.title, variant.name, variant.product_name, candidate.title),
      imageUrl: variantImages[0] || candidate.imageUrl,
      detailImages: variantImages.length || variantDetails.length ? variantDetails : candidate.detailImages,
      templatePayload: { ...payload, editable_payload: isolatedEditable }
    };
  });
}

export function isImportCandidateVisible(row) {
  const status = String(row?.status || row?.raw?.status || "").trim().toLowerCase();
  return Boolean(row && !["deleted", "removed", "archived"].includes(status) && (row.title || row.imageUrl));
}

export function sourceLabel(source) {
  if (source === "collector") return "采集箱";
  if (source === "draft") return "草稿箱";
  if (source === "online") return "在线商品";
  if (source === "record") return "上架记录";
  return "素材";
}

export function normalizeImageList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeImageList).filter(Boolean);
  if (value && typeof value === "object") return normalizeImageList(value.url || value.image_url || value.imageUrl || value.src || value.previewUrl || value.preview_url || value.publishUrl || value.publish_url || "");
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeImageList(parsed);
  return text.split(/\s*\|\|\s*|\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

function firstValue(...values) {
  return values.find((value) => Array.isArray(value) ? value.length : (value && typeof value === "object") || String(value ?? "").trim()) || "";
}

function uniqueList(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 25);
  const text = String(value || "").trim();
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeTags(parsed);
  return text.split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean).slice(0, 25);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeStringList).filter(Boolean);
  if (value && typeof value === "object") return normalizeStringList(value.url || value.src || value.video_url || value.videoUrl || "");
  const text = String(value || "").trim();
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeStringList(parsed);
  return text ? text.split(/\s*\|\|\s*|\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeShopIds(value) {
  return [...new Set((Array.isArray(value) ? value.flat(Infinity) : [value]).map(Number).filter((item) => Number.isFinite(item) && item > 0))];
}

function inferVehicleModel(text = "") {
  const match = String(text).match(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN|TOYOTA|HONDA|BMW|MERCEDES|LADA|KIA|HYUNDAI)\s*([A-Z]?\d{1,2}[A-Z]?|TIGGO\s*\d|JOLION|DARGO|X\d{2}|J\d)\b/i);
  return match ? `${match[1].toUpperCase()} ${String(match[2]).replace(/\s+/g, " ").toUpperCase()}` : "";
}

function variantKey(variant = {}, index = 0) {
  return String(firstValue(variant.selection_key, variant.sku, variant.source_sku, variant.offer_id, variant.offerId, variant.variant_id, variant.variantId, variant.id, `variant-${index + 1}`)).trim();
}

import {
  listingDraftToTemplatePayload,
  prepareListingDraftFromCollectedSource
} from "./listing-draft-preparer.js";
import { standardizeListingTemplatePayload } from "./listing-template-standardizer.js";

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeImageItems(value = []) {
  return normalizeArray(value)
    .flatMap((item) => {
      if (Array.isArray(item)) return normalizeImageItems(item);
      if (typeof item === "string") return item;
      return item?.url || item?.image_url || item?.imageUrl || item?.src || item?.preview_url || item?.previewUrl || item?.publish_url || item?.publishUrl || "";
    })
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .map((url, index) => ({ url, sort_order: index + 1 }));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function aiVariantVideoUrl(result = {}) {
  return String(
    result.video?.publishUrl
    || result.video?.publish_url
    || result.video?.url
    || result.videoPublishUrl
    || result.video_url
    || ""
  ).trim();
}

function aiVariantImages(product = {}, result = {}, template = {}) {
  const editable = plainObject(template.editable_payload || template.editablePayload);
  const generated = normalizeImageItems([
    result.generatedMainImageUrl || result.generated_main_image_url,
    ...normalizeArray(result.generatedDetailImages || result.generated_detail_images)
  ]);
  if (generated.length) return generated;
  return normalizeImageItems(template.images || editable.images || [
    product.imageUrl || product.image_url,
    ...normalizeArray(product.detailImages || product.detail_images)
  ]);
}

function aiVariantMeta(result = {}) {
  return {
    result_id: String(result.id || result.result_id || result.resultId || "").trim(),
    source_batch_id: String(result.sourceBatchId || result.source_batch_id || "").trim(),
    variant_target: String(result.variantTarget || result.variant_target || "").trim()
  };
}

export function buildTemplateCandidateFromAiVariantResult(input = {}, options = {}) {
  const product = plainObject(input.sourceProduct || input.product || input.baseProduct);
  const result = plainObject(input.result || input.aiResult || input.row);
  const template = plainObject(input.template || product.templateSnapshot || product.template_snapshot || result.templateSnapshot);
  const editable = plainObject(template.editable_payload || template.editablePayload);
  const title = String(result.title || template.title || editable.title || product.title || product.name || "").trim();
  const description = String(result.description || template.description || editable.description || product.description || "").trim();
  const images = aiVariantImages(product, result, template);
  const videoUrl = aiVariantVideoUrl(result);
  const aiOptimization = aiVariantMeta(result);
  const offerId = String(options.offerId || result.offer_id || result.offerId || "").trim();
  const variant = {
    offer_id: offerId,
    source_offer_id: String(product.raw?.offer_id || product.raw?.offerId || product.sourceId || product.id || "").trim(),
    title,
    description,
    images,
    video_urls: videoUrl ? [videoUrl] : [],
    video_cover_urls: videoUrl ? [videoUrl] : [],
    dynamic_attributes: result.dynamicAttributes || result.dynamic_attributes || {}
  };
  const sourceRaw = {
    ...plainObject(template.source_raw || template.sourceRaw || editable.source_raw || editable.sourceRaw),
    source_type: options.sourceType || "ai_optimization_v2",
    ai_optimization: aiOptimization
  };
  return {
    ...template,
    title,
    description,
    images,
    attributes: [
      ...normalizeArray(template.attributes || editable.attributes),
      ...(normalizeArray(result.tags || result.main_tags || result.hashtags).length ? [{
        attribute_id: 23171,
        name: "Search tags",
        type: "multiselect",
        value: normalizeArray(result.tags || result.main_tags || result.hashtags)
      }] : [])
    ],
    source_raw: sourceRaw,
    editable_payload: {
      ...editable,
      title,
      description,
      images,
      attributes: normalizeArray(editable.attributes || template.attributes),
      variants: [variant],
      ai_optimization: aiOptimization,
      source_raw: sourceRaw
    }
  };
}

function offerIdForVariant(option = {}, variant = {}, index = 0) {
  if (typeof option.offerIdForVariant === "function") return String(option.offerIdForVariant(variant, index) || "").trim();
  const offerIds = normalizeArray(option.offerIds || option.offer_ids);
  return String(offerIds[index] || option.offerId || option.offer_id || variant.offer_id || "").trim();
}

export function buildTemplateCandidateFromCollectedSource(input = {}, options = {}) {
  const draft = prepareListingDraftFromCollectedSource(input, {
    sourceType: options.sourceType || "collector_box",
    sourceId: options.sourceId || input.sku || input.productId || input.id || "",
    description_category_id: options.description_category_id || options.descriptionCategoryId,
    type_id: options.type_id || options.typeId,
    category_name: options.category_name || options.categoryName
  });
  const candidate = listingDraftToTemplatePayload(draft, {
    template_name: options.templateName || options.template_name || draft.title || "Collected listing template"
  });
  const variants = normalizeArray(candidate.editable_payload?.variants).map((variant, index) => ({
    ...variant,
    offer_id: offerIdForVariant(options, variant, index)
  }));
  return {
    ...candidate,
    editable_payload: {
      ...candidate.editable_payload,
      variants
    },
    normalization: {
      source_type: draft.sourceType,
      source_id: draft.sourceId,
      missing_fields: draft.missingFields,
      category: draft.category
    }
  };
}

export async function buildTemplateCandidateFromOnlineProductTemplate(input = {}, options = {}) {
  const editable = plainObject(input.editable_payload || input.editablePayload);
  const sourceRaw = {
    ...plainObject(input.source_raw || input.sourceRaw || editable.source_raw || editable.sourceRaw),
    source_type: "online_product_live",
    ...(options.onlineProductId || options.online_product_id ? { online_product_id: Number(options.onlineProductId || options.online_product_id) } : {}),
    ...(options.offerId || options.offer_id ? { offer_id: String(options.offerId || options.offer_id).trim() } : {}),
    from_online_product: true
  };
  return standardizeListingTemplatePayload({
    ...input,
    source_type: "online_product_live",
    source_ozon_sku: options.offerId || options.offer_id || input.source_ozon_sku || editable.sku || sourceRaw.offer_id || "",
    source_raw: sourceRaw,
    editable_payload: {
      ...editable,
      source_raw: {
        ...sourceRaw,
        ...plainObject(editable.source_raw || editable.sourceRaw)
      }
    }
  }, {
    sourceType: "online_product_live",
    sourceId: String(options.sourceId || options.source_id || options.offerId || options.offer_id || editable.sku || sourceRaw.offer_id || ""),
    mergeCategoryAttributeDefinitions: options.mergeCategoryAttributeDefinitions,
    buildDiagnostics: options.buildDiagnostics,
    autoSync: options.autoSync,
    syncValues: options.syncValues,
    shopId: options.shopId
  });
}

import { randomUUID } from "node:crypto";

export function ensurePersistedDraftVariantIds(templatePayload = {}, manualFacts = {}, draftId = 0, previousVariants = []) {
  const sources = [manualFacts?.user_facts?.variants, manualFacts?.variants, templatePayload?.editable_payload?.variants]
    .filter(Array.isArray);
  const primary = sources.find((items) => items.length) || [];
  const previous = Array.isArray(previousVariants) ? previousVariants : [];
  const used = new Set();
  const ids = primary.map((variant, index) => {
    let id = String(variant?.id || variant?.variant_id || "").trim().slice(0, 128);
    if (!id && previous[index] && previous.length === primary.length) {
      id = String(previous[index].id || previous[index].variant_id || "").trim().slice(0, 128);
    }
    if (!id || used.has(id)) id = draftId ? `draft-${draftId}-variant-${index + 1}` : `variant-${randomUUID()}`;
    if (used.has(id)) id = `variant-${randomUUID()}`;
    used.add(id);
    return id;
  });
  for (const variants of sources) {
    if (variants.length !== ids.length) continue;
    variants.forEach((variant, index) => {
      if (ids[index] && variant && typeof variant === "object") variant.id = ids[index];
    });
  }
  return ids;
}

export function publishedItemVariantIds(items = [], variants = [], legacy = false) {
  if (!legacy && items.length === variants.length) return variants.map((variant) => String(variant.id || ""));
  if (legacy && items.length === 1 && variants.length === 1) return [String(variants[0].id || "")];
  const matched = items.map((item) => variants.filter((variant) => String(item.offer_id || "").trim()
    && [variant.offer_id, variant.sku, variant.source_offer_id]
      .some((value) => String(value || "").trim() === String(item.offer_id || "").trim())));
  if (matched.some((rows) => rows.length !== 1)) return [];
  const ids = matched.map((rows) => String(rows[0].id || ""));
  return ids.every(Boolean) && new Set(ids).size === ids.length ? ids : [];
}

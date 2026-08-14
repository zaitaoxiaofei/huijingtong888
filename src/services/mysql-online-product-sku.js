export function normalizedOzonSkuCandidateMysql(item = {}, value = "") {
  const text = String(value || "").trim();
  if (!text || text === "0" || text.startsWith("__MISSING_SKU__:")) return "";
  const offerId = String(item.offer_id || "").trim();
  const productId = String(item.ozon_product_id || item.product_id || item.id || "").trim();
  if (offerId && text === offerId) return "";
  if (productId && text === productId) return "";
  return /^\d+$/.test(text) ? text : "";
}

export function strictOzonSkuValue(item = {}) {
  const sourceSku = Array.isArray(item.sources)
    ? item.sources.find((source) => source?.sku)?.sku
    : "";
  const candidates = [
    item.sku,
    item.ozon_sku,
    item.product_sku,
    item.productSku,
    item.fbo_sku,
    item.fbs_sku,
    sourceSku
  ];
  return candidates.map((value) => normalizedOzonSkuCandidateMysql(item, value)).find(Boolean) || "";
}

export function missingOnlineProductSkuMarker(item = {}) {
  const productId = String(item.ozon_product_id || item.product_id || item.id || "").trim();
  const offerId = String(item.offer_id || "").trim();
  const seed = productId || offerId || "unknown";
  return `__MISSING_SKU__:${seed}`.slice(0, 128);
}

export function storageSafeOnlineProductSku(item = {}) {
  return strictOzonSkuValue(item) || missingOnlineProductSkuMarker(item);
}

export function onlineProductSkuRepairCandidateMysql(onlineRow = {}, sourceRow = {}) {
  if (/^\d+$/.test(String(onlineRow.ozon_sku || "").trim())) return "";
  const repairedSku = strictOzonSkuValue(sourceRow);
  return /^\d+$/.test(repairedSku) ? repairedSku : "";
}

export function onlineProductStockUpdateTargetMysql(row = {}, stock = 0, warehouseId = "") {
  const offerId = String(row.offer_id || "").trim();
  const productId = Number(row.ozon_product_id || row.product_id || 0);
  if (!offerId && !productId) {
    return {
      target: null,
      skipped: { online_product_id: Number(row.id), reason: "缺少 offer_id / Ozon Product ID" }
    };
  }
  return {
    target: {
      online_product_id: Number(row.id),
      offer_id: offerId,
      product_id: productId,
      stock,
      warehouse_id: warehouseId
    },
    skipped: null
  };
}

export function ozonBuyerProductLinkFor(value) {
  const productId = String(value || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
}

function parseRowRawJson(row = {}) {
  const raw = row?.raw_json;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function realSkuValue(value) {
  const text = String(value || "").trim();
  if (!text || text === "0" || text.startsWith("__MISSING_SKU__:")) return "";
  return text;
}

export function ozonBuyerProductKeyFromRow(row = {}) {
  const raw = parseRowRawJson(row);
  return (
    realSkuValue(raw.sku)
    || realSkuValue(raw?.sources?.find?.((item) => item?.sku)?.sku)
    || realSkuValue(raw.fbo_sku)
    || realSkuValue(raw.fbs_sku)
    || realSkuValue(raw.product_sku)
    || realSkuValue(raw.productSku)
    || realSkuValue(raw.ozon_sku)
    || realSkuValue(row.ozon_sku)
    || realSkuValue(row.ozonSku)
    || realSkuValue(row.ozon_product_id)
    || realSkuValue(row.ozonProductId)
    || ""
  );
}

export function ozonBuyerProductLinkFromRow(row = {}) {
  return ozonBuyerProductLinkFor(ozonBuyerProductKeyFromRow(row));
}

export function openExternalProductLink(url) {
  const target = String(url || "").trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

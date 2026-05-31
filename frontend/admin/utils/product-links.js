export function ozonBuyerProductLinkFor(value) {
  const productId = String(value || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
}

export function ozonBuyerProductLinkFromRow(row = {}) {
  return ozonBuyerProductLinkFor(row.ozon_product_id || row.ozonProductId || "");
}

export function openExternalProductLink(url) {
  const target = String(url || "").trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

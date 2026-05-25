export function parseMappedPairs(value, separator = "||") {
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, ...rest] = item.split(":");
      return { key: String(key || "").trim(), value: rest.join(":").trim() };
    })
    .filter((item) => item.key);
}

export function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function firstCsvValue(value) {
  return splitCsv(value).find(Boolean) || "";
}

export function ozonBuyerProductLinkFor(value) {
  const productId = String(value || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
}

function fallbackOzonProductId(value) {
  const text = String(value || "").trim();
  return /^\d{6,}$/.test(text) ? text : "";
}

function parseSkuMap(row, fieldName, transform = (value) => value) {
  const map = new Map();
  const separator = [
    "sku_ozon_product_ids",
    "sku_product_ids",
    "sku_online_product_ids",
    "sku_mapping_ids",
    "sku_stock_summaries"
  ].includes(fieldName) ? "," : "||";
  for (const item of parseMappedPairs(row?.[fieldName], separator)) {
    if (!map.has(item.key)) map.set(item.key, transform(item.value));
  }
  return map;
}

export function buildProductDisplayRows(row = {}) {
  const skuImages = parseSkuMap(row, "sku_images");
  const skuNames = parseSkuMap(row, "sku_names");
  const skuQuantities = parseSkuMap(row, "sku_quantities", (value) => Number(value || 0));
  const ozonProductIds = parseSkuMap(row, "sku_ozon_product_ids");
  const productIds = parseSkuMap(row, "sku_product_ids", (value) => Number(value || 0));
  const onlineIds = parseSkuMap(row, "sku_online_product_ids", (value) => Number(value || 0));
  const inventoryImages = splitCsv(row.inventory_image_urls);
  const stockMap = parseSkuMap(row, "sku_stock_summaries", (value) => {
    const parts = String(value || "").split(":");
    return { fbs: Number(parts[0] || 0), fbp: Number(parts[1] || 0) };
  });
  const skus = splitCsv(row.skus);
  const unboundSkus = new Set(splitCsv(row.unbound_skus));
  const rawFallbackName = firstCsvValue(row.product_names);
  const fallbackName = rawFallbackName && rawFallbackName !== "Unbound product" ? rawFallbackName : "";
  const fallbackImage = firstCsvValue(row.order_image_urls) || firstCsvValue(row.image_urls) || inventoryImages[0] || "";

  if (!skus.length) {
    return [{
      sku: row.ozon_sku || "-",
      name: skuNames.get(row.ozon_sku) || fallbackName || row.ozon_sku || "待创建库存商品",
      quantity: Number(row.total_quantity || row.quantity_total || row.quantity || row.item_count || 1),
      imageUrl: fallbackImage,
      stock: { fbs: 0, fbp: 0 },
      productId: 0,
      onlineId: 0,
      ozonProductId: String(row.ozon_product_id || row.ozon_sku || ""),
      unbound: true,
      productLink: ozonBuyerProductLinkFor(row.ozon_product_id || row.ozon_sku)
    }];
  }

  return skus.map((sku) => {
    const ozonProductId = ozonProductIds.get(sku) || fallbackOzonProductId(sku) || "";
    const onlineId = onlineIds.get(sku) || 0;
    return {
      sku,
      name: skuNames.get(sku) || fallbackName || sku || "待创建库存商品",
      quantity: skuQuantities.get(sku) || 0,
      imageUrl: skuImages.get(sku) || fallbackImage || inventoryImages[0] || "",
      stock: stockMap.get(sku) || { fbs: 0, fbp: 0 },
      productId: productIds.get(sku) || 0,
      onlineId,
      ozonProductId,
      unbound: unboundSkus.has(sku),
      productLink: ozonBuyerProductLinkFor(ozonProductId)
    };
  });
}

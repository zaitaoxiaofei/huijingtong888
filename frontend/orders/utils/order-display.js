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
    "sku_inventory_modes",
    "sku_stock_summaries",
    "sku_incoming_summaries",
    "sku_component_counts"
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
  const orderItemIds = parseSkuMap(row, "sku_order_item_ids", (value) => Number(value || 0));
  const saleAmounts = parseSkuMap(row, "sku_sale_amounts", (value) => Number(value || 0));
  const estimatedProfits = parseSkuMap(row, "sku_estimated_profits", (value) => Number(value || 0));
  const actualProfits = parseSkuMap(row, "sku_actual_profits", (value) => Number(value || 0));
  const actualProfitReadyMap = parseSkuMap(row, "sku_actual_profit_ready", (value) => String(value || "") === "1");
  const ozonProductIds = parseSkuMap(row, "sku_ozon_product_ids");
  const productIds = parseSkuMap(row, "sku_product_ids", (value) => Number(value || 0));
  const inventoryNames = parseSkuMap(row, "sku_inventory_names");
  const onlineIds = parseSkuMap(row, "sku_online_product_ids", (value) => Number(value || 0));
  const inventoryModes = parseSkuMap(row, "sku_inventory_modes");
  const inventoryImages = splitCsv(row.inventory_image_urls);
  const stockMap = parseSkuMap(row, "sku_stock_summaries", (value) => {
    const parts = String(value || "").split(":");
    return { fbs: Number(parts[0] || 0), fbp: Number(parts[1] || 0), local: Number(parts[2] || 0) };
  });
  const incomingMap = parseSkuMap(row, "sku_incoming_summaries", (value) => Number(value || 0));
  const componentCountMap = parseSkuMap(row, "sku_component_counts", (value) => Number(value || 0));
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
      orderItemId: Number(row.order_item_id || 0) || 0,
      imageUrl: fallbackImage,
      saleAmount: Number(row.revenue || 0),
      estimatedProfit: Number(row.estimated_profit || 0),
      actualProfit: Number(row.actual_profit || 0),
      actualProfitReady: Math.abs(Number(row.actual_profit || 0)) > 0.000001 || String(row.status || "").toLowerCase() === "delivered",
      stock: { fbs: 0, fbp: 0, local: 0 },
      incoming: 0,
      componentCount: 0,
      productId: 0,
      onlineId: 0,
      inventoryMode: "unbound",
      ozonProductId: String(row.ozon_product_id || row.ozon_sku || ""),
      unbound: true,
      productLink: ozonBuyerProductLinkFor(row.ozon_product_id || row.ozon_sku)
    }];
  }

  return skus.map((sku) => {
    const ozonProductId = ozonProductIds.get(sku) || fallbackOzonProductId(sku) || "";
    const onlineId = onlineIds.get(sku) || 0;
    const hasSkuImage = skuImages.has(sku);
    return {
      sku,
      name: skuNames.get(sku) || fallbackName || sku || "待创建库存商品",
      quantity: skuQuantities.get(sku) || 0,
      orderItemId: orderItemIds.get(sku) || 0,
      imageUrl: hasSkuImage ? (skuImages.get(sku) || "") : (fallbackImage || inventoryImages[0] || ""),
      saleAmount: saleAmounts.get(sku) || 0,
      estimatedProfit: estimatedProfits.get(sku) || 0,
      actualProfit: actualProfits.get(sku) || 0,
      actualProfitReady: actualProfitReadyMap.get(sku) || false,
      stock: stockMap.get(sku) || { fbs: 0, fbp: 0 },
      incoming: incomingMap.get(sku) || 0,
      componentCount: componentCountMap.get(sku) || 0,
      productId: productIds.get(sku) || 0,
      inventoryName: inventoryNames.get(sku) || "",
      onlineId,
      inventoryMode: inventoryModes.get(sku) || (productIds.get(sku) ? "single" : "unbound"),
      ozonProductId,
      unbound: unboundSkus.has(sku),
      productLink: ozonBuyerProductLinkFor(ozonProductId)
    };
  });
}

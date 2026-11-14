// Defaults for new catalog records only; historical profit formulas stay pinned.
export function defaultInventoryPackagingFee(product = {}) {
  const direct = Number(product.sale_price_rmb || product.air_sale_price_rmb || 0);
  const rate = Number(product.exchange_rate || 0);
  const amount = direct > 0 ? direct : rate > 0 ? Number(product.listing_price_rub || 0) / rate : 0;
  return amount <= 50 ? 0.3 : amount <= 100 ? 0.5 : 1;
}

export function inventoryPackageMissingFields(product = {}) {
  if (product.product_type === 'selection' && product.selection_status !== 'listed') return [];
  return [
    ['package_weight_g', '包装克重'], ['length_cm', '包装长度'],
    ['width_cm', '包装宽度'], ['height_cm', '包装高度']
  ].filter(([key]) => !Number.isFinite(Number(product[key])) || Number(product[key]) <= 0);
}

export function assertInventoryPackage(product) {
  const missing = inventoryPackageMissingFields(product);
  if (missing.length) throw Object.assign(new Error(`请在“计量包装”中填写大于 0 的${missing.map(([key, label]) => `${label}（${key}）`).join('、')}后再保存，才能正确计算运费和预估利润。`), { statusCode: 400, field: missing[0][0] });
}

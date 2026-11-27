import { parseMappedPairs, splitCsv } from './order-display.js';

export function orderImageDisplayUrl(value = '') {
  const source = String(value || '').trim();
  if (!source) return '';
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  try {
    const url = new URL(source, origin);
    if (url.origin !== origin || url.pathname !== '/api/image-proxy') return source;
    url.searchParams.set('require_original', '1');
    return source.startsWith('/') ? `${url.pathname}${url.search}` : url.href;
  } catch { return source; }
}

export function applyOrderImageSyncToRow(row, result) {
  if (Number(row.id) !== Number(result.order_id)) return row;
  if (row.platform === 'wb') {
    const [sku] = splitCsv(row.skus);
    const title = sku && result.items?.find(item => item.ozon_sku === sku)?.product_name;
    if (title) row = { ...row, sku_names: `${sku}:${title}` };
  }
  const updates = new Map((result.items || []).filter(item => item.updated && item.image_url).map(item => [Number(item.id), item.image_url]));
  if (!updates.size) return row;
  const images = new Map(parseMappedPairs(row.sku_images).map(item => [item.key, item.value]));
  let changed = false;
  for (const item of parseMappedPairs(row.sku_order_item_ids)) {
    if (!updates.has(Number(item.value))) continue;
    images.set(item.key, updates.get(Number(item.value))); changed = true;
  }
  const skus = splitCsv(row.skus);
  for (const item of result.items || []) {
    if (!updates.has(Number(item.id)) || !skus.includes(String(item.ozon_sku || ''))) continue;
    images.set(String(item.ozon_sku), item.image_url); changed = true;
  }
  if (!changed && skus.length === 1 && updates.size === 1) {
    images.set(skus[0], [...updates.values()][0]); changed = true;
  }
  return changed ? { ...row, sku_images: [...images].map(([sku, url]) => `${sku}:${url}`).join('||') } : row;
}

export function applyOrderImageSyncToItems(items, result) {
  const updates = new Map((result.items || []).filter(item => item.updated && item.image_url).map(item => [Number(item.id), item.image_url]));
  const titles = new Map((result.items || []).filter(item => item.product_name).map(item => [Number(item.id), item.product_name]));
  return items.map(item => {
    const id = Number(item.id);
    if (!updates.has(id) && !titles.has(id)) return item;
    return { ...item, ...(updates.has(id) ? { image_url: updates.get(id) } : {}),
      ...(titles.has(id) ? { product_name: titles.get(id) } : {}) };
  });
}

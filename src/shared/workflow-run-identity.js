export function workflowRunIdentity(raw) {
  let value; try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { value = []; }
  const brands = new Set(), models = new Set();
  function walk(item) {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!item || typeof item !== 'object') return;
    if (typeof item.brand === 'string' && item.brand.trim()) brands.add(item.brand.trim());
    if (typeof item.model === 'string' && item.model.trim()) models.add(`${item.brand || ''} ${item.model}`.trim());
  }
  walk(value);
  return {brands: [...brands].join('、') || '未记录', models: [...models].join('、') || '未记录'};
}

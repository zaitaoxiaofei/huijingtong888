// One set of product filters for inventory pages; business filters stay page-specific.
export const inventorySearchDefaults = () => ({
  searchMode: 'auto', inventoryCategory: '', productName: '', vehicleBrand: '',
  fitmentType: '', vehicleModel: [], accessoryName: '', color: '', material: [], process: ''
});
export const inventorySearchKeys = Object.keys(inventorySearchDefaults());
export function appendInventorySearch(params, filters) {
  for (const key of inventorySearchKeys) {
    const value = Array.isArray(filters[key]) ? filters[key].join(',') : String(filters[key] || '').trim();
    if (value) params.set(key, value);
  }
  return params;
}

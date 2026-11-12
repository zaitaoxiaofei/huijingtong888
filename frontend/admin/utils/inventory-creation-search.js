// Send standard fields separately so filtering happens before pagination.
export function inventoryCreationSearchParams(item = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of [
    ["inventoryCategory", item.category],
    ["vehicleBrand", item.vehicle_brand],
    ["requiredModels", (item.vehicle_models || []).join(",")],
    ["accessoryName", item.accessory],
    ["requiredColors", (item.colors || []).join(",")],
    ["requiredMaterials", (item.materials || []).join(",")],
    ["process", item.process]
  ]) {
    const text = String(value || "").trim();
    if (text) params.set(key, text);
  }
  return params;
}

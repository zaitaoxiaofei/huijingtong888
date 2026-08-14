export const developmentTypeOptions = [
  { label: "新品", value: "new", tagType: "success" },
  { label: "复制", value: "copy", tagType: "info" },
  { label: "裂变", value: "fission", tagType: "warning" }
];

const DEVELOPMENT_TYPE_MAP = new Map(developmentTypeOptions.map((item) => [item.value, item]));

export function normalizeDevelopmentType(value, fallback = "new") {
  const text = String(value || "").trim().toLowerCase();
  if (DEVELOPMENT_TYPE_MAP.has(text)) return text;
  if (value === "新品") return "new";
  if (value === "复制") return "copy";
  if (value === "裂变") return "fission";
  return DEVELOPMENT_TYPE_MAP.has(fallback) ? fallback : "new";
}

export function developmentTypeLabel(value) {
  return DEVELOPMENT_TYPE_MAP.get(normalizeDevelopmentType(value))?.label || "新品";
}

export function developmentTypeTagType(value) {
  return DEVELOPMENT_TYPE_MAP.get(normalizeDevelopmentType(value))?.tagType || "success";
}

export function vehicleModelText(row = {}) {
  return [row.vehicle_brand, row.vehicle_model].map((item) => String(item || "").trim()).filter(Boolean).join(" ");
}

export const DEVELOPMENT_TYPES = ["new", "copy", "fission"];

const TYPE_ALIASES = new Map([
  ["new", "new"],
  ["新品", "new"],
  ["new_product", "new"],
  ["copy", "copy"],
  ["复制", "copy"],
  ["duplicate", "copy"],
  ["clone", "copy"],
  ["fission", "fission"],
  ["裂变", "fission"],
  ["variant", "fission"],
  ["ai_variant", "fission"]
]);

function cleanText(value = "") {
  return String(value ?? "").trim();
}

function firstText(values = []) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function compactKeyPart(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

export function normalizeDevelopmentType(value, fallback = "new") {
  const raw = cleanText(value);
  const normalized = raw ? TYPE_ALIASES.get(raw.toLowerCase()) || TYPE_ALIASES.get(raw) : "";
  if (DEVELOPMENT_TYPES.includes(normalized)) return normalized;
  return DEVELOPMENT_TYPES.includes(fallback) ? fallback : "new";
}

export function normalizeVehicleModelKey(brand = "", model = "") {
  const brandKey = compactKeyPart(brand);
  const modelKey = compactKeyPart(model);
  return [brandKey, modelKey].filter(Boolean).join("-");
}

export function parseVehicleModelFromCode(value = "") {
  const text = cleanText(value);
  if (!text) return { vehicle_brand: "", vehicle_model: "", vehicle_model_key: "" };
  const tokens = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((item) => cleanText(item).toUpperCase())
    .filter(Boolean);
  const aiIndex = tokens.findIndex((item) => item === "AI");
  const start = aiIndex >= 0 ? aiIndex + 1 : 0;
  const candidates = tokens.slice(start).filter((item) => !/^\d+$/.test(item));
  if (candidates.length < 2) return { vehicle_brand: "", vehicle_model: "", vehicle_model_key: "" };
  const vehicle_brand = candidates[0];
  const vehicle_model = candidates[1];
  return {
    vehicle_brand,
    vehicle_model,
    vehicle_model_key: normalizeVehicleModelKey(vehicle_brand, vehicle_model)
  };
}

export function resolveDevelopmentMeta(source = {}, fallbackType = "new") {
  const rawSourceType = source.development_type ?? source.developmentType ?? source.product_development_type ?? source.productDevelopmentType;
  const sourceType = normalizeDevelopmentType(
    rawSourceType,
    fallbackType
  );
  const code = firstText([
    source.internal_code,
    source.internalCode,
    source.offer_id,
    source.offerId,
    source.sku,
    source.code,
    source.selection_id,
    source.selectionId
  ]);
  // A stored/API type is authoritative. The AI-* heuristic is only for legacy rows with no type.
  const hasExplicitSourceType = cleanText(rawSourceType) !== "";
  const inferredType = !hasExplicitSourceType && /^AI[^a-z0-9]*[a-z0-9]+/i.test(code) ? "fission" : sourceType;
  const parsed = inferredType === "fission"
    ? parseVehicleModelFromCode(code)
    : { vehicle_brand: "", vehicle_model: "", vehicle_model_key: "" };
  const vehicle_brand = firstText([source.vehicle_brand, source.vehicleBrand, source.brand, parsed.vehicle_brand]);
  const vehicle_model = firstText([source.vehicle_model, source.vehicleModel, source.model, parsed.vehicle_model]);
  const vehicle_model_key = firstText([
    source.vehicle_model_key,
    source.vehicleModelKey,
    normalizeVehicleModelKey(vehicle_brand, vehicle_model),
    parsed.vehicle_model_key
  ]);
  return {
    development_type: normalizeDevelopmentType(inferredType, sourceType),
    vehicle_brand,
    vehicle_model,
    vehicle_model_key
  };
}

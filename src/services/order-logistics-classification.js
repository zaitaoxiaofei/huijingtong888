import { detectOrderLogisticsCarrier } from "./order-logistics-carrier.js";

export const ORDER_LOGISTICS_SERVICE_CLASSES = [
  { value: "extra_small", label: "Extra Small" },
  { value: "small", label: "Small" },
  { value: "budget", label: "Budget" },
  { value: "big", label: "Big" },
  { value: "premium_small", label: "Premium Small" },
  { value: "premium_big", label: "Premium Big" }
];

const SERVICE_CLASS_PATTERNS = [
  ["premium_big", /\bpremium\s+big\b/i],
  ["premium_small", /\bpremium\s+small\b/i],
  ["extra_small", /\bextra\s+small\b/i],
  ["budget", /\bbudget\b/i],
  ["big", /\bbig\b/i],
  ["small", /\bsmall\b/i]
];
const CARRIER_LABELS = { ogl: "OGL", guoo: "GUOO", cel: "CEL", postal: "邮政", other: "其他物流" };
const TRANSPORT_LABELS = { land: "陆运", air_land: "陆空", air: "空运" };

function jsonObject(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "{}")) || {}; } catch { return {}; }
}

export function orderLogisticsEvidence(posting = {}) {
  const payload = jsonObject(posting.raw_json);
  const raw = posting.raw && typeof posting.raw === "object" ? posting.raw : (payload.raw || (Object.keys(payload).length ? payload : posting));
  const method = raw.delivery_method || posting.delivery_method || {};
  const analytics = raw.analytics_data || posting.analytics_data || {};
  const deliveryMethodName = method.name || posting.delivery_method_name || "";
  const warehouseName = method.warehouse || analytics.warehouse || raw.warehouse_name || posting.warehouse_name || "";
  const provider = method.tpl_provider || analytics.tpl_provider || raw.tpl_provider || posting.logistics_channel || "";
  // Only logistics fields are evidence. Customer/product names, URLs, arbitrary
  // JSON strings and resolved tariff labels must never select a carrier.
  const text = [deliveryMethodName, provider, warehouseName, analytics.tpl_provider, analytics.warehouse, raw.tpl_provider]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ").replace(/\s+/g, " ").trim();
  return { raw, analytics, deliveryMethodName, warehouseName, provider, text };
}

function serviceClassKey(text) {
  return SERVICE_CLASS_PATTERNS.find(([, pattern]) => pattern.test(String(text || "")))?.[0] || "";
}

function transportMode(text) {
  const value = String(text || "");
  if (/陆空|陆\s*[+＋]\s*空|\bland\s*\+\s*air\b|\bair\s*\+\s*land\b|\bair[_ -]land\b|\bstandard\b/i.test(value)) return "air_land";
  if (/陆运|\beconomy\b|\bland\b/i.test(value)) return "land";
  if (/空运|\bexpress\b|\bair\b/i.test(value)) return "air";
  return "";
}

function uniqueBillingValue(names, resolve, carrier) {
  const rules = String(names || "").split(/\s+\/\s+/).filter(Boolean);
  if (!rules.length || !carrier || rules.some((name) => detectOrderLogisticsCarrier(name) !== carrier)) return "";
  const values = new Set(rules.map(resolve));
  return values.size === 1 ? [...values][0] : "";
}

export function classifyOrderLogistics(posting = {}) {
  const { text } = orderLogisticsEvidence(posting);
  const carrier = detectOrderLogisticsCarrier(text);
  const rawServiceClass = serviceClassKey(text);
  const rawTransport = transportMode(text);
  const serviceClass = rawServiceClass || uniqueBillingValue(posting.billing_logistics_rule_name, serviceClassKey, carrier);
  const transport = rawTransport || uniqueBillingValue(posting.billing_logistics_rule_name, transportMode, carrier);
  const carrierLabel = CARRIER_LABELS[carrier] || "";
  const serviceClassLabel = ORDER_LOGISTICS_SERVICE_CLASSES.find((item) => item.value === serviceClass)?.label || "";
  const transportLabel = TRANSPORT_LABELS[transport] || "";
  return {
    logistics_carrier: carrier,
    logistics_carrier_label: carrierLabel,
    logistics_service_class: serviceClassLabel,
    logistics_service_class_key: serviceClass,
    logistics_service_class_source: rawServiceClass ? "ozon_raw" : serviceClass ? "billing_rule" : "",
    logistics_transport_mode: transport,
    logistics_transport_mode_label: transportLabel,
    logistics_transport_mode_source: rawTransport ? "ozon_raw" : transport ? "billing_rule" : "",
    logistics_display_name: [carrierLabel, serviceClassLabel, transportLabel].filter(Boolean).join(" ")
  };
}

export function normalizeLogisticsServiceClass(value = "") {
  const text = String(value || "").trim();
  if (!text || text === "all") return "all";
  const byKey = ORDER_LOGISTICS_SERVICE_CLASSES.find((item) => item.value === text.toLowerCase());
  const byLabel = ORDER_LOGISTICS_SERVICE_CLASSES.find((item) => item.label.toLowerCase() === text.toLowerCase());
  return byKey?.value || byLabel?.value || text;
}

export function orderLogisticsServiceClassOptions(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const key = row.logistics_service_class_key;
    if (key) counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  return [
    { value: "all", label: "全部物流渠道", count: rows.length },
    ...ORDER_LOGISTICS_SERVICE_CLASSES.map((item) => ({ ...item, count: counts.get(item.value) || 0 }))
  ];
}

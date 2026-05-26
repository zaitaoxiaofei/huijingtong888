export const DEFAULT_ORDER_LOGISTICS_FILTER_RULES = [
  {
    value: "cel_air_land_1_500g",
    label: "CEL 陆空 1-500g",
    warehouse_patterns: ["CEL陆空", "CEL 陆+空", "CEL 陆空", "CEL陆空(1-500g", "1-135rmb"],
    sort_order: 10,
    note: "匹配订单物流信息中的 CEL 陆空 1-500g 仓库文本。"
  },
  {
    value: "cel_land_1_500g",
    label: "CEL 陆运 1-500g",
    warehouse_patterns: ["CEL陆运(1-500g", "CEL 陆运 1-500g", "CEL陆运 1-500g"],
    sort_order: 20,
    note: "匹配订单物流信息中的 CEL 陆运 1-500g 仓库文本。"
  },
  {
    value: "postal_1_500g",
    label: "邮政 1-500g",
    warehouse_patterns: ["邮政特惠 1-500g", "邮政特惠1-500g", "邮政 1-500g", "邮政1-500g"],
    sort_order: 30,
    note: "匹配邮政特惠 1-500g 仓库文本。"
  },
  {
    value: "hunchun_2",
    label: "Hunchun 2",
    warehouse_patterns: ["CEL Hunchun 2", "Hunchun 2", "hch-pd"],
    sort_order: 40,
    note: "匹配 CEL Hunchun 2。"
  },
  {
    value: "cel_land_500_25000g",
    label: "CEL 陆运 500-25000g",
    warehouse_patterns: ["CEL陆运(500-25000g", "CEL陆运 500-25000g"],
    sort_order: 50,
    note: "独立匹配 CEL陆运(500-25000g...)。"
  },
  {
    value: "cel_land_2_30kg",
    label: "CEL 陆运 2-30kg",
    warehouse_patterns: ["CEL陆运(2-30kg", "CEL陆运 2-30kg"],
    sort_order: 60,
    note: "独立匹配 CEL陆运(2-30kg...)。"
  },
  {
    value: "cel_land_0_5_30kg",
    label: "CEL 陆运 0.5-30kg",
    warehouse_patterns: ["CEL陆运(0.5-30kg", "CEL陆运 0.5-30kg"],
    sort_order: 70,
    note: "独立匹配 CEL陆运(0.5-30kg...)。"
  }
];

const ORDER_LOGISTICS_VALUE_BY_LABEL = new Map(
  DEFAULT_ORDER_LOGISTICS_FILTER_RULES.map((item) => [String(item.label || "").trim().toLowerCase(), item.value])
);

const ORDER_LOGISTICS_STABLE_VALUES = new Set(
  DEFAULT_ORDER_LOGISTICS_FILTER_RULES.map((item) => String(item.value || "").trim()).filter(Boolean)
);

const ORDER_LOGISTICS_VALUE_BY_CHANNEL = new Map([
  ["hunchun_2", "hunchun_2"],
  ["economy_0_5_30kg", "cel_land_0_5_30kg"],
  ["economy_budget", "cel_land_500_25000g"],
  ["economy_big", "cel_land_2_30kg"],
  ["economy_extra_small", "cel_air_land_1_500g"],
  ["standard_extra_small", "cel_air_land_1_500g"]
]);

function normalizeOrderLogisticsText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function resolveOrderLogisticsValueByText(text = "") {
  const normalized = normalizeOrderLogisticsText(text);
  if (!normalized) return "";
  if (
    normalized.includes("hunchun")
    || normalized.includes("hch-pd")
    || normalized.includes("hch-cr")
    || normalized.includes("cel fbp")
    || normalized.includes("fbp standard")
  ) {
    return "hunchun_2";
  }
  if (normalized.includes("china post") || normalized.includes("postal") || normalized.includes("邮政")) {
    return "postal_1_500g";
  }
  if (normalized.includes("0.5-30kg")) {
    return "cel_land_0_5_30kg";
  }
  if (normalized.includes("500-25000g") || normalized.includes("budget")) {
    return "cel_land_500_25000g";
  }
  if (normalized.includes("2-30kg") || normalized.includes(" economy big") || normalized.includes(" big") || normalized.endsWith(" big")) {
    return "cel_land_2_30kg";
  }
  if (
    normalized.includes("陆空")
    || normalized.includes("陆运经济 extra small")
    || normalized.includes("standard extra small")
    || normalized.includes("extra small standard")
    || normalized.includes("economy extra small")
    || normalized.includes("extra small economy")
  ) {
    return "cel_air_land_1_500g";
  }
  if (normalized.includes("land 1-500g")) {
    return "cel_land_1_500g";
  }
  if (normalized.includes("air 1-500g")) {
    return "cel_air_land_1_500g";
  }
  return "";
}

export function resolveOrderLogisticsRuleValue(row = {}) {
  const explicitValue = String(row.value || "").trim();
  if (explicitValue && ORDER_LOGISTICS_STABLE_VALUES.has(explicitValue)) {
    return explicitValue;
  }
  const label = String(row.label || row.name || "").trim().toLowerCase();
  if (label && ORDER_LOGISTICS_VALUE_BY_LABEL.has(label)) {
    return ORDER_LOGISTICS_VALUE_BY_LABEL.get(label) || "";
  }
  const channel = String(row.channel || "").trim().toLowerCase();
  if (channel && ORDER_LOGISTICS_VALUE_BY_CHANNEL.has(channel)) {
    return ORDER_LOGISTICS_VALUE_BY_CHANNEL.get(channel) || "";
  }
  const inferred = resolveOrderLogisticsValueByText([
    row.label,
    row.name,
    row.carrier,
    row.channel,
    ...(Array.isArray(row.warehousePatterns) ? row.warehousePatterns : [])
  ].filter(Boolean).join(" "));
  if (inferred) return inferred;
  return "";
}

export function normalizeOrderLogisticsFilterRule(row = {}) {
  const rawPatterns = Array.isArray(row.warehouse_patterns)
    ? row.warehouse_patterns
    : String(row.warehouse_patterns || "")
      .split(/\r?\n|[|｜]/)
      .map((item) => item.trim());
  return {
    id: row.id === undefined || row.id === null ? null : Number(row.id),
    value: String(row.value || resolveOrderLogisticsRuleValue(row) || "").trim(),
    label: String(row.label || "").trim(),
    warehousePatterns: rawPatterns.filter(Boolean),
    sort_order: Number(row.sort_order ?? row.sortOrder ?? 100),
    enabled: Number(row.enabled ?? 1),
    note: String(row.note || "")
  };
}

export function serializeOrderLogisticsPatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : String(patterns || "").split(/\r?\n|[|｜]/))
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");
}

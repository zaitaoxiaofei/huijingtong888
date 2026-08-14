const PRODUCT_NAME_GROUPS = [
  ["钥匙保护壳", "钥匙壳", "钥匙套", "钥匙保护套", "钥匙包"],
  ["门槛条", "迎宾条", "迎宾踏板", "门槛踏板"],
  ["防踢垫", "防踢保护垫", "车门防踢垫", "后座防踢垫", "尾箱防踢垫"],
  ["晴雨挡", "车窗雨眉", "雨眉"],
  ["密封条", "隔音条"],
  ["灯带", "氛围灯带"],
  ["投影灯", "车门投影灯", "迎宾灯"],
  ["轮毂螺丝帽", "轮毂帽", "螺丝帽"],
  ["摄像头保护盖", "镜头保护盖", "摄像头镜头保护盖"],
  ["手绳", "钥匙手绳", "钥匙扣手绳"],
  ["防撞条", "保护条"],
  ["车标", "汽车标志"],
  ["防滑垫", "置物垫"],
  ["钥匙扣", "挂扣"],
  ["安全带护肩", "安全带护套"],
  ["门锁套", "静音门锁套", "门锁保护套"]
];

const GENERIC_WORDS = new Set(["汽车", "车载", "通用", "专用", "无品牌", "配件", "用品", "商品"]);

export function normalizeInventoryText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()（）【】[\],，+*\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inventoryProductNameGroup(value) {
  const text = normalizeInventoryText(value);
  if (!text) return null;
  return PRODUCT_NAME_GROUPS.find((group) => group.some((name) => text.includes(normalizeInventoryText(name)))) || null;
}

function meaningfulTokens(value) {
  return [...new Set(normalizeInventoryText(value).split(" ").filter((token) => token.length >= 2 && !GENERIC_WORDS.has(token)))];
}

function containsValue(text, value) {
  const normalizedValue = normalizeInventoryText(value);
  if (!normalizedValue) return false;
  return normalizedValue.split(" ").some((token) => token.length >= 2 && text.includes(token));
}

export function scoreInventorySimilarity(candidate = {}, input = {}) {
  const candidateName = normalizeInventoryText(candidate.name);
  const coreName = String(input.coreName || input.core_name || "").trim();
  const sourceGroup = inventoryProductNameGroup(coreName);
  const candidateGroup = inventoryProductNameGroup(candidate.name);
  const coreTokens = meaningfulTokens(coreName);
  const synonymCoreMatch = Boolean(sourceGroup && candidateGroup && sourceGroup === candidateGroup);
  const fallbackCoreToken = [...coreTokens].sort((left, right) => right.length - left.length)[0] || "";
  const directCoreMatch = sourceGroup ? synonymCoreMatch : Boolean(fallbackCoreToken && candidateName.includes(fallbackCoreToken));

  if (!directCoreMatch && !synonymCoreMatch) return null;

  let score = directCoreMatch ? 40 : 32;
  const matches = [directCoreMatch ? "核心品名" : "品名同义词"];
  const differences = [];

  const brand = input.brand || "";
  const vehicleModel = input.vehicleModel || input.vehicle_model || "";
  const colors = Array.isArray(input.colors) ? input.colors : [input.color].filter(Boolean);
  const feature = input.feature || input.accessory || "";
  const quantity = Number(input.quantity || 0);
  const packageMode = input.packageMode || input.package_mode || "";
  const includedAccessories = input.includedAccessories || input.included_accessories || "";
  const giftContents = input.giftContents || input.gift_contents || "";

  if (brand) {
    if (containsValue(candidateName, brand)) {
      score += 15;
      matches.push("品牌");
    } else {
      differences.push("品牌可能不同");
    }
  }
  if (vehicleModel) {
    if (containsValue(candidateName, vehicleModel)) {
      score += 20;
      matches.push("车型");
    } else {
      score -= 15;
      differences.push("车型不同");
    }
  } else if (candidateName.includes("通用")) {
    score += 10;
    matches.push("通用款");
  }
  if (colors.length) {
    if (colors.some((color) => containsValue(candidateName, color))) {
      score += 5;
      matches.push("颜色");
    } else {
      differences.push("颜色不同");
    }
  }
  if (feature) {
    if (containsValue(candidateName, feature)) {
      score += 7;
      matches.push("款式");
    } else {
      differences.push("款式可能不同");
    }
  }
  if (quantity > 1) {
    if (new RegExp(`${quantity}\\s*(个|件|套|对|双|条|米|шт)`, "i").test(candidateName)) {
      score += 5;
      matches.push("包装数量");
    } else {
      differences.push(`包装可能不是${quantity}件`);
    }
  }
  if (packageMode === "set" && /(套装|件套|组合)/.test(candidateName)) score += 3;
  if (includedAccessories) {
    if (containsValue(candidateName, includedAccessories)) {
      score += 7;
      matches.push("固定组成");
    } else {
      score -= 7;
      differences.push("固定组成不同");
    }
  }
  if (giftContents) {
    if (containsValue(candidateName, giftContents) && candidateName.includes("赠")) {
      score += 4;
      matches.push("赠品");
    } else {
      differences.push("赠品不同");
    }
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    level: score >= 85 ? "duplicate" : (score >= 65 ? "similar" : "related"),
    levelLabel: score >= 85 ? "高度疑似重复" : (score >= 65 ? "比较相似" : "相关商品"),
    matches,
    differences
  };
}

export function buildShortInventoryName(input = {}) {
  const coreName = String(input.coreName || input.category || "").trim();
  const vehicleBrand = String(input.vehicleBrand || input.vehicle_brand || input.brandEn || input.brand_en || "").trim();
  const vehicleModels = normalizeInventoryList(input.vehicleModels || input.vehicle_models || input.vehicleModel || input.vehicle_model);
  const fitment = vehicleBrand
    ? [vehicleBrand, vehicleModels.join("/")].filter(Boolean).join(" ")
    : "通用";
  const colors = normalizeInventoryList(input.colors).map(normalizeInventoryColor).filter(Boolean).join("/");
  const feature = normalizeInventoryStyle(input.feature || input.accessory);
  const material = normalizeInventoryList(input.materials || input.material).join("/");
  const process = String(input.process || input.craft || input.surface_process || "").trim();
  const quantity = Math.max(1, Number(input.quantity || 1));
  const unit = String(input.stockUnit || input.stock_unit || "件").trim();
  const packageMode = input.packageMode || input.package_mode || "single";
  const packageContents = String(input.packageContents || input.package_contents || "").trim();
  const includedAccessories = String(input.includedAccessories || input.included_accessories || "").trim();
  const giftContents = String(input.giftContents || input.gift_contents || "").trim();
  const setSuffix = packageMode === "set"
    ? (/礼盒/u.test(`${packageContents} ${includedAccessories} ${giftContents}`) ? "礼盒套装" : "套装")
    : "";

  return [coreName, fitment, colors, feature, material, process, `${quantity}${unit}`, setSuffix]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeInventoryList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[，,、/\s]+/u);
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
}

export function normalizeInventoryStyle(value) {
  const text = String(value || "").replace(/\s+/g, "").trim();
  if (!text || ["普通", "普通款", "默认", "默认款"].includes(text)) return "普通款";
  if (/^无\s*logo(?:款)?$/i.test(text)) return "无LOGO款";
  if (/^(?:带)?\s*logo(?:定制)?款?$/i.test(text)) return "LOGO定制款";
  return text;
}

export function normalizeInventoryColor(value) {
  const text = String(value || "").replace(/\s+/g, "").trim();
  const aliases = { 黑: "黑色", 纯黑: "黑色", 白: "白色", 灰: "灰色", 银: "银色", 红: "红色", 蓝: "蓝色", 透明色: "透明" };
  return aliases[text] || text;
}

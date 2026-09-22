// Exact aliases only: brand families and localized vehicle models are not merged.
export const VEHICLE_BRAND_CHINESE = {
  LADA: "拉达", HAVAL: "哈弗", TENET: "特耐", GEELY: "吉利", BELGEE: "贝尔吉",
  CHANGAN: "长安", CHERY: "奇瑞", OMODA: "欧萌达", JETOUR: "捷途", JAECOO: "杰酷",
  EXEED: "星途", TANK: "坦克", GAC: "广汽", MOSKVICH: "莫斯科人", SOLARIS: "索拉里斯",
  UAZ: "瓦滋", VOYAH: "岚图", HONGQI: "红旗", "LI AUTO / LIXIANG": "理想",
  EVOLUTE: "埃沃拉特", "LYNK & CO": "领克", BMW: "宝马", TOYOTA: "丰田", KIA: "起亚",
  HYUNDAI: "现代", NISSAN: "日产", VOLKSWAGEN: "大众", RENAULT: "雷诺", FORD: "福特",
  SKODA: "斯柯达", CHEVROLET: "雪佛兰", MITSUBISHI: "三菱", MAZDA: "马自达",
  HONDA: "本田", SUBARU: "斯巴鲁", LEXUS: "雷克萨斯", "MERCEDES-BENZ": "奔驰",
  AUDI: "奥迪", BYD: "比亚迪", VOLVO: "沃尔沃"
};
const aliases = new Map();
for (const [english, chinese] of Object.entries(VEHICLE_BRAND_CHINESE)) {
  for (const value of [chinese, `${chinese}|${english}`, `${chinese} ${english}`, `${english} ${chinese}`]) aliases.set(value, english);
}
export function normalizeVehicleBrand(value, { strict = true } = {}) {
  const raw = String(value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").replace(/\s+/g, " ").trim();
  const text = raw.toUpperCase().replace(/\s*\|\s*/g, "|");
  if (!text || ["无品牌", "无品牌|", "NO BRAND", "NO-BRAND", "NONE"].includes(text)) return "";
  if (aliases.has(text)) return aliases.get(text);
  const english = text.replace(/^无品牌\|/, "").replace(/^\|/, "");
  if (english.length <= 128 && /[A-Z]/.test(english) && /^[A-Z0-9][A-Z0-9 &/().+'-]*$/.test(english)) return english;
  if (!strict) return raw;
  throw new Error("汽车品牌（vehicle_brand/brand）无法识别，请在品牌字段填写英文名称，例如 TOYOTA；不要把中文品牌、车型或多个品牌混填。");
}
export function vehicleBrandAliases(value) {
  const brand = normalizeVehicleBrand(value, { strict: false });
  const chinese = VEHICLE_BRAND_CHINESE[brand];
  return [...new Set([brand, ...(chinese ? [chinese, `${chinese}|${brand}`, `${chinese} ${brand}`, `${brand} ${chinese}`] : []), `无品牌|${brand}`, `|${brand}`])];
}

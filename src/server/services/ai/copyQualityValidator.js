export function validateCopyBundle(bundle = {}, contract = {}) {
  const title = cleanText(bundle.title);
  const tags = normalizeTags(bundle.tags);
  const description = cleanText(bundle.description);
  const combined = `${title} ${tags.join(" ")} ${description}`.toLowerCase();
  const errors = [];
  const warnings = [];

  if (!title) errors.push("missing_title");
  if (title && hasCjkText(title)) errors.push("title_contains_chinese");
  if (title && looksBrokenText(title)) errors.push("title_looks_broken");
  if (tags.some(hasCjkText)) errors.push("tags_contain_chinese");
  if (tags.some(looksBrokenText)) errors.push("tags_look_broken");
  if (!description) errors.push("missing_description");
  if (description && hasCjkText(description)) errors.push("description_contains_chinese");
  if (description && looksBrokenText(description)) errors.push("description_looks_broken");

  const targetModel = cleanText(contract.targetModel);
  if (targetModel && !containsLoose(combined, targetModel)) errors.push(`missing_target_model:${targetModel}`);

  const subject = contract.productSubject || {};
  const subjectTokens = normalizeArray(subject.requiredAny).filter((item) => item.length >= 3);
  if (subjectTokens.length && !subjectTokens.some((token) => combined.includes(token.toLowerCase()))) {
    errors.push(`missing_product_subject:${subject.key || "unknown"}`);
  }

  for (const token of normalizeArray(subject.forbidden)) {
    if (token && containsToken(combined, token)) errors.push(`unrelated_subject_token:${token}`);
  }

  const material = cleanText(contract.material);
  if (material && !containsAnyMaterial(combined, material)) errors.push(`missing_material:${material}`);

  const color = cleanText(contract.color);
  if (color && !containsColor(combined, color)) warnings.push(`missing_color:${color}`);

  const quantity = cleanText(contract.quantity);
  if (quantity && !containsQuantity(combined, quantity)) errors.push(`missing_quantity:${quantity}`);

  if (tags.length < 8) warnings.push("too_few_tags");
  if (tags.length > 25) warnings.push("too_many_tags");
  if (tags.some((tag) => tag.length > 35)) warnings.push("tag_too_long");
  if (description && russianWordCount(description) < 45) warnings.push("description_too_short");
  if (description && russianWordCount(description) > 180) warnings.push("description_too_long");

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    normalized: {
      title,
      tags,
      description
    }
  };
}

export function parseCopyBundleResponse(content = "") {
  const raw = String(content || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  const parsed = JSON.parse(jsonText);
  return {
    title: cleanText(parsed.title || parsed.name || parsed.fields?.title),
    tags: normalizeTags(parsed.tags || parsed.keywords || parsed.fields?.tags),
    description: cleanText(parsed.description || parsed.summary || parsed.fields?.description || parsed.fields?.summary),
    factsUsed: normalizeList(parsed.factsUsed || parsed.facts_used),
    strategyApplied: cleanText(parsed.strategyApplied || parsed.strategy_applied)
  };
}

function normalizeTags(value) {
  return normalizeList(value)
    .flatMap((item) => String(item || "").split(/[\n,，;；]+/))
    .map((item) => cleanText(item).replace(/^#+/, ""))
    .filter(Boolean)
    .map((item) => `#${item.replace(/\s+/g, "_")}`)
    .filter((item, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value || "").split(/[\n,，;；|]+/).map(cleanText).filter(Boolean);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasCjkText(value = "") {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(value || ""));
}

function looksBrokenText(value = "") {
  const text = String(value || "");
  return /[\uFFFD\u952F\u9429\u6236\u7223]/u.test(text) || /\?{4,}/.test(text);
}

function containsLoose(text = "", value = "") {
  const haystack = String(text || "").toLowerCase().replace(/[_\s-]+/g, "");
  const needle = String(value || "").toLowerCase().replace(/[_\s-]+/g, "");
  return Boolean(needle && haystack.includes(needle));
}

function containsToken(text = "", value = "") {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return false;
  return new RegExp(`(^|[^A-Za-zА-Яа-яЁё0-9])${escapeRegExp(token)}[A-Za-zА-Яа-яЁё0-9]*(?=$|[^A-Za-zА-Яа-яЁё0-9])`, "i").test(String(text || ""));
}

function containsColor(text = "", color = "") {
  const lower = String(text || "").toLowerCase();
  const normalized = String(color || "").toLowerCase();
  if (containsLoose(lower, normalized)) return true;
  if (normalized.includes("серебрист")) return lower.includes("серебрист");
  if (normalized.includes("черн") || normalized.includes("чёрн")) return lower.includes("черн") || lower.includes("чёрн");
  if (normalized.includes("бел")) return lower.includes("бел");
  return false;
}

function containsAnyMaterial(text = "", material = "") {
  const lower = String(text || "").toLowerCase();
  const normalized = String(material || "").toLowerCase();
  if (containsLoose(lower, normalized)) return true;
  if (normalized.includes("abs")) return /\babs\b/i.test(text);
  if (normalized.includes("резин")) return lower.includes("резин");
  if (normalized.includes("нержав")) return lower.includes("нержав") || lower.includes("сталь");
  if (normalized.includes("силикон")) return lower.includes("силикон");
  return false;
}

function containsQuantity(text = "", quantity = "") {
  const number = String(quantity || "").match(/\d+/)?.[0] || "";
  if (number) return containsToken(text, number);
  return containsLoose(text, quantity.replace(/\s*шт\.?/i, ""));
}

function russianWordCount(value = "") {
  const words = String(value || "").match(/[A-Za-zА-Яа-яЁё0-9]+/g);
  return words ? words.length : 0;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

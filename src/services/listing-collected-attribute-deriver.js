function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeStringList(item));
  if (value && typeof value === "object") return normalizeStringList(value.value || value.name || value.text || "");
  return String(value || "").split(/[,\s\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function attributeKey(item = {}) {
  return String(item.attribute_id || item.id || item.name || item.attribute_name || "").trim();
}

function normalizeAttributeValue(item = {}) {
  const values = normalizeArray(item.values).map((value) => {
    if (value && typeof value === "object") return normalizeString(value.value || value.label || value.name || value.text || "");
    return normalizeString(value);
  }).filter(Boolean);
  if (values.length) return item.is_collection ? values : values.join(", ");
  if (Array.isArray(item.value)) {
    const list = item.value.map((value) => normalizeString(value)).filter(Boolean);
    return item.is_collection ? list : list.join(", ");
  }
  return normalizeString(item.value || item.attribute_value || "");
}

function upsertAttribute(target = [], next = {}) {
  if (!next || typeof next !== "object") return;
  const key = attributeKey(next);
  const value = normalizeAttributeValue(next);
  if (!key && !value) return;
  const found = target.find((item) => {
    if (key && attributeKey(item) === key) return true;
    return !key && normalizeString(item.name) && normalizeString(item.name) === normalizeString(next.name);
  });
  if (found) {
    if (!normalizeAttributeValue(found) && value) found.value = next.value;
    if (!found.attribute_id && next.attribute_id) found.attribute_id = next.attribute_id;
    if (!found.type && next.type) found.type = next.type;
    if ((!found.values || !found.values.length) && Array.isArray(next.values) && next.values.length) found.values = next.values;
    if (!found.source && next.source) found.source = next.source;
    return;
  }
  target.push({
    name: normalizeString(next.name),
    value: next.value,
    required: Boolean(next.required),
    attribute_id: next.attribute_id || "",
    type: next.type || "text",
    dictionary_id: next.dictionary_id || "",
    values: Array.isArray(next.values) ? next.values : [],
    source: next.source || "collected_facts",
    fixed_candidate: Boolean(next.fixed_candidate)
  });
}

function deriveTopLevelFacts(facts = {}, raw = {}, editPayload = {}) {
  return {
    brand: normalizeString(editPayload.brand || facts.base?.brand || raw.brand || ""),
    model: normalizeString(editPayload.model || raw.model || facts.base?.model || ""),
    color: normalizeString(editPayload.color || facts.base?.color || raw.color || ""),
    tags: [...new Set(normalizeStringList(editPayload.tags || facts.base?.tags || raw.hashtags || []))],
    description: normalizeString(editPayload.description || facts.base?.description || raw.description || ""),
    richContent: editPayload.rich_content_json ||
      editPayload.richContentJson ||
      editPayload.rich_content ||
      editPayload.richContent ||
      raw.rich_content_json ||
      raw.richContentJson ||
      raw.rich_content ||
      raw.richContent ||
      raw.json_content ||
      raw.jsonContent ||
      ""
  };
}

export function deriveCollectedAttributesFromFacts(facts = {}, raw = {}, editPayload = {}) {
  const result = [];
  for (const item of normalizeArray(facts.attributes)) {
    upsertAttribute(result, {
      ...item,
      value: normalizeAttributeValue(item),
      source: item.source || "collected_facts"
    });
  }
  const summary = deriveTopLevelFacts(facts, raw, editPayload);
  if (summary.brand) {
    upsertAttribute(result, {
      name: "Brand",
      value: summary.brand,
      attribute_id: 85,
      source: "collected_facts.fixed",
      fixed_candidate: true
    });
  }
  if (summary.model) {
    upsertAttribute(result, {
      name: "Model name",
      value: summary.model,
      attribute_id: 9048,
      source: "collected_facts.fixed",
      fixed_candidate: true
    });
  }
  if (summary.tags.length) {
    upsertAttribute(result, {
      name: "Product tags",
      value: summary.tags.join(","),
      attribute_id: 23171,
      type: "multiselect",
      source: "collected_facts.fixed",
      fixed_candidate: true
    });
  }
  if (summary.description) {
    upsertAttribute(result, {
      name: "Description",
      value: summary.description,
      attribute_id: 4191,
      type: "textarea",
      source: "collected_facts.fixed",
      fixed_candidate: true
    });
  }
  if (summary.richContent) {
    upsertAttribute(result, {
      name: "Rich content JSON",
      value: typeof summary.richContent === "string"
        ? summary.richContent
        : (summary.richContent ? JSON.stringify(summary.richContent, null, 2) : ""),
      attribute_id: 11254,
      type: "rich_json",
      source: "collected_facts.fixed",
      fixed_candidate: true
    });
  }
  return result;
}

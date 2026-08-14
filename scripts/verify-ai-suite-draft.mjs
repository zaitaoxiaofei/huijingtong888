import { mysqlQuery } from "../src/mysql-pool.js";

const rows = await mysqlQuery(`
  SELECT id, template_id, product_name, internal_code, source_images_json,
    template_payload_json, manual_facts_json, status, created_at, updated_at
  FROM listing_drafts
  WHERE id = 2425
`);

const result = rows.map((row) => {
  const images = JSON.parse(row.source_images_json || "[]");
  const payload = JSON.parse(row.template_payload_json || "{}");
  const editable = payload.editable_payload || {};
  const variant = Array.isArray(editable.variants) ? editable.variants[0] || {} : {};
  const manualFacts = JSON.parse(row.manual_facts_json || "{}");
  const attributeSources = [...(Array.isArray(payload.category_attributes) ? payload.category_attributes : []), ...(Array.isArray(editable.category_attributes) ? editable.category_attributes : []), ...(Array.isArray(payload.attributes) ? payload.attributes : []), ...(Array.isArray(editable.attributes) ? editable.attributes : [])];
  const oldCopyPaths = [];
  const walk = (value, path = "payload") => {
    if (typeof value === "string" && value.includes("#органайзерGeely")) oldCopyPaths.push(path);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => walk(item, `${path}.${key}`));
  };
  walk(payload);
  return {
    id: row.id,
    templateId: row.template_id,
    productName: row.product_name,
    internalCode: row.internal_code,
    status: row.status,
    imageCount: images.length,
    title: editable.title || payload.title || "",
    descriptionLength: String(editable.description || payload.description || "").length,
    oldCopyPaths,
    variantTextFields: Object.fromEntries(Object.entries(variant).filter(([key, value]) => typeof value === "string" && /(title|name|description|summary|tag)/i.test(key))),
    variantDynamicAttributes: variant.dynamic_attributes || {},
    manualTextFields: Object.fromEntries(Object.entries(manualFacts).filter(([key, value]) => typeof value === "string" && /(title|name|description|summary|tag)/i.test(key))),
    copyAttributes: attributeSources.filter((attribute) => [4191, 23171].includes(Number(attribute.attribute_id || attribute.id || 0)) || /(简介|description|аннотация|описание|产品标签|关键词|тег)/i.test(String(attribute.name_zh || attribute.name || ""))).map((attribute) => ({ id: attribute.attribute_id || attribute.id, name: attribute.name_zh || attribute.name, value: attribute.value })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);

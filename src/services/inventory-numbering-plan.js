import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeVehicleBrand } from "../shared/vehicle-brand.js";

const SOURCE_FIELDS = [
  "id", "tenant_id", "code", "selection_id", "inventory_number", "inventory_number_category",
  "inventory_number_brand", "inventory_number_sequence", "inventory_number_version", "inventory_category", "vehicle_brand", "fitment_type", "vehicle_model",
  "vehicle_models_json", "active", "product_type", "selection_status", "updated_at", "inventory_eligible"
];
const RESERVED_BRANDS = new Set(["PENDING", "UNIVERSAL"]);
const IDENTITY_CORRECTION_FIELDS = new Set(["name", "inventory_category", "vehicle_brand", "fitment_type", "vehicle_model", "vehicle_models_json"]);
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const clean = (value) => String(value ?? "").trim();

function integer(value, label, minimum = 0) {
  const number = Number(value);
  assert.ok((typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) && Number.isSafeInteger(number) && number >= minimum, `${label} must be a safe integer >= ${minimum}`);
  return number;
}

function binary(value, label) {
  assert.ok([true, false, 0, 1, "0", "1"].includes(value), `${label} must be an explicit boolean or 0/1`);
  return value === true || value === 1 || value === "1";
}

// Canonical object keys make snapshots independent of SQL column or JSON object key order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Source values must be plain JSON data");
    return Object.fromEntries(Object.keys(value).sort(lexical).map((key) => [key, canonical(value[key])]));
  }
  assert.ok(value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value)), "Source values must be finite JSON data");
  return value;
}

export function normalizeInventoryNumberingSourceProduct(product) {
  assert.ok(product && typeof product === "object" && !Array.isArray(product), "A source product must be an object");
  for (const field of SOURCE_FIELDS) assert.ok(Object.hasOwn(product, field), `Missing source field: ${field}`);
  integer(product.id, "product.id", 1);
  if (product.tenant_id !== null) integer(product.tenant_id, "product.tenant_id", 1);
  binary(product.active, "product.active");
  binary(product.inventory_eligible, "product.inventory_eligible");
  assert.match(product.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/, "updated_at must be the database UTC value with six fractional digits");
  const normalized = { ...product };
  for (const field of ['id', 'tenant_id', 'inventory_number_category', 'inventory_number_brand', 'inventory_number_sequence', 'inventory_number_version']) {
    if (normalized[field] !== null) normalized[field] = integer(normalized[field], `product.${field}`, field === 'id' || field === 'tenant_id' ? 1 : 0);
  }
  normalized.active = binary(product.active, 'product.active') ? 1 : 0;
  normalized.inventory_eligible = binary(product.inventory_eligible, 'product.inventory_eligible') ? 1 : 0;
  return canonical(normalized);
}

function normalizedSource(products) {
  assert.ok(Array.isArray(products), "products must contain the complete source rows");
  const rows = products.map(normalizeInventoryNumberingSourceProduct).sort((left, right) => Number(left.id) - Number(right.id));
  assert.equal(new Set(rows.map((row) => Number(row.id))).size, rows.length, "Duplicate source product ID");
  return rows;
}

export function inventoryNumberingSourceSummary(products) {
  const rows = normalizedSource(products);
  return { row_count: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

export function formatInventoryNumber(categoryId, brandId, sequence) {
  return [integer(categoryId, "category_id"), integer(brandId, "brand_id"), integer(sequence, "sequence", 1)].join("-");
}

export function classifyInventoryNumberIdentity(product = {}) {
  const core_name = clean(product.inventory_category);
  const fitment = clean(product.fitment_type);
  const rawBrand = clean(product.vehicle_brand);
  const review_reasons = [];
  if (!core_name) review_reasons.push("missing_inventory_category");
  if (!fitment) review_reasons.push("missing_fitment_type");
  else if (!["specific", "universal"].includes(fitment)) review_reasons.push("unknown_fitment_type");

  let models = product.vehicle_models_json;
  let invalidModels = false;
  if (models !== null && models !== undefined) {
    if (typeof models === "string") {
      try { models = JSON.parse(models); } catch { invalidModels = true; }
    }
    if (!Array.isArray(models)) invalidModels = true;
  }
  if (invalidModels) review_reasons.push("invalid_vehicle_models_json");
  const hasModels = Boolean(clean(product.vehicle_model)) || (Array.isArray(models) && models.length > 0);
  let brand = "";
  try {
    brand = normalizeVehicleBrand(rawBrand);
    if (RESERVED_BRANDS.has(brand)) throw new Error("Reserved vehicle brand");
  } catch {
    review_reasons.push("invalid_vehicle_brand");
  }

  let brand_key = "PENDING";
  if (fitment === "universal") {
    if (rawBrand || hasModels) review_reasons.push("universal_has_brand_or_models");
    else if (!invalidModels) brand_key = "UNIVERSAL";
  } else if (fitment === "specific" || !fitment) {
    if (brand && !review_reasons.includes("invalid_vehicle_brand")) brand_key = brand;
    else if (fitment === "specific") review_reasons.push("specific_missing_vehicle_brand");
  }
  return { core_name, brand_key, review_reasons };
}

function identifier(value) {
  return clean(value).normalize("NFKC").toUpperCase();
}

function legacyIdentifierOwners(rows) {
  const owners = new Map();
  for (const row of rows) {
    for (const field of ["code", "selection_id", "inventory_number"]) {
      const key = identifier(row[field]);
      if (!key) continue;
      const owner = owners.get(key);
      assert.ok(!owner || owner.product_id === Number(row.id), `Cross-product legacy identifier conflict: ${key} (${owner?.product_id}/${row.id})`);
      owners.set(key, { product_id: Number(row.id), field });
    }
  }
  return owners;
}

function rankedRegistry(counts, reserved, keyName, firstId) {
  const reservedKeys = new Set(reserved.map((row) => row[keyName]));
  const ranked = [...counts].filter(([key]) => !reservedKeys.has(key))
    .sort((left, right) => right[1] - left[1] || lexical(left[0], right[0]));
  return [...reserved.map((row) => ({ ...row, initial_product_count: counts.get(row[keyName]) || 0 })),
    ...ranked.map(([key, count], index) => ({ id: firstId + index, [keyName]: key, initial_product_count: count }))];
}

function correctionText(value, field, { required = false } = {}) {
  assert.equal(typeof value, "string", `Identity correction ${field} must be a string`);
  const text = value.trim();
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(text), `Identity correction ${field} cannot contain control characters`);
  assert.ok([...text].length <= 255 && (!required || text.length > 0), `Identity correction ${field} must contain ${required ? "1..255" : "0..255"} characters`);
  return text;
}

function normalizeIdentityCorrections(corrections, rows, targets) {
  assert.ok(Array.isArray(corrections), "identityCorrections must be an array");
  const source = new Map(rows.map((row) => [row.id, row]));
  const targetIds = new Set(targets.map((row) => row.id));
  const seen = new Set();
  return corrections.map((correction) => {
    assert.ok(correction && typeof correction === "object" && !Array.isArray(correction), "Identity correction must be an object");
    assert.ok(Object.keys(correction).every((key) => ["product_id", "fields"].includes(key)), "Unknown identity correction property");
    const product_id = integer(correction.product_id, "Identity correction product_id", 1);
    assert.ok(!seen.has(product_id), `Duplicate identity correction product ID: ${product_id}`);
    seen.add(product_id);
    assert.ok(source.has(product_id), `Unknown identity correction product ID: ${product_id}`);
    assert.ok(targetIds.has(product_id), `Identity correction product is not a numbering target: ${product_id}`);
    const input = correction.fields;
    assert.ok(input && typeof input === "object" && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)), "Identity correction fields must be a plain object");
    assert.ok(Object.keys(input).length > 0, "Identity correction fields cannot be empty");
    const fields = {};
    for (const [field, value] of Object.entries(input)) {
      assert.ok(IDENTITY_CORRECTION_FIELDS.has(field), `Identity correction field is not allowed: ${field}`);
      if (field === "vehicle_models_json") {
        let models = value;
        if (typeof models === "string") {
          try { models = JSON.parse(models); } catch { assert.fail("Identity correction vehicle_models_json must be a JSON array or null"); }
        }
        assert.ok(models === null || Array.isArray(models), "Identity correction vehicle_models_json must be a JSON array or null");
        assert.ok(models === null || models.length <= 255, "Identity correction vehicle_models_json cannot exceed 255 models");
        fields[field] = models === null ? null : models.map((model) => correctionText(model, "vehicle_models_json[]", { required: true }));
        assert.ok(models === null || new Set(fields[field]).size === fields[field].length, "Identity correction vehicle_models_json cannot contain duplicate models");
      } else {
        fields[field] = correctionText(value, field, { required: ["name", "inventory_category", "fitment_type"].includes(field) });
        if (field === "vehicle_brand") fields[field] = normalizeVehicleBrand(fields[field]);
        if (field === "fitment_type") assert.ok(["specific", "universal"].includes(fields[field]), "Identity correction fitment_type must be specific or universal");
      }
    }
    const identity = classifyInventoryNumberIdentity({ ...source.get(product_id), ...fields });
    assert.ok(identity.core_name && identity.brand_key !== "PENDING" && identity.review_reasons.length === 0, `Identity correction must resolve all pending or conflicting identity fields: ${product_id}`);
    return { product_id, fields: canonical(fields) };
  }).sort((left, right) => left.product_id - right.product_id);
}

/** First issuance only. Registry IDs and group counters in this review plan are frozen on apply. */
export function buildInventoryNumberingPlan({ products, defaultTenantId, identityCorrections = [] } = {}) {
  const default_tenant_id = integer(defaultTenantId, "defaultTenantId", 1);
  const rows = normalizedSource(products);
  const aliases = legacyIdentifierOwners(rows);
  const targets = rows.filter((row) => clean(row.inventory_number) || (binary(row.active, "product.active") && binary(row.inventory_eligible, "product.inventory_eligible")));
  const identity_corrections = normalizeIdentityCorrections(identityCorrections, rows, targets);
  const updates = new Map(identity_corrections.map((correction) => [correction.product_id, correction.fields]));
  const categoriesCount = new Map([["", 0]]);
  const brandsCount = new Map([["PENDING", 0], ["UNIVERSAL", 0]]);
  const classified = targets.map((row) => ({ row, identity: classifyInventoryNumberIdentity({ ...row, ...updates.get(row.id) }) }));
  for (const { row, identity } of classified) {
    const count = binary(row.active, "product.active") && binary(row.inventory_eligible, "product.inventory_eligible") ? 1 : 0;
    categoriesCount.set(identity.core_name, (categoriesCount.get(identity.core_name) || 0) + count);
    brandsCount.set(identity.brand_key, (brandsCount.get(identity.brand_key) || 0) + count);
  }
  const categories = rankedRegistry(categoriesCount, [{ id: 0, core_name: "" }], "core_name", 1);
  const brands = rankedRegistry(brandsCount, [{ id: 0, brand_key: "PENDING" }, { id: 1, brand_key: "UNIVERSAL" }], "brand_key", 2);
  const categoryIds = new Map(categories.map((row) => [row.core_name, row.id]));
  const brandIds = new Map(brands.map((row) => [row.brand_key, row.id]));
  const groupCounters = new Map();
  const issued = new Set();
  const plannedProducts = classified.map(({ row, identity }) => {
    const category_id = categoryIds.get(identity.core_name);
    const brand_id = brandIds.get(identity.brand_key);
    const group = `${category_id}:${brand_id}`;
    if (!groupCounters.has(group)) groupCounters.set(group, { category_id, brand_id, last_sequence: 0 });
    const sequence = ++groupCounters.get(group).last_sequence;
    const new_inventory_number = formatInventoryNumber(category_id, brand_id, sequence);
    const owner = aliases.get(identifier(new_inventory_number));
    assert.ok(!owner || owner.product_id === Number(row.id), `New inventory number conflicts with another product's legacy identifier: ${new_inventory_number} (${row.id}/${owner?.product_id})`);
    assert.ok(!issued.has(new_inventory_number), `Duplicate new inventory number: ${new_inventory_number}`);
    issued.add(new_inventory_number);
    return {
      product_id: Number(row.id),
      tenant_id: row.tenant_id === null ? default_tenant_id : Number(row.tenant_id),
      expected: row,
      identity_updates: canonical(updates.get(row.id) || {}),
      category_id, brand_id, sequence, new_inventory_number,
      review_reasons: identity.review_reasons
    };
  });
  return {
    version: 2,
    format: "category-brand-sequence",
    default_tenant_id,
    identity_corrections,
    source: { ...inventoryNumberingSourceSummary(rows), target_count: plannedProducts.length },
    categories,
    brands,
    products: plannedProducts,
    counters: [...groupCounters.values()].sort((left, right) => left.category_id - right.category_id || left.brand_id - right.brand_id),
    summary: {
      active_eligible_product_count: rows.filter((row) => binary(row.active, "product.active") && binary(row.inventory_eligible, "product.inventory_eligible")).length,
      previously_issued_product_count: rows.filter((row) => clean(row.inventory_number)).length,
      review_product_count: plannedProducts.filter((row) => row.review_reasons.length).length,
      excluded_unissued_product_count: rows.length - plannedProducts.length
    }
  };
}

/** A fresh complete source is mandatory: a manifest alone cannot detect new products. */
export function validateInventoryNumberingPlan(plan, source) {
  assert.ok(source && Array.isArray(source.products), "Validation requires fresh complete source products");
  const rebuilt = buildInventoryNumberingPlan({ ...source, identityCorrections: plan?.identity_corrections });
  assert.deepEqual(canonical(plan), canonical(rebuilt), "Inventory numbering plan no longer matches its complete source or deterministic allocation");
  return { passed: true, source_row_count: rebuilt.source.row_count, target_count: rebuilt.products.length, source_sha256: rebuilt.source.sha256 };
}

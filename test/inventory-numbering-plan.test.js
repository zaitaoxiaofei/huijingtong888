import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInventoryNumberingPlan, classifyInventoryNumberIdentity, formatInventoryNumber,
  inventoryNumberingSourceSummary, normalizeInventoryNumberingSourceProduct, validateInventoryNumberingPlan
} from "../src/services/inventory-numbering-plan.js";

function product(id, overrides = {}) {
  return {
    id, tenant_id: null, code: `P-TEST-${id}`, selection_id: `SEL-TEST-${id}`,
    inventory_number: `99-${id}`, inventory_number_category: 99, inventory_number_brand: null, inventory_number_sequence: id, inventory_number_version: 1,
    inventory_category: "钥匙壳", vehicle_brand: "TENET", fitment_type: "specific",
    vehicle_model: "T7", vehicle_models_json: ["T7"], active: 1,
    product_type: "main", selection_status: "listed", updated_at: "2026-11-05 13:00:00.000000",
    inventory_eligible: true, ...overrides
  };
}

test("first category and brand rankings use active eligible counts; hidden issued stock still receives a distinct number", () => {
  const rows = [
    product(30, { inventory_category: "门槛条", vehicle_brand: "MAZDA", active: 0, inventory_eligible: false }),
    product(10), product(20),
    product(40, { inventory_category: "门槛条", vehicle_brand: "MAZDA" }),
    product(50, { inventory_category: "旧品", vehicle_brand: "FORD", active: 0, inventory_eligible: false }),
    product(60, { inventory_category: "不发号选品", vehicle_brand: "BMW", inventory_number: null, product_type: "selection", selection_status: "draft", inventory_eligible: false }),
    product(70, { inventory_number: null })
  ];
  const before = structuredClone(rows);
  const plan = buildInventoryNumberingPlan({ products: rows, defaultTenantId: 9 });
  assert.deepEqual(plan.categories, [
    { id: 0, core_name: "", initial_product_count: 0 },
    { id: 1, core_name: "钥匙壳", initial_product_count: 3 },
    { id: 2, core_name: "门槛条", initial_product_count: 1 },
    { id: 3, core_name: "旧品", initial_product_count: 0 }
  ]);
  assert.deepEqual(plan.brands.map((row) => [row.id, row.brand_key, row.initial_product_count]), [[0, "PENDING", 0], [1, "UNIVERSAL", 0], [2, "TENET", 3], [3, "MAZDA", 1], [4, "FORD", 0]]);
  assert.deepEqual(plan.products.map((row) => [row.product_id, row.new_inventory_number]), [[10, "1-2-1"], [20, "1-2-2"], [30, "2-3-1"], [40, "2-3-2"], [50, "3-4-1"], [70, "1-2-3"]]);
  assert.deepEqual(plan.counters, [{ category_id: 1, brand_id: 2, last_sequence: 3 }, { category_id: 2, brand_id: 3, last_sequence: 2 }, { category_id: 3, brand_id: 4, last_sequence: 1 }]);
  assert.equal(plan.source.row_count, 7);
  assert.equal(plan.source.target_count, 6);
  assert.deepEqual(rows, before, "planning must not mutate source fields or nested models");
  assert.deepEqual(buildInventoryNumberingPlan({ products: rows.toReversed(), defaultTenantId: 9 }), plan);
});

test("stable lexical ties and inactive-only registries are independent of input ordering", () => {
  const rows = [product(3, { inventory_category: "B", vehicle_brand: "TOYOTA" }), product(2, { inventory_category: "A", vehicle_brand: "BMW" }), product(1, { inventory_category: "C", vehicle_brand: "AUDI", active: 0 })];
  const plan = buildInventoryNumberingPlan({ products: rows, defaultTenantId: 5 });
  assert.deepEqual(plan.categories.map((row) => row.core_name), ["", "A", "B", "C"]);
  assert.deepEqual(plan.brands.map((row) => row.brand_key), ["PENDING", "UNIVERSAL", "BMW", "TOYOTA", "AUDI"]);
});

test("pending and universal are different; known brands survive missing fitment without changing facts", () => {
  const cases = [
    [{}, "PENDING", ["missing_inventory_category", "missing_fitment_type"]],
    [{ inventory_category: "气泡袋", fitment_type: "universal", vehicle_models_json: null }, "UNIVERSAL", []],
    [{ vehicle_brand: "", fitment_type: "specific" }, "PENDING", ["missing_inventory_category", "specific_missing_vehicle_brand"]],
    [{ vehicle_brand: "丰田|TOYOTA", fitment_type: "" }, "TOYOTA", ["missing_inventory_category", "missing_fitment_type"]],
    [{ vehicle_brand: "TENET", fitment_type: "universal" }, "PENDING", ["missing_inventory_category", "universal_has_brand_or_models"]],
    [{ vehicle_brand: "", fitment_type: "universal", vehicle_model: "CX-5" }, "PENDING", ["missing_inventory_category", "universal_has_brand_or_models"]],
    [{ fitment_type: "universal", vehicle_models_json: '[""]' }, "PENDING", ["missing_inventory_category", "universal_has_brand_or_models"]],
    [{ fitment_type: "universal", vehicle_models_json: "{" }, "PENDING", ["missing_inventory_category", "invalid_vehicle_models_json"]],
    [{ fitment_type: "universal", vehicle_models_json: "null" }, "PENDING", ["missing_inventory_category", "invalid_vehicle_models_json"]],
    [{ vehicle_brand: "TENET", fitment_type: "other" }, "PENDING", ["missing_inventory_category", "unknown_fitment_type"]],
    [{ vehicle_brand: "未知车型品牌", fitment_type: "specific" }, "PENDING", ["missing_inventory_category", "invalid_vehicle_brand", "specific_missing_vehicle_brand"]],
    [{ vehicle_brand: "UNIVERSAL", fitment_type: "specific" }, "PENDING", ["missing_inventory_category", "invalid_vehicle_brand", "specific_missing_vehicle_brand"]]
  ];
  for (const [row, key, reasons] of cases) {
    const before = structuredClone(row);
    const identity = classifyInventoryNumberIdentity(row);
    assert.equal(identity.brand_key, key);
    assert.deepEqual(identity.review_reasons, reasons);
    assert.deepEqual(row, before);
  }
  const plan = buildInventoryNumberingPlan({ products: [product(1, { inventory_category: "", fitment_type: "", vehicle_brand: "TENET" }), product(2, { fitment_type: "specific", vehicle_brand: "" }), product(3, { fitment_type: "universal", vehicle_brand: "", vehicle_model: "", vehicle_models_json: null })], defaultTenantId: 5 });
  assert.equal(plan.products[0].new_inventory_number, "0-2-1");
  assert.equal(plan.products[1].brand_id, 0);
  assert.equal(plan.products[2].brand_id, 1);
  assert.equal(plan.products[0].expected.fitment_type, "");
});

test("all previously issued selections and hidden stock are covered while unissued ineligible records are excluded", () => {
  const rows = [product(1, { product_type: "selection", selection_status: "draft", inventory_eligible: false }), product(2, { active: 0, inventory_eligible: false }), product(3, { inventory_number: null, inventory_eligible: false }), product(4, { inventory_number: null, active: 0 })];
  assert.deepEqual(buildInventoryNumberingPlan({ products: rows, defaultTenantId: 5 }).products.map((row) => row.product_id), [1, 2]);
});

test("effective tenant ownership is explicit but the exact NULL preimage and every input field remain intact", () => {
  const rows = [product(1, { name: "原名", tenant_id: null }), product(2, { tenant_id: 11 })];
  const plan = buildInventoryNumberingPlan({ products: rows, defaultTenantId: 7 });
  assert.equal(plan.products[0].tenant_id, 7);
  assert.equal(plan.products[0].expected.tenant_id, null);
  assert.equal(plan.products[0].expected.name, "原名");
  assert.equal(plan.products[1].tenant_id, 11);
  plan.products[0].expected.vehicle_models_json.push("T8");
  assert.deepEqual(rows[0].vehicle_models_json, ["T7"]);
});

test("legacy alias ambiguity is rejected across any product, including excluded selections", () => {
  const rows = [product(1, { selection_id: "same" }), product(2, { code: "ＳＡＭＥ", inventory_number: null, inventory_eligible: false })];
  assert.throws(() => buildInventoryNumberingPlan({ products: rows, defaultTenantId: 1 }), /Cross-product legacy identifier conflict/);
  assert.doesNotThrow(() => buildInventoryNumberingPlan({ products: [product(1, { code: "same", selection_id: "same" })], defaultTenantId: 1 }));
});

test("a newly allocated number cannot shadow another product's code, selection ID, or legacy number", () => {
  for (const field of ["code", "selection_id", "inventory_number"]) {
    const rows = [product(1), product(2, { active: 0, inventory_eligible: false, inventory_number: null, [field]: "1-2-1" })];
    assert.throws(() => buildInventoryNumberingPlan({ products: rows, defaultTenantId: 1 }), /conflicts with another product's legacy identifier/);
  }
  assert.doesNotThrow(() => buildInventoryNumberingPlan({ products: [product(1, { inventory_number: "1-2-1" })], defaultTenantId: 1 }));
});

test("fresh validation detects added rows, changed fields and tampered counters or allocations", () => {
  const source = { products: [product(1), product(2)], defaultTenantId: 5 };
  const plan = buildInventoryNumberingPlan(source);
  assert.equal(validateInventoryNumberingPlan(plan, source).passed, true);
  for (const changed of [
    { ...source, products: [...source.products, product(3, { inventory_number: null, inventory_eligible: false })] },
    { ...source, products: [product(1, { updated_at: "2026-11-05 13:00:00.000001" }), product(2)] },
    { ...source, products: [product(1, { vehicle_brand: "MAZDA" }), product(2)] }
  ]) assert.throws(() => validateInventoryNumberingPlan(plan, changed), /no longer matches/);
  for (const corrupt of [
    (p) => { p.counters[0].last_sequence--; },
    (p) => { p.products[0].new_inventory_number = "1-2-9"; },
    (p) => { p.products.pop(); },
    (p) => { p.brands[2].brand_key = "MAZDA"; }
  ]) {
    const altered = structuredClone(plan); corrupt(altered);
    assert.throws(() => validateInventoryNumberingPlan(altered, source), /no longer matches/);
  }
  assert.throws(() => validateInventoryNumberingPlan(plan), /fresh complete source/);
});

test("source digest covers all preimages and is independent of row and object key order", () => {
  const rows = [product(2), product(1)];
  const reverseKeys = rows.toReversed().map((row) => Object.fromEntries(Object.entries(row).reverse()));
  assert.deepEqual(inventoryNumberingSourceSummary(rows), inventoryNumberingSourceSummary(reverseKeys));
  assert.notEqual(inventoryNumberingSourceSummary(rows).sha256, inventoryNumberingSourceSummary([product(2), product(1, { vehicle_models_json: ["T8"] })]).sha256);
});

test("incomplete or ambiguous source values cannot silently become a migration manifest", () => {
  const missing = product(1); delete missing.selection_id;
  for (const row of [missing, product(1, { updated_at: "2026-11-05T13:00:00Z" }), product(1, { active: "false" }), product(1, { tenant_id: 0 }), product(1, { id: Number.MAX_SAFE_INTEGER + 1 }), product(1, { inventory_eligible: null })]) {
    assert.throws(() => buildInventoryNumberingPlan({ products: [row], defaultTenantId: 1 }));
  }
  assert.throws(() => buildInventoryNumberingPlan({ products: [product(1), product(1)], defaultTenantId: 1 }), /Duplicate source product ID/);
  assert.throws(() => buildInventoryNumberingPlan({ products: [product(1)], defaultTenantId: 0 }));
  assert.throws(() => normalizeInventoryNumberingSourceProduct(product(1, { extra: undefined })), /finite JSON data/);
});

test("three integer segments never add padding and reject unsafe counters", () => {
  assert.equal(formatInventoryNumber(0, 0, 1), "0-0-1");
  assert.equal(formatInventoryNumber(2, 103, 10001), "2-103-10001");
  for (const args of [[1, 2, 0], [1, -1, 1], [-1, 0, 1], [1, 2, Number.MAX_SAFE_INTEGER + 1], [true, 0, 1], [" ", 0, 1]]) assert.throws(() => formatInventoryNumber(...args));
});

test("explicit reviewed corrections resolve the four confirmed identities without changing original source preimages", () => {
  const rows = [
    product(58, { name: "钥匙壳 通用 黑色/白色 普通款 皮革 1个", vehicle_brand: "", vehicle_model: "T7/T8", vehicle_models_json: ["T7", "T8"] }),
    product(323, { name: "钥匙壳 通用 普通款 1个", vehicle_brand: "", vehicle_model: "T7/T8", vehicle_models_json: ["T7", "T8"] }),
    product(542, { name: "钥匙壳 通用 透黑 普通款 1个 套装", vehicle_brand: "", vehicle_model: "CX-5", vehicle_models_json: null }),
    product(720, { name: "TENET T7 车窗饰条", inventory_category: "", vehicle_brand: "TENET", fitment_type: "", vehicle_model: "", vehicle_models_json: null }),
    product(800, { name: "未更正产品", vehicle_brand: "MAZDA" })
  ];
  const corrections = [
    { product_id: 720, fields: { inventory_category: "车窗饰条", vehicle_brand: "TENET", fitment_type: "specific", vehicle_model: "T7", vehicle_models_json: ["T7"] } },
    { product_id: 542, fields: { name: "钥匙壳 MAZDA CX-5 透黑 普通款 1个 套装", vehicle_brand: "MAZDA" } },
    { product_id: "58", fields: { name: "钥匙壳 TENET T7/T8 黑色/白色 普通款 皮革 1个", vehicle_brand: " 特耐|TENET " } },
    { product_id: 323, fields: { name: "钥匙壳 TENET T7/T8 普通款 1个", vehicle_brand: "tenet" } }
  ];
  const before = structuredClone(rows), correctionsBefore = structuredClone(corrections);
  const baseline = buildInventoryNumberingPlan({ products: rows, defaultTenantId: 5 });
  const plan = buildInventoryNumberingPlan({ products: rows, defaultTenantId: 5, identityCorrections: corrections });
  assert.equal(baseline.summary.review_product_count, 4);
  assert.equal(plan.summary.review_product_count, 0);
  assert.deepEqual(plan.source, baseline.source, "reviewed projections must not change the original complete-source digest");
  assert.deepEqual(plan.identity_corrections.map(row => row.product_id), [58, 323, 542, 720]);
  assert.deepEqual(plan.brands.map(row => [row.brand_key, row.initial_product_count]), [["PENDING", 0], ["UNIVERSAL", 0], ["TENET", 3], ["MAZDA", 2]]);
  assert.deepEqual(plan.categories.map(row => [row.core_name, row.initial_product_count]), [["", 0], ["钥匙壳", 4], ["车窗饰条", 1]]);
  for (const row of plan.products) {
    assert.deepEqual(row.expected, normalizeInventoryNumberingSourceProduct(rows.find(source => source.id === row.product_id)));
    assert.deepEqual(row.identity_updates, plan.identity_corrections.find(correction => correction.product_id === row.product_id)?.fields || {});
    assert.deepEqual(row.review_reasons, []);
  }
  assert.equal(plan.products.find(row => row.product_id === 720).new_inventory_number, "2-2-1");
  assert(!Object.hasOwn(plan.products.find(row => row.product_id === 720).identity_updates, "name"), "the already confirmed window-trim name remains unchanged");
  assert.equal(validateInventoryNumberingPlan(plan, { products: rows, defaultTenantId: 5 }).passed, true);
  assert.deepEqual(buildInventoryNumberingPlan({ products: rows.toReversed(), defaultTenantId: 5, identityCorrections: corrections.toReversed() }), plan);
  assert.deepEqual(rows, before);
  assert.deepEqual(corrections, correctionsBefore);
  const tampered = structuredClone(plan);
  tampered.products[0].identity_updates.name = "未审核名称";
  assert.throws(() => validateInventoryNumberingPlan(tampered, { products: rows, defaultTenantId: 5 }), /no longer matches/);
  assert.throws(() => validateInventoryNumberingPlan(plan, { products: rows.map(row => row.id === 58 ? { ...row, name: "已经变化的原名" } : row), defaultTenantId: 5 }), /no longer matches/);
});

test("identity correction normalization is deterministic, explicit and independent of its caller's objects", () => {
  const source = { products: [product(1)], defaultTenantId: 5 };
  const plan = buildInventoryNumberingPlan({ ...source, identityCorrections: [{ product_id: 1, fields: { name: " 新名 ", inventory_category: " 门槛条 ", vehicle_brand: " 丰田|TOYOTA ", fitment_type: " specific ", vehicle_model: " CAMRY ", vehicle_models_json: '[" CAMRY "]' } }] });
  assert.deepEqual(plan.identity_corrections, [{ product_id: 1, fields: { name: "新名", inventory_category: "门槛条", vehicle_brand: "TOYOTA", fitment_type: "specific", vehicle_model: "CAMRY", vehicle_models_json: ["CAMRY"] } }]);
  assert.equal(validateInventoryNumberingPlan(plan, { ...source, identityCorrections: [{ product_id: 1, fields: { name: "外部参数不得覆盖清单" } }] }).passed, true);
  plan.identity_corrections[0].fields.vehicle_models_json.push("COROLLA");
  assert.deepEqual(plan.products[0].identity_updates.vehicle_models_json, ["CAMRY"]);
  assert.deepEqual(source.products[0].vehicle_models_json, ["T7"]);
  assert.throws(() => validateInventoryNumberingPlan(plan, source), /no longer matches/);
  const universal = buildInventoryNumberingPlan({ ...source, identityCorrections: [{ product_id: 1, fields: { vehicle_brand: "", fitment_type: "universal", vehicle_model: "", vehicle_models_json: null } }] });
  assert.equal(universal.products[0].brand_id, 1);
  assert.deepEqual(universal.products[0].review_reasons, []);
});

test("unreviewed fields, duplicate or unknown IDs, invalid types and incomplete corrected identities are refused", () => {
  const source = { products: [product(1), product(2, { inventory_number: null, inventory_eligible: false })], defaultTenantId: 5 };
  const correction = fields => [{ product_id: 1, fields }];
  const invalid = [
    null, {}, [null], [{ product_id: 1, fields: {} }],
    [{ product_id: 1, fields: { name: "A" } }, { product_id: "1", fields: { name: "B" } }],
    [{ product_id: 3, fields: { name: "不存在" } }],
    [{ product_id: 2, fields: { name: "没有发号目标" } }],
    [{ product_id: 1, fields: { name: "A" }, reason: "额外属性" }],
    ...["id", "tenant_id", "active", "updated_at", "code", "selection_id", "inventory_number", "inventory_eligible"].map(field => correction({ [field]: 1 })),
    correction({ name: null }), correction({ name: " " }), correction({ name: "x".repeat(256) }), correction({ name: "A\u0000B" }),
    correction({ inventory_category: "" }), correction({ inventory_category: "x".repeat(256) }),
    correction({ vehicle_brand: null }), correction({ vehicle_brand: "未知车型品牌" }), correction({ vehicle_brand: "PENDING" }), correction({ vehicle_brand: "UNIVERSAL" }), correction({ vehicle_brand: "" }),
    correction({ fitment_type: "" }), correction({ fitment_type: "other" }), correction({ fitment_type: "universal" }),
    correction({ vehicle_model: 7 }), correction({ vehicle_model: "x".repeat(256) }),
    correction({ vehicle_models_json: "{" }), correction({ vehicle_models_json: "{}" }), correction({ vehicle_models_json: [""] }), correction({ vehicle_models_json: [7] }), correction({ vehicle_models_json: [" T7", "T7 "] }), correction({ vehicle_models_json: ["x".repeat(256)] }), correction({ vehicle_models_json: Array.from({ length: 256 }, (_, i) => `M${i}`) })
  ];
  for (const identityCorrections of invalid) assert.throws(() => buildInventoryNumberingPlan({ ...source, identityCorrections }));
  assert.throws(() => buildInventoryNumberingPlan({ products: [product(1, { inventory_category: "", vehicle_brand: "" })], defaultTenantId: 5, identityCorrections: correction({ name: "改名仍缺品牌及品名" }) }), /resolve all pending/);
});

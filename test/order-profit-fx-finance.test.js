import assert from "node:assert/strict";
import test from "node:test";
import { convertFxFinanceRows, readOrderFxFinanceRows, resolveFxFinanceCurrency } from "../src/services/order-profit-fx-finance.js";
import { normalizeOzonFinanceAccrual } from "../src/services/ozon-finance-accruals.js";

const order = { id: 1, shop_id: 9, posting_number: "123-1", order_number: "123" };
const financeRow = (overrides = {}) => ({ id: 1, shop_id: 9, operation_id: "sale1", posting_number: "123-1",
  service_type: "sale_commission", service_name: "Commission", amount: -100,
  accruals_for_sale: 1000, sale_commission: -100, delivery_charge: 0, return_delivery_charge: 0,
  currency_code: "RUB", raw_json: "{}", ...overrides });
const classifyCategory = (row) => row.service_type === "sale_commission" ? "commission" : "delivery";

function fixture(source, siblings = []) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /WHERE (?:o\.)?shop_id = \?/);
    assert.equal(params[0], 9);
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE)\b/);
    return sql.includes("FROM ozon_finance_items") ? structuredClone(source) : structuredClone(siblings);
  } };
}

const sibling = (posting, itemId, price, currency = "RUB") => ({ shop_id: 9, order_id: itemId, order_item_id: itemId,
  posting_number: posting, ozon_sku: String(itemId), sale_price: price, quantity: 1,
  ozon_raw_json: JSON.stringify({ raw: { products: [{ sku: String(itemId), price: String(price), currency_code: currency }] } }) });

test("converts original RUB, keeps CNY amounts unchanged and ignores legacy conversion columns", () => {
  const result = convertFxFinanceRows([
    financeRow({ amount_cny: -9999 }),
    financeRow({ id: 2, currency_code: "CNY", amount: -6, accruals_for_sale: 40, amount_cny: -9999 })
  ], { shopId: 9, rateRubPerCny: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].amount_cny, -10);
  assert.equal(result.rows[0].accruals_for_sale_cny, 100);
  assert.equal(result.rows[1].amount_cny, -6);
  assert.equal(result.rows[1].accruals_for_sale_cny, 40);
  assert.equal(result.source_rows[0].currency_source, "ozon_finance_items.currency_code");
});

test("uses only explicit operation currency and blocks unknown, unsupported or conflicting currency", () => {
  assert.equal(resolveFxFinanceCurrency(financeRow({ currency_code: "", raw_json: '{"currency_code":"CNY"}' })).currency, "CNY");
  assert.equal(resolveFxFinanceCurrency(financeRow({ currency_code: "", raw_json: '{"customer_currency_code":"RUB","products":[{"currency_code":"CNY"}]}' })).code, "FX_FINANCE_CURRENCY_UNKNOWN");
  assert.equal(resolveFxFinanceCurrency(financeRow({ currency_code: "USD" })).code, "FX_FINANCE_CURRENCY_UNSUPPORTED");
  assert.equal(resolveFxFinanceCurrency(financeRow({ raw_json: '{"currency":"CNY"}' })).code, "FX_FINANCE_CURRENCY_CONFLICT");
  const mixed = convertFxFinanceRows([financeRow(), financeRow({ id: 2, currency_code: "" })], { shopId: 9, rateRubPerCny: 10 });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.rows, []);
  assert.equal(mixed.unknown_rows[0].id, 2);
});

test("verified shop contract evidence is explicit, scoped and cannot override conflicting source fields", () => {
  const evidence = { shop_id: 9, verified: true, currency_code: "RUB", source: "reviewed_contract", reference: "review/abc" };
  assert.equal(resolveFxFinanceCurrency(financeRow({ currency_code: "" }), { shopId: 9, currencyEvidence: evidence }).currency, "RUB");
  assert.throws(() => convertFxFinanceRows([], { shopId: 9, rateRubPerCny: 10, currencyEvidence: { ...evidence, shop_id: 10 } }), /verified shop/);
  assert.throws(() => convertFxFinanceRows([], { shopId: 9, rateRubPerCny: 10, currencyEvidence: { ...evidence, reference: "" } }), /verified shop/);
  assert.equal(resolveFxFinanceCurrency(financeRow({ raw_json: '{"currency":"CNY"}' }), { shopId: 9, currencyEvidence: evidence }).code, "FX_FINANCE_CURRENCY_CONFLICT");
});

test("reads full posting history and does not duplicate the gross accrual repeated on fee lines", async () => {
  const db = fixture([financeRow(), financeRow({ id: 2, service_type: "delivery", service_name: "Delivery", amount: -50 })]);
  const result = await readOrderFxFinanceRows({ query: db.query, order, rateRubPerCny: 10, classifyCategory });
  assert.equal(result.ok, true);
  assert.equal(result.sale_accrual_cny, 100);
  assert.equal(result.rows.reduce((sum, row) => sum + row.accruals_for_sale_cny, 0), 100);
  assert.deepEqual(result.category_signed_totals_cny, { commission: -10, delivery: -5 });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [9, "123-1", "123"]);
  assert.doesNotMatch(db.calls[0].sql, /DATE\(|operation_date\s*[<>]=?/);
});

test("allocates supplemental parent fees once and retains direct child income", async () => {
  const db = fixture([
    financeRow(),
    financeRow({ id: 2, posting_number: "123", operation_id: "parentSale", amount: -400, accruals_for_sale: 4000 }),
    financeRow({ id: 3, posting_number: "123", operation_id: "parentSale", service_type: "delivery", service_name: "Delivery", amount: -200, accruals_for_sale: 4000 })
  ], [sibling("123-1", 1, 1000), sibling("123-2", 2, 3000)]);
  const result = await readOrderFxFinanceRows({ query: db.query, order, rateRubPerCny: 10, allocationRateRubPerCny: 10, classifyCategory });
  assert.equal(result.ok, true);
  assert.equal(result.allocation.share, 0.25);
  assert.equal(result.sale_accrual_cny, 100);
  assert.equal(result.rows.reduce((sum, row) => sum + row.accruals_for_sale_cny, 0), 100);
  assert.deepEqual(result.category_signed_totals_cny, { commission: -10, delivery: -5 });
  assert.equal(result.rows.filter((row) => row.service_type === "sale_commission").length, 1);
  assert.equal(result.rows[1].derived_from_parent_posting, 1);
});

test("parent-only income is allocated once even though all parent fee lines repeat it", async () => {
  const source = [financeRow({ posting_number: "123", accruals_for_sale: 4000, amount: -400 }),
    financeRow({ id: 2, posting_number: "123", service_type: "delivery", service_name: "Delivery", amount: -200, accruals_for_sale: 4000 })];
  const db = fixture(source, [sibling("123-1", 1, 1000), sibling("123-2", 2, 3000)]);
  const result = await readOrderFxFinanceRows({ query: db.query, order, rateRubPerCny: 10, classifyCategory });
  assert.equal(result.ok, true);
  assert.equal(result.sale_accrual_cny, 100);
  assert.equal(result.rows.reduce((sum, row) => sum + row.accruals_for_sale_cny, 0), 100);
});

test("independent daily parent fees are retained even when a child has the same stable fee identity", async () => {
  const posting = "12345678-0042-1", parent = "12345678-0042";
  let id = 0;
  const records = [[1, posting, -10], [2, parent, -20]].flatMap(([accrual_id, unit_number, amount]) => {
    const monetary = { amount: String(amount), currency: "RUB" };
    const operation = normalizeOzonFinanceAccrual({ accrual_id, date: "2026-10-26", accrued_category: "NON_ITEM", unit_number,
      total_amount: monetary, non_item_fee: { type_id: 1, accrued: monetary } }, { types: [{ id: 1, name: "Acquiring" }] });
    return operation.rows.map(row => ({ ...row, id: ++id, shop_id: 9, operation_id: operation.operation_id, posting_number: unit_number, raw_json: operation.raw_json }));
  });
  assert.equal(records[0].service_type, records[1].service_type);
  const db = fixture(records, [sibling(posting, 1, 1000), sibling(`${parent}-2`, 2, 3000)]);
  const result = await readOrderFxFinanceRows({ query: db.query, order: { shop_id: 9, posting_number: posting, order_number: parent }, rateRubPerCny: 10,
    classifyCategory: row => row.service_type.split(":")[1] });
  assert.equal(result.ok, true);
  assert.equal(result.allocation.share, 0.25);
  assert.equal(result.rows.length, 2);
  assert.equal(result.category_signed_totals_cny.collecting_fee, -1.5);
});

test("an independent daily parent income event adds its allocated signed amount to direct income", async () => {
  const posting = "12345678-0042-1", parent = "12345678-0042";
  let id = 0;
  const records = [[1, posting, 1000], [2, parent, 400]].flatMap(([accrual_id, unit_number, amount]) => {
    const monetary = { amount: String(amount), currency: "RUB" };
    const operation = normalizeOzonFinanceAccrual({ accrual_id, date: "2026-10-26", accrued_category: "POSTING", unit_number,
      total_amount: monetary, posting: { products: [{ sku: "1", quantity: 1, commission: { sale_amount: monetary } }] } }, { types: [] });
    return operation.rows.map(row => ({ ...row, id: ++id, shop_id: 9, operation_id: operation.operation_id, posting_number: unit_number, raw_json: operation.raw_json }));
  });
  const db = fixture(records, [sibling(posting, 1, 1000), sibling(`${parent}-2`, 2, 3000)]);
  const result = await readOrderFxFinanceRows({ query: db.query, order: { shop_id: 9, posting_number: posting, order_number: parent }, rateRubPerCny: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.income_mode, "signed_accruals");
  assert.equal(result.income_rows.length, 2);
  assert.equal(result.sale_accrual_cny, 110);
});

test("uses fixed order-day parent weights for both FX comparisons with mixed original currencies", async () => {
  const source = [financeRow({ posting_number: "123", accruals_for_sale: 0, service_type: "delivery", service_name: "Delivery", amount: -300 })];
  const siblings = [sibling("123-1", 1, 1000, "RUB"), sibling("123-2", 2, 100, "CNY")];
  const atOrder = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 10, allocationRateRubPerCny: 10 });
  const atSigned = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 12, allocationRateRubPerCny: 10 });
  assert.equal(atOrder.allocation.share, 0.5);
  assert.equal(atSigned.allocation.share, 0.5);
  assert.equal(atOrder.rows[0].amount_cny, -15);
  assert.equal(atSigned.rows[0].amount_cny, -12.5);
});

test("unknown parent allocation weight does not silently fall back to equal shares or legacy CNY totals", async () => {
  const source = [financeRow({ posting_number: "123" })];
  const siblings = [sibling("123-1", 1, 1000), { ...sibling("123-2", 2, 3000), ozon_raw_json: "{}" }];
  const result = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "FX_FINANCE_PARENT_WEIGHT_UNKNOWN");
  assert.deepEqual(result.rows, []);
});

test("parent weights accept the normalizer's explicit original sale_currency field", async () => {
  const source = [financeRow({ posting_number: "123" })];
  const normalized = [1, 2].map(id => ({ ...sibling(`123-${id}`, id, 1000),
    ozon_raw_json: JSON.stringify({ items: [{ ozon_sku: String(id), sale_price: 1000, sale_currency: "RUB" }] }) }));
  const result = await readOrderFxFinanceRows({ query: fixture(source, normalized).query, order, rateRubPerCny: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.allocation.share, 0.5);
});

test("raw sibling seller-price objects use their own price/value/amount currency without losing precision", async () => {
  const source = [financeRow({ posting_number: "123" })];
  for (const amountKey of ["price", "value", "amount"]) {
    const siblings = [1, 2].map(id => ({ ...sibling(`123-${id}`, id, 1000), ozon_raw_json: JSON.stringify({ raw: { products: [
      { sku: String(id), price: { [amountKey]: id === 1 ? "12.3456789" : "37.0370367", currency: "CNY" },
        customer_price: { price: 99999, currency: "RUB" }, customer_currency_code: "RUB",
        financial_data: { price: { price: 5000, currency: "RUB" } } }
    ] } }) }));
    const result = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 12, allocationRateRubPerCny: 10 });
    assert.equal(result.ok, true, amountKey);
    assert.equal(result.allocation.share, 0.25, amountKey);
    assert.equal(result.allocation.sibling_weights_cny["123-1"], 12.3456789);
  }
});

test("a selected raw price owner with conflicting currency is not repaired by unrelated customer or financial currency", async () => {
  const source = [financeRow({ posting_number: "123" })];
  for (const product of [
    { sku: "1", price: { price: 100, currency: "CNY" }, currency_code: "RUB" },
    { sku: "1", price: { amount: 100, currency: "RUB" }, currency_code: "CNY" },
    { sku: "1", price: 100, financial_data: { price: { price: 100, currency: "CNY" } }, customer_currency_code: "CNY" }
  ]) {
    const siblings = [{ ...sibling("123-1", 1, 1000), ozon_raw_json: JSON.stringify({ raw: { products: [product] } }) }, sibling("123-2", 2, 3000)];
    const result = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "FX_FINANCE_PARENT_WEIGHT_UNKNOWN");
    assert.deepEqual(result.rows, []);
  }
});

test("tenant-scoped frozen sibling original prices win over later raw price/currency changes", async () => {
  const source = [financeRow({ posting_number: "123" })];
  const siblings = [
    { ...sibling("123-1", 1, 1000, "RUB"), fx_prices_json: JSON.stringify([{ ozon_sku: "1", amount: 50, currency: "CNY" }]) },
    { ...sibling("123-2", 2, 9999, "RUB"), fx_prices_json: JSON.stringify([{ ozon_sku: "2", amount: 150, currency: "CNY" }]) }
  ];
  const db = fixture(source, siblings);
  const result = await readOrderFxFinanceRows({ query: db.query, order, rateRubPerCny: 12, allocationRateRubPerCny: 10,
    items: [{ ozon_sku: "1", sale_price: 9999, sale_currency_code: "RUB" }] });
  assert.equal(result.ok, true);
  assert.equal(result.allocation.share, 0.25);
  assert.deepEqual(result.allocation.sibling_weights_cny, { "123-1": 50, "123-2": 150 });
  assert.match(db.calls[1].sql, /JOIN shops owned_shop ON owned_shop.id = o.shop_id/);
  assert.match(db.calls[1].sql, /frozen.tenant_key = \(CASE WHEN owned_shop.tenant_id/);
});

test("corrupt or conflicting frozen sibling definitions stay unknown instead of falling through to refreshed raw prices", async () => {
  const source = [financeRow({ posting_number: "123" })];
  for (const frozen of [
    {}, [{ ozon_sku: "1", amount: null, currency: "CNY" }],
    [{ ozon_sku: "1", amount: { price: 10, currency: "RUB" }, currency: "CNY" }],
    [{ ozon_sku: "1", amount: 10, currency: "CNY" }, { ozon_sku: "1", amount: 10, currency: "RUB" }]
  ]) {
    const siblings = [{ ...sibling("123-1", 1, 1000), fx_prices_json: JSON.stringify(frozen) }, sibling("123-2", 2, 3000)];
    const result = await readOrderFxFinanceRows({ query: fixture(source, siblings).query, order, rateRubPerCny: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "FX_FINANCE_PARENT_WEIGHT_UNKNOWN");
  }
});

test("rejects duplicate sibling source joins, conflicting accruals and rows from another shop", async () => {
  const source = [financeRow({ posting_number: "123" })];
  const repeated = sibling("123-1", 1, 1000);
  const duplicate = await readOrderFxFinanceRows({ query: fixture(source, [repeated, repeated]).query, order, rateRubPerCny: 10 });
  assert.equal(duplicate.code, "FX_FINANCE_PARENT_WEIGHT_DUPLICATE");
  const conflict = await readOrderFxFinanceRows({ query: fixture([financeRow(), financeRow({ id: 2, service_type: "delivery", accruals_for_sale: 900 })]).query, order, rateRubPerCny: 10 });
  assert.equal(conflict.code, "FX_FINANCE_ACCRUAL_CONFLICT");
  await assert.rejects(readOrderFxFinanceRows({ query: fixture([financeRow({ shop_id: 10 })]).query, order, rateRubPerCny: 10 }), /outside.*scope/);
  assert.throws(() => convertFxFinanceRows([financeRow({ shop_id: 10 })], { shopId: 9, rateRubPerCny: 10 }), /authorized shop/);
});

test("validates rates and scope before making database calls", async () => {
  let calls = 0;
  const query = () => { calls += 1; return []; };
  await assert.rejects(readOrderFxFinanceRows({ query, order: { ...order, shop_id: 0 }, rateRubPerCny: 10 }), /shop_id/);
  await assert.rejects(readOrderFxFinanceRows({ query, order, rateRubPerCny: 0 }), /positive/);
  assert.equal(calls, 0);
});

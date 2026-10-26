import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOzonAccrualTypes, normalizeOzonFinanceAccrual, normalizeOzonFinanceAccrualPage, OZON_DAILY_ACCRUAL_ENDPOINT } from "../src/services/ozon-finance-accruals.js";
import { readOrderFxFinanceRows } from "../src/services/order-profit-fx-finance.js";

const money = (amount, currency = "RUB") => ({ amount: String(amount), currency });
const types = { accrual_types: [
  { id: 1, name: "Acquiring", description: "Acquiring fee" },
  { id: 67, name: "RfbsGlobalDelivery", description: "International delivery" },
  { id: 122, name: "RfbsGlobalIntermediaryService", description: "Intermediary delivery contract" },
  { id: 123, name: "RfbsGlobalPlatformConnectionService", description: "Logistics platform connection" },
  { id: 200, name: "BrandCommission", description: "Brand promotion" }
] };
const sale = (overrides = {}) => ({ accrual_id: 1000001, date: "2026-10-23", unit_number: "12345678-0042-1", accrued_category: "POSTING",
  total_amount: money("266.64"), posting: { delivery_schema: "FBS", products: [{ sku: 12345, quantity: 1, commission: {
    seller_price: money("303"), sale_price: money("299"), sale_commission: money("-36.36"), commission: money("-36.36"),
    sale_amount: money("303"), coinvestment: money("2.99"), bonus: money("1.01")
  } }] }, item_fees: null, non_item_fee: null, container_fees: null, ...overrides });
const fee = (overrides = {}) => ({ accrual_id: 1000002, date: "2026-10-23", unit_number: "12345678-0042", accrued_category: "ITEM",
  total_amount: money("-21.53"), posting: null, item_fees: { fees: [{ sku: 12345, quantity: 1, fees: [{ type_id: 1, accrued: money("-21.53") }] }] },
  non_item_fee: null, container_fees: null, ...overrides });
const parse = raw => normalizeOzonFinanceAccrual(raw, { types });
const totalRows = operation => Math.round(operation.rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;

test("posting gross plus one commission equals official net; buyer price and funding references are not counted again", () => {
  const original = sale(), before = JSON.stringify(original), operation = parse(original);
  assert.equal(operation.operation_id, "accrual_by_day:1000001");
  assert.equal(operation.operation_date, "2026-10-23");
  assert.equal(operation.amount, 266.64);
  assert.equal(operation.accruals_for_sale, 303);
  assert.equal(operation.sale_commission, -36.36);
  assert.equal(operation.reconciliation.ok, true);
  assert.equal(operation.reconciliation.residual, 0);
  assert.equal(totalRows(operation), 266.64);
  assert.equal(operation.rows.filter(row => row.normalized_category === "commission").length, 1);
  assert.equal(operation.rows.filter(row => row.accruals_for_sale !== 0).length, 1);
  assert.equal(operation.rows[0].amount, 303);
  assert.equal(operation.rows[0].normalized_category, "income");
  assert.equal(operation.monetary_references.length, 5);
  assert.deepEqual(operation.rows.find(row => row.normalized_category === "commission").source_paths, ["posting.products[0].commission.commission"]);
  assert.deepEqual(operation.monetary_references.find(row => row.path.endsWith(".sale_commission")).monetary, money("-36.36"));
  assert.equal(JSON.stringify(original), before);
  const envelope = JSON.parse(operation.raw_json);
  assert.deepEqual(envelope.raw, original);
  assert.equal(envelope._source_endpoint, OZON_DAILY_ACCRUAL_ENDPOINT);
});

test("sale_amount already represents the source total and is never multiplied by quantity again", () => {
  const raw = sale({ total_amount: money("533.28") });
  raw.posting.products[0].quantity = 2;
  raw.posting.products[0].commission.sale_amount = money("606");
  raw.posting.products[0].commission.sale_commission = money("-72.72");
  raw.posting.products[0].commission.commission = money("-72.72");
  const result = parse(raw);
  assert.equal(result.reconciliation.ok, true);
  assert.equal(result.accruals_for_sale, 606);
  assert.equal(totalRows(result), 533.28);
});

test("ITEM acquiring retains parent order unit and explicit SKU for later authorized allocation", () => {
  const operation = parse(fee());
  assert.equal(operation.posting_number, "12345678-0042");
  assert.equal(operation.unit_scope, "parent_order");
  assert.equal(operation.unallocated_unit_number, "12345678-0042");
  assert.equal(operation.order_number, "12345678-0042");
  assert.equal(operation.reconciliation.ok, true);
  assert.equal(operation.rows[0].normalized_category, "collecting_fee");
  assert.equal(operation.rows[0].source_type_id, "1");
  assert.equal(operation.rows[0].service_name, "Acquiring");
  assert.deepEqual(operation.items, [{ sku: "12345", quantity: 1 }]);
});

test("NON_ITEM delivery kinds use the fetched dictionary name, not numeric guesses", () => {
  for (const id of [67, 122, 123]) {
    const operation = parse(fee({ accrued_category: "NON_ITEM", unit_number: "12345678-0042-1", total_amount: money("-15"), item_fees: null,
      non_item_fee: { type_id: id, accrued: money("-15") } }));
    assert.equal(operation.reconciliation.ok, true);
    assert.equal(operation.rows[0].normalized_category, "international_transport");
    assert.equal(operation.unit_scope, "posting");
  }
  const renamed = normalizeOzonFinanceAccrual(fee(), { types: [{ id: 1, name: "BrandCommission", description: "Brand promotion" }] });
  assert.equal(renamed.rows[0].normalized_category, "other");
  assert.match(renamed.rows[0].service_type, /^accrual:other:/);
});

test("stable row identities survive response ordering and amount corrections and aggregate repeated semantic fees", () => {
  const raw = fee({ total_amount: money("-6"), item_fees: { fees: [{ sku: 12345, quantity: 1, fees: [
    { type_id: 1, accrued: money("-1") }, { type_id: 67, accrued: money("-3") }, { type_id: 1, accrued: money("-2") }
  ] }] } });
  const first = parse(raw);
  raw.item_fees.fees[0].fees.reverse();
  const reversed = parse(raw);
  assert.deepEqual(first.rows.map(row => row.service_type), reversed.rows.map(row => row.service_type));
  assert.equal(first.rows.length, 2);
  assert.equal(first.rows.find(row => row.normalized_category === "collecting_fee").amount, -3);
  raw.item_fees.fees[0].fees[0].accrued = money("-4");
  raw.total_amount = money("-8");
  const changed = parse(raw);
  assert.deepEqual(first.rows.map(row => row.service_type), changed.rows.map(row => row.service_type));
  assert.equal(changed.reconciliation.ok, true);
});

test("unknown type, residual and unfamiliar money preserve all raw facts and block finalization", () => {
  const unknown = parse(fee({ item_fees: null, non_item_fee: { type_id: 999, accrued: money("-21.53") } }));
  assert.equal(unknown.reconciliation.ok, false);
  assert.ok(unknown.reconciliation.issues.some(issue => issue.code === "FEE_TYPE_UNKNOWN"));
  assert.equal(unknown.rows[0].amount, -21.53);
  const residual = parse(sale({ total_amount: money("270") }));
  assert.equal(residual.reconciliation.ok, false);
  assert.equal(residual.reconciliation.residual, 3.36);
  assert.equal(totalRows(residual), 270);
  assert.equal(residual.rows.at(-1).requires_review, true);
  const unfamiliar = parse({ ...sale(), additional_future_amount: money("1.23") });
  assert.equal(unfamiliar.reconciliation.ok, false);
  assert.equal(unfamiliar.unrecognized_money[0].path, "additional_future_amount");
  assert.deepEqual(JSON.parse(unfamiliar.raw_json).raw.additional_future_amount, money("1.23"));
});

test("de-identified official differing commission samples reconcile using commission exactly once", () => {
  const samples = [
    ["115.14", "-13.94", "-13.8", "101.2"],
    ["414.96", "-59.44", "-48.48", "355.52"],
    ["203.01", "-24.37", "-24.36", "178.64"],
    ["1095.12", "-144.6", "-117.48", "950.52"],
    ["1104", "-158.82", "-116.82", "945.18"]
  ];
  for (const [gross, commission, reference, net] of samples) {
    const raw = sale({ total_amount: money(net) });
    raw.posting.products[0].commission = { sale_amount: money(gross), commission: money(commission), sale_commission: money(reference) };
    const operation = parse(raw);
    assert.equal(operation.reconciliation.ok, true);
    assert.equal(operation.reconciliation.residual, 0);
    assert.equal(totalRows(operation), Number(net));
    const fees = operation.rows.filter(row => row.normalized_category === "commission");
    assert.equal(fees.length, 1);
    assert.equal(fees[0].amount, Number(commission));
    assert.deepEqual(fees[0].source_paths, ["posting.products[0].commission.commission"]);
    assert.deepEqual(operation.monetary_references.find(row => row.path.endsWith(".sale_commission")).monetary, money(reference));
    assert.deepEqual(JSON.parse(operation.raw_json).raw, raw);
  }
});

test("sale_commission is used only when commission is absent or null, never when explicit zero", () => {
  for (const missing of [undefined, null]) {
    const raw = sale();
    if (missing === undefined) delete raw.posting.products[0].commission.commission;
    else raw.posting.products[0].commission.commission = null;
    const operation = parse(raw);
    assert.equal(operation.reconciliation.ok, true);
    assert.equal(operation.sale_commission, -36.36);
    assert.deepEqual(operation.rows.find(row => row.normalized_category === "commission").source_paths, ["posting.products[0].commission.sale_commission"]);
  }
  const zero = sale({ total_amount: money("303") });
  zero.posting.products[0].commission.commission = money("0");
  assert.equal(parse(zero).reconciliation.ok, true);
  assert.equal(parse(zero).sale_commission, 0);
});

test("a net mismatch never switches to sale_commission or becomes finalized through a residual", () => {
  const raw = sale();
  raw.posting.products[0].commission.commission = money("-40");
  const operation = parse(raw);
  assert.equal(operation.sale_commission, -40);
  assert.equal(operation.reconciliation.ok, false);
  assert.equal(operation.reconciliation.residual, 3.64);
  assert.ok(operation.reconciliation.issues.some(issue => issue.code === "NET_COMPONENTS_UNRECONCILED"));
  assert.equal(totalRows(operation), 266.64);
  assert.equal(operation.rows.at(-1).requires_review, true);
});

test("invalid or conflicting money in either commission candidate stays pending despite a matching selected net", () => {
  for (const field of ["commission", "sale_commission"]) {
    for (const invalid of [money("-36.36", "CNY"), { amount: "-36.36" }, money("invalid")]) {
      const raw = sale();
      raw.posting.products[0].commission[field] = invalid;
      const operation = parse(raw);
      assert.equal(operation.reconciliation.ok, false);
      assert.ok(operation.reconciliation.issues.some(issue => ["COMPONENT_CURRENCY_CONFLICT", "COMPONENT_MONEY_INVALID"].includes(issue.code)));
      assert.deepEqual(JSON.parse(operation.raw_json).raw.posting.products[0].commission[field], invalid);
    }
  }
});

test("mixed currencies stay explicit and never receive an implicit conversion or legacy RUB default", () => {
  const raw = fee({ item_fees: null, non_item_fee: { type_id: 1, accrued: money("-2", "CNY") } });
  const operation = parse(raw);
  assert.equal(operation.reconciliation.ok, false);
  assert.equal(operation.currency_code, "RUB");
  assert.equal(operation.rows.find(row => row.source_type_id === "1").currency_code, "CNY");
  assert.equal(operation.rows.find(row => row.source_type_id === "1").amount, -2);
  assert.ok(operation.reconciliation.issues.some(issue => issue.code === "COMPONENT_CURRENCY_CONFLICT"));
  const missing = parse(fee({ total_amount: { amount: "-21.53" } }));
  assert.equal(missing.currency_code, "");
  assert.equal(missing.amount, null);
  assert.equal(missing.reconciliation.ok, false);
});

test("positive adjustments with no established income category remain pending even when their net balances", () => {
  const operation = parse(fee({ total_amount: money("5"), item_fees: null, non_item_fee: { type_id: 200, accrued: money("5") } }));
  assert.equal(operation.amount, 5);
  assert.equal(totalRows(operation), 5);
  assert.equal(operation.reconciliation.residual, 0);
  assert.equal(operation.reconciliation.ok, false);
  assert.ok(operation.reconciliation.issues.some(issue => issue.code === "POSITIVE_ADJUSTMENT_UNCLASSIFIED"));
});

test("unknown container unit remains unallocated and raw container fees remain auditable", () => {
  const raw = fee({ accrued_category: "CONTAINER", unit_number: "container-unknown", item_fees: null,
    container_fees: { fees: [{ type_id: 67, accrued: money("-21.53") }] } });
  const operation = parse(raw);
  assert.equal(operation.posting_number, "");
  assert.equal(operation.unallocated_unit_number, "container-unknown");
  assert.equal(operation.rows[0].amount, -21.53);
  assert.equal(operation.reconciliation.ok, true);
});

test("dictionary validation, lossless IDs, date validation and explicit cursor prevent silent partial loads", () => {
  assert.throws(() => normalizeOzonAccrualTypes([{ id: 1, name: "Acquiring" }, { id: 1, name: "Logistic" }]), { code: "OZON_ACCRUAL_TYPES_CONFLICT" });
  assert.throws(() => parse(sale({ accrual_id: Number.MAX_SAFE_INTEGER + 1 })), { code: "OZON_ACCRUAL_ID_INVALID" });
  assert.equal(parse(sale({ accrual_id: "9007199254740993" })).operation_id, "accrual_by_day:9007199254740993");
  assert.throws(() => parse(sale({ date: "2026-02-31" })), { code: "OZON_ACCRUAL_DATE_INVALID" });
  assert.throws(() => normalizeOzonFinanceAccrualPage({ accruals: [sale()] }, { types }), { code: "OZON_ACCRUAL_PAGE_INVALID" });
  const page = normalizeOzonFinanceAccrualPage({ accruals: [sale(), fee()], last_id: "" }, { types });
  assert.equal(page.has_more, false);
  assert.equal(page.operations.length, 2);
  assert.equal(normalizeOzonFinanceAccrualPage({ accruals: [], last_id: "next" }, { types }).has_more, true);
});

test("V2 finance reader accepts gross-once daily rows and rejects unreconciled raw snapshots", async () => {
  const operation = parse(sale());
  const persisted = operation.rows.map((row, index) => ({ ...row, id: index + 1, shop_id: 9, operation_id: operation.operation_id,
    posting_number: operation.posting_number, raw_json: operation.raw_json }));
  const read = rows => readOrderFxFinanceRows({ query: async () => rows, order: { shop_id: 9, posting_number: "12345678-0042-1", order_number: "12345678-0042" }, rateRubPerCny: 10 });
  const result = await read(persisted);
  assert.equal(result.ok, true);
  assert.equal(result.sale_accrual_cny, 30.3);
  assert.equal(result.rows.reduce((sum, row) => sum + row.accruals_for_sale_cny, 0), 30.3);
  const unresolved = parse(sale({ total_amount: money("270") }));
  const blocked = await read(persisted.map(row => ({ ...row, raw_json: unresolved.raw_json })));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "FX_FINANCE_NORMALIZATION_PENDING");
  const duplicate = await read([...persisted, { ...persisted[0], id: 99 }]);
  assert.equal(duplicate.code, "FX_FINANCE_ACCRUAL_CONFLICT");
});

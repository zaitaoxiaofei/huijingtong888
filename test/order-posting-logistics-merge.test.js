import assert from "node:assert/strict";
import test from "node:test";

test("repeated generic FBP markers remain missing methods and cannot replace a verified name", () => {
  const incoming = sparse();
  incoming.raw.delivery_method.name = "FBP FBP";
  assert.equal(hasMeaningfulPostingMethod(incoming), false);
  assert.equal(mergeOrderPostingLogistics(rich(), incoming).raw.delivery_method.name, rich().raw.delivery_method.name);
});
import { hasMeaningfulPostingMethod, isFbpPosting, mergeOrderPostingLogistics } from "../src/services/order-posting-logistics-merge.js";

const rich = () => ({
  posting_number: "fixture-1", status: "delivering", substatus: "moving", tracking_stage: "moving", logistics_status: "delivering",
  tracking_number: "OLD-TRACKING", external_tracking_url: "https://tracking.example.test/old",
  items: [{ ozon_sku: "old", quantity: 1 }],
  raw: {
    posting_number: "fixture-1", status: "delivering", substatus: "moving",
    delivery_method: { id: 72, name: "CEL FBP Standard Extra Small", warehouse: "CEL Hunchun 2", warehouse_id: 8, tpl_provider: "CEL", tpl_provider_id: 1108, obsolete: "do not inherit" },
    analytics_data: { warehouse: "CEL Hunchun 2", tpl_provider: "CEL", city: "old city", delivery_date_begin: "old date" },
    tracking_number: "OLD-TRACKING", external_tracking_url: "https://tracking.example.test/old",
    financial_data: { amount: 100 }, products: [{ sku: "old", quantity: 1 }], customer: { name: "old customer" }
  }
});
const sparse = () => ({
  posting_number: "fixture-1", fulfillment_schema: "FBP", status: "cancelled", substatus: "", tracking_stage: "cancelled", logistics_status: "cancelled",
  tracking_number: "", external_tracking_url: "", items: [{ ozon_sku: "new", quantity: 2 }],
  raw: {
    posting_number: "fixture-1", fulfillment_schema: "FBP", status: "cancelled", substatus: "",
    delivery_method: { name: "FBP", tpl_provider_id: 1108 },
    financial_data: { amount: 0 }, products: [{ sku: "new", quantity: 2 }], cancellation: { reason: "new cancellation" }
  }
});

test("same-batch FBS detail then sparse FBP retains real logistics and latest business facts", () => {
  const previous = rich();
  const incoming = sparse();
  const previousJson = JSON.stringify(previous);
  const incomingJson = JSON.stringify(incoming);
  const merged = mergeOrderPostingLogistics(previous, incoming);
  assert.equal(merged.fulfillment_schema, "FBP");
  assert.equal(merged.raw.fulfillment_schema, "FBP");
  assert.equal(merged.raw.delivery_method.name, "CEL FBP Standard Extra Small");
  assert.equal(merged.raw.delivery_method.warehouse, "CEL Hunchun 2");
  assert.equal(merged.raw.delivery_method.tpl_provider_id, 1108);
  assert.equal(merged.raw.analytics_data.warehouse, "CEL Hunchun 2");
  assert.equal(merged.raw.analytics_data.city, undefined);
  assert.equal(merged.raw.analytics_data.delivery_date_begin, undefined);
  assert.equal(merged.raw.delivery_method.obsolete, undefined);
  assert.equal(merged.raw.customer, undefined);
  assert.equal(merged.status, "cancelled");
  assert.equal(merged.substatus, "");
  assert.equal(merged.tracking_stage, "cancelled");
  assert.equal(merged.logistics_status, "cancelled");
  assert.equal(merged.raw.substatus, "");
  assert.deepEqual(merged.items, incoming.items);
  assert.deepEqual(merged.raw.products, incoming.raw.products);
  assert.deepEqual(merged.raw.financial_data, { amount: 0 });
  assert.deepEqual(merged.raw.cancellation, incoming.raw.cancellation);
  assert.equal(merged.tracking_number, "OLD-TRACKING");
  assert.equal(merged.raw.tracking_number, "OLD-TRACKING");
  assert.equal(merged.external_tracking_url, "https://tracking.example.test/old");
  assert.equal(JSON.stringify(previous), previousJson);
  assert.equal(JSON.stringify(incoming), incomingJson);
});

test("persisted normalized snapshots use the same merge without regressing new rich detail", () => {
  const persisted = JSON.parse(JSON.stringify(mergeOrderPostingLogistics(rich(), sparse())));
  const incoming = rich();
  incoming.raw.delivery_method.name = "CEL FBP Standard Small";
  incoming.tracking_number = "NEW-TRACKING";
  incoming.raw.tracking_number = "NEW-TRACKING";
  const merged = mergeOrderPostingLogistics(persisted, incoming);
  assert.equal(merged.raw.delivery_method.name, "CEL FBP Standard Small");
  assert.equal(merged.tracking_number, "NEW-TRACKING");
  assert.equal(merged.raw.tracking_number, "NEW-TRACKING");
  assert.equal(merged.status, "delivering");
  assert.equal(merged.fulfillment_schema, "FBP");
});

test("an explicit provider change never inherits old method, warehouse, provider or tracking", () => {
  for (const providerField of ["tpl_provider_id", "provider_id"]) {
    const incoming = sparse();
    incoming.raw.delivery_method = { name: "FBP", [providerField]: 2209 };
    const merged = mergeOrderPostingLogistics(rich(), incoming);
    assert.deepEqual(merged.raw.delivery_method, incoming.raw.delivery_method);
    assert.equal(merged.raw.analytics_data, undefined);
    assert.equal(merged.tracking_number, "");
    assert.equal(merged.external_tracking_url, "");
    assert.equal(merged.raw.tracking_number, undefined);
  }
  const incoming = sparse();
  incoming.raw.delivery_method = { name: "GUOO FBP", tpl_provider: "GUOO" };
  const merged = mergeOrderPostingLogistics(rich(), incoming);
  assert.equal(merged.raw.delivery_method.warehouse, undefined);
  assert.equal(merged.raw.delivery_method.tpl_provider_id, undefined);
  assert.equal(merged.tracking_number, "");
});

test("an explicit method or warehouse change does not attach stale logistics metadata", () => {
  for (const [field, value] of [["id", 99], ["warehouse_id", 99]]) {
    const incoming = sparse();
    incoming.raw.delivery_method[field] = value;
    const merged = mergeOrderPostingLogistics(rich(), incoming);
    assert.equal(merged.raw.delivery_method.name, "FBP");
    assert.equal(merged.raw.delivery_method.warehouse, undefined);
    assert.equal(merged.tracking_number, "");
  }
  const sameMethod = sparse();
  sameMethod.raw.delivery_method.id = 72;
  const merged = mergeOrderPostingLogistics(rich(), sameMethod);
  assert.equal(merged.raw.delivery_method.id, 72);
  assert.equal(merged.raw.delivery_method.name, "CEL FBP Standard Extra Small");
  assert.equal(merged.raw.delivery_method.warehouse, "CEL Hunchun 2");
  const differentCarrier = sparse();
  differentCarrier.raw.delivery_method = { name: "GUOO FBP Standard Extra Small" };
  assert.equal(mergeOrderPostingLogistics(rich(), differentCarrier).raw.delivery_method.tpl_provider, undefined);
});

test("only explicit FBP snapshots activate preservation, while ordinary FBS remains unchanged", () => {
  const previous = rich();
  previous.raw.delivery_method.name = "CEL Standard Extra Small";
  const incoming = { status: "delivering", tracking_number: "", raw: { delivery_method: { name: "CEL Economy Small" } } };
  assert.equal(isFbpPosting(previous), false);
  assert.equal(isFbpPosting(incoming), false);
  assert.equal(mergeOrderPostingLogistics(previous, incoming), incoming);
  assert.equal(hasMeaningfulPostingMethod({ raw: { delivery_method: { name: " FBP " } } }), false);
  assert.equal(hasMeaningfulPostingMethod({ raw: { delivery_method: { name: "CEL FBP Standard Extra Small" } } }), true);
  assert.equal(hasMeaningfulPostingMethod({ fulfillment_schema: "FBP", raw: {} }), false);
});

test("sparse-first and missing provider identity do not fabricate logistics", () => {
  const merged = mergeOrderPostingLogistics({}, sparse());
  assert.equal(merged.raw.delivery_method.name, "FBP");
  assert.equal(merged.raw.delivery_method.tpl_provider, undefined);
  assert.equal(merged.raw.delivery_method.warehouse, undefined);
  assert.equal(merged.tracking_number, "");
  const previous = rich();
  previous.raw.warehouse_name = "CEL FBP warehouse";
  previous.raw.tpl_provider = "CEL";
  const inherited = mergeOrderPostingLogistics(previous, sparse());
  assert.equal(inherited.raw.warehouse_name, "CEL FBP warehouse");
  assert.equal(inherited.raw.tpl_provider, "CEL");
});

test("incoming raw tracking is used by normalized order updates without inheriting old status", () => {
  const incoming = sparse();
  incoming.raw.tracking_number = "RAW-NEW";
  const merged = mergeOrderPostingLogistics(rich(), incoming);
  assert.equal(merged.tracking_number, "RAW-NEW");
  assert.equal(merged.raw.tracking_number, "RAW-NEW");
  assert.equal(merged.tracking_stage, "cancelled");
});

test("only sparse FBP list omissions inherit tracking, while explicit clearing and rich snapshots remain authoritative", () => {
  for (const clear of ["", null]) {
    const incoming = sparse();
    incoming.raw.tracking_number = clear;
    incoming.raw.external_tracking_url = clear;
    const merged = mergeOrderPostingLogistics(rich(), incoming);
    assert.equal(merged.tracking_number, "");
    assert.equal(merged.external_tracking_url, "");
    assert.equal(merged.raw.tracking_number, clear);
    assert.equal(merged.raw.external_tracking_url, clear);
  }
  const incoming = rich();
  incoming.tracking_number = "";
  incoming.external_tracking_url = "";
  delete incoming.raw.tracking_number;
  delete incoming.raw.external_tracking_url;
  const merged = mergeOrderPostingLogistics(rich(), incoming);
  assert.equal(merged.tracking_number, "");
  assert.equal(merged.external_tracking_url, "");
  assert.equal(merged.raw.tracking_number, undefined);
  assert.equal(merged.raw.external_tracking_url, undefined);
});

test("provider identity comparison works across normalized raw logistics locations", () => {
  const incoming = sparse();
  incoming.raw.delivery_method = { name: "FBP" };
  incoming.raw.analytics_data = { provider_id: "2209" };
  const merged = mergeOrderPostingLogistics(rich(), incoming);
  assert.equal(merged.raw.delivery_method.warehouse, undefined);
  assert.equal(merged.raw.analytics_data.tpl_provider, undefined);
  assert.equal(merged.tracking_number, "");
});

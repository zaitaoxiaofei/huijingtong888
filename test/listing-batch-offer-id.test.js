import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const functions = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
  .map(node => source.slice(node.start, node.end)).join("\n");
const clone = value => JSON.parse(JSON.stringify(value));
function service(stored = null) {
  const lookups = [];
  const context = vm.createContext({ URL, Buffer, crypto, console, LOCAL_DICTIONARY_DISPLAY_ZH: new Map(),
    PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish",
    config: { listingMediaPublicBaseUrl: "https://erp.example" } });
  vm.runInContext(functions, context);
  Object.assign(context, {
    estimateListingQualityFromPayload: () => ({ score: 100, issues: [] }),
    row: async (sql, params) => { lookups.push({ sql, params }); return stored; },
    preloadListingOfferIdConflicts: async () => new Set(),
    findListingOfferIdConflict: async () => null,
    listingOfferProductToken: async () => "AV-FIXTURE"
  });
  return { context, lookups };
}
const template = () => ({ title: "Fixture", ozon_category_id: "100:200", editable_payload: {
  description_category_id: 100, type_id: 200, price: { value: 10, currency_code: "CNY" },
  dimensions: { length_cm: 10, width_cm: 10, height_cm: 10, weight_g: 100 },
  variants: [{ offer_id: "EXISTING-A", images: ["https://source.example/a.jpg"] },
    { images: ["https://source.example/b.jpg"] }, { offerId: "EXISTING-C", images: ["https://source.example/c.jpg"] }]
} });

test("only the internal batch option generates missing real shop IDs while preserving supplied IDs", async () => {
  const { context } = service(), body = template();
  const before = JSON.stringify(body);
  const normal = await context.validateListingTemplatePublish(body);
  assert.ok(normal.errors.some(message => message.includes("1 个变体缺少 offer_id")));
  // A client-supplied body flag cannot activate the internal batch capability.
  const forged = await context.validateListingTemplatePublish({ ...body, generateMissingOfferIds: true });
  assert.ok(forged.errors.some(message => message.includes("缺少 offer_id")));
  const validation = await context.validateListingTemplatePublish(body, null, { generateMissingOfferIds: true });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.deepEqual(clone(validation.payload.items.map(item => item.offer_id)), ["EXISTING-A", "", "EXISTING-C"]);
  const prepared = await context.prepareSafeShopOfferIds(validation.payload, { shop: { id: 20 } });
  const ids = clone(prepared.items.map(item => item.offer_id));
  assert.equal(ids[0], "EXISTING-A");
  assert.match(ids[1], /^AV-FIXTURE-S20-V02-[A-F0-9]{6}$/);
  assert.equal(ids[2], "EXISTING-C");
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id && !id.startsWith("NEW-OFFER")));
  assert.equal(JSON.stringify(body), before);
});

test("all missing IDs get distinct shop-scoped real IDs without changing the draft", async () => {
  const { context } = service(), body = template();
  body.editable_payload.variants = body.editable_payload.variants.map(({ images }) => ({ images }));
  const validation = await context.validateListingTemplatePublish(body, null, { generateMissingOfferIds: true });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const a = await context.prepareSafeShopOfferIds(validation.payload, { shop: { id: 20 } });
  const b = await context.prepareSafeShopOfferIds(validation.payload, { shop: { id: 30 } });
  const ids = [...a.items, ...b.items].map(item => item.offer_id);
  assert.equal(new Set(ids).size, 6);
  assert.ok(a.items.every(item => item.offer_id.includes("-S20-")));
  assert.ok(b.items.every(item => item.offer_id.includes("-S30-")));
  assert.ok(body.editable_payload.variants.every(item => !Object.hasOwn(item, "offer_id")));
});

test("retrying an existing multi-SKU record preserves every SKU, including reordered variants", async () => {
  const stored = { offer_id: "EXISTING-A", request_json: JSON.stringify({ items: [{ offer_id: "EXISTING-A" }, { offer_id: "EXISTING-B" }] }) };
  const { context, lookups } = service(stored);
  const input = { items: [{ offer_id: "EXISTING-B", name: "B" }, { offer_id: "EXISTING-A", name: "A" }] };
  const output = await context.prepareSafeShopOfferIds(input, { shop: { id: 20 }, sourceRecordId: 17, updateExisting: true });
  assert.deepEqual(clone(output), input);
  assert.deepEqual(clone(lookups[0].params), [17, 20]);
  for (const invalid of [{ items: [{ offer_id: "EXISTING-A" }] },
    { items: [{ offer_id: "EXISTING-A" }, { offer_id: "EXISTING-A" }] },
    { items: [{ offer_id: "EXISTING-A" }, { offer_id: "NEW-B" }] }]) {
    await assert.rejects(context.prepareSafeShopOfferIds(invalid, { shop: { id: 20 }, sourceRecordId: 17, updateExisting: true }), { code: "LISTING_UPDATE_SKU_IDENTITY_CHANGED", status: 409 });
  }
});

test("single-SKU retry keeps its original ID and refuses a foreign shop record", async () => {
  const { context } = service({ offer_id: "ORIGINAL-A", request_json: "{}" });
  const result = await context.prepareSafeShopOfferIds({ items: [{ offer_id: "EDITED-A" }] }, { shop: { id: 20 }, sourceRecordId: 17, updateExisting: true });
  assert.equal(result.items[0].offer_id, "ORIGINAL-A");
  const foreign = service();
  await assert.rejects(foreign.context.prepareSafeShopOfferIds({ items: [{ offer_id: "EDITED-A" }] }, { shop: { id: 30 }, sourceRecordId: 17, updateExisting: true }), { status: 404 });
});

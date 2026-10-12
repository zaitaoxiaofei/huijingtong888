import test from "node:test";
import assert from "node:assert/strict";
import { ensurePersistedDraftVariantIds, publishedItemVariantIds } from "../src/services/listing-variant-identity.js";

test("draft variant IDs remain stable when rows are reordered", () => {
  const template = { editable_payload: { variants: [{ id: "blue" }, { id: "red" }] } };
  const facts = { variants: [{ id: "blue" }, { id: "red" }] };
  assert.deepEqual(ensurePersistedDraftVariantIds(template, facts, 42), ["blue", "red"]);
  template.editable_payload.variants.reverse();
  facts.variants.reverse();
  assert.deepEqual(ensurePersistedDraftVariantIds(template, facts, 42), ["red", "blue"]);
});

test("legacy draft variants receive distinct persisted IDs", () => {
  const template = { editable_payload: { variants: [{}, {}] } };
  const facts = { variants: [{}, {}] };
  const ids = ensurePersistedDraftVariantIds(template, facts, 42);
  assert.deepEqual(ids, ["draft-42-variant-1", "draft-42-variant-2"]);
  assert.deepEqual(facts.variants.map((item) => item.id), ids);
  assert.deepEqual(template.editable_payload.variants.map((item) => item.id), ids);
  assert.deepEqual(ensurePersistedDraftVariantIds(template, facts, 42), ids);
});

test("duplicate variant IDs cannot merge different rows", () => {
  const facts = { variants: [{ id: "same" }, { id: "same" }] };
  const ids = ensurePersistedDraftVariantIds({}, facts, 19);
  assert.deepEqual(ids, ["same", "draft-19-variant-2"]);
});

test("historical records only match variants through unique offer identifiers", () => {
  const variants = [{ id: "blue", offer_id: "offer-blue" }, { id: "red", offer_id: "offer-red" }];
  assert.deepEqual(publishedItemVariantIds([{ offer_id: "offer-red" }, { offer_id: "offer-blue" }], variants, true), ["red", "blue"]);
  assert.deepEqual(publishedItemVariantIds([{ offer_id: "renamed-offer" }], variants, true), []);
});

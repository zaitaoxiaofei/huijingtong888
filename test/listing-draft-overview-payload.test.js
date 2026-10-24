import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeImportCandidate } from "../frontend/admin/utils/ai-product-import.js";

const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const helper = service.match(/function normalizeDraftOverviewResponse\(row\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(helper);
const overviewResponse = new Function(`${helper}\nreturn normalizeDraftOverviewResponse;`)();

test("draft overview removes duplicate storage representations without changing import media, explicit emptiness or input", () => {
  const images = Array.from({ length: 8 }, (_, index) => `https://example.invalid/current/${index}.jpg?signature=${"x".repeat(500)}`);
  const template = { editable_payload: { variants: [{ images, images_manually_edited: true }] } };
  const row = {
    id: 201, template_id: 2, product_name: "Current title", internal_code: "SKU-201",
    source_urls_json: "[]", source_urls: [],
    source_images_json: JSON.stringify(["https://example.invalid/collected.jpg"]),
    source_images: ["https://example.invalid/collected.jpg"],
    template_payload_json: template, template_payload: template,
    manual_facts_json: "{}", manual_facts: {}, ai_payload_json: "{}", ai_payload: {},
    shop_copies_json: [{ shop_id: 2, shop_name: "Shop 2" }],
    shop_copies: [{ shop_id: 2, shop_name: "Shop 2" }],
    effective_images: images, effective_image_source: "draft_variant", publish_record_count: 80,
    published_skus: [{ ozon_sku: "same-sku", shop_id: 2 }]
  };
  const original = structuredClone(row);
  const compact = overviewResponse(row);
  const fromLegacy = normalizeImportCandidate(row, "draft");
  const fromCompact = normalizeImportCandidate(compact, "draft");
  for (const field of ["sourceDraftId", "sourceSku", "title", "imageUrl", "detailImages", "templatePayload", "templateId"]) {
    assert.deepEqual(fromCompact[field], fromLegacy[field], field);
  }
  assert.deepEqual(compact.effective_images, images);
  assert.deepEqual(compact.shop_copies, row.shop_copies);
  assert.deepEqual(compact.published_skus, row.published_skus);
  assert.equal(compact.publish_record_count, 80);
  assert.deepEqual(row, original);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(row)) - 4000);

  const empty = overviewResponse({ ...row, effective_images: [], template_payload: { editable_payload: { variants: [{ images: [], image_edit_intent: "manual" }] } } });
  assert.equal(normalizeImportCandidate(empty, "draft").imageUrl, "");
  assert.deepEqual(normalizeImportCandidate(empty, "draft").detailImages, []);
});

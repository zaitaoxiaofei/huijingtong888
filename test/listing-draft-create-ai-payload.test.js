import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const assetVariantSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const mysqlCutoverSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

function assertInsertColumnValueAlignment(sources, table, expectedCount) {
  const joined = sources.join("\n");
  const statements = [...joined.matchAll(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)\\s*VALUES\\s*\\(([^)]+)\\)`, "g"))];
  assert.equal(statements.length, expectedCount, `unexpected ${table} INSERT path count`);
  for (const [, columnsSql, valuesSql] of statements) {
    const columns = columnsSql.split(",").map((item) => item.trim()).filter(Boolean);
    const values = valuesSql.split(",").map((item) => item.trim()).filter(Boolean);
    assert.equal(values.length, columns.length, `${table} INSERT mismatch: ${columns.join(", ")}`);
  }
}

test("create listing draft writes required ai_payload_json", () => {
  assert.match(source, /ai_payload_json,\s*\n\s*created_by_person_id/);
  assert.match(source, /JSON\.stringify\(aiPayload\)/);
  assert.match(source, /ai_payload:\s*objectValue\(body\.ai_payload \|\| body\.aiPayload\)/);
});

test("listing draft inserts keep explicit columns and values aligned", () => {
  const listingDraftWriters = [source, assetVariantSource].join("\n");
  const insertStatements = [...listingDraftWriters.matchAll(/INSERT INTO listing_drafts\b[\s\S]*?VALUES\s*\(([^)]+)\)/g)];
  const inserts = [...listingDraftWriters.matchAll(/INSERT INTO listing_drafts\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/g)];
  assert.equal(insertStatements.length, 4, "all listing_drafts INSERT paths must be covered");
  assert.equal(inserts.length, insertStatements.length, "listing_drafts INSERT must use an explicit column list");
  for (const [, columnsSql, valuesSql] of inserts) {
    const columns = columnsSql.split(",").map((item) => item.trim()).filter(Boolean);
    const values = valuesSql.split(",").map((item) => item.trim()).filter(Boolean);
    assert.equal(values.length, columns.length, `listing_drafts INSERT mismatch: ${columns.join(", ")}`);
  }
});

test("collector and selection inserts keep explicit columns and values aligned", () => {
  assertInsertColumnValueAlignment([source], "ozon_plugin_collected_products", 1);
  assertInsertColumnValueAlignment([mysqlCutoverSource], "products", 1);
});

test("listing draft save fills missing price without overwriting variant price", () => {
  assert.match(source, /function applyDraftSalePriceToTemplatePayload\(templatePayload = \{\}, salePrice = 0\)/);
  assert.match(source, /\? applyDraftSalePriceToTemplatePayload\(payload\.template_payload, payload\.sale_price\)/);
  assert.doesNotMatch(source, /templatePayload = applyDraftSalePriceToTemplatePayload\(cloneJsonValue\(templatePayload, \{\}\), row\.sale_price\)/);
  assert.match(source, /const variantPrice = numberFromOzonValue\(next\.price \|\| next\.price_value \|\| next\.priceValue \|\| 0\);/);
  assert.match(source, /if \(!variantPrice\) \{\s*next\.price = priceValue;\s*next\.price_value = priceValue;\s*next\.priceValue = priceValue;\s*\}/s);
});

test("listing draft lightweight list exposes template prices for overview display", () => {
  const listingDraftsSource = source.match(/export async function listingDrafts\(query = \{\}, session\) \{[\s\S]*?export async function listingDraftDetail/)?.[0] || "";
  assert.match(listingDraftsSource, /AS draft_variant_price/);
  assert.match(listingDraftsSource, /AS draft_template_price/);
  assert.match(listingDraftsSource, /JSON_EXTRACT\(d\.template_payload_json, '\$\.editable_payload\.variants\[0\]\.price'\)/);
  assert.match(listingDraftsSource, /JSON_EXTRACT\(d\.template_payload_json, '\$\.editable_payload\.variants\[0\]\.price_value'\)/);
  assert.match(listingDraftsSource, /JSON_EXTRACT\(d\.template_payload_json, '\$\.editable_payload\.price\.value'\)/);
});

test("AI variant lightweight draft rejects missing video and video cover media", () => {
  assert.match(source, /async function ensureAiVariantDraftVideoMedia/);
  assert.match(source, /source !== "ai_variant_lab"/);
  assert.match(source, /generateListingVariantMediaFromImage/);
  assert.match(source, /video_urls: \[videoUrl\], video_cover_urls: \[videoUrl\]/);
  assert.match(source, /ai_variant_video_generation_failed/);
  assert.match(source, /ensureAiVariantDraftVideoMedia\(body, objectValue/);
});

test("AI variant lightweight draft blocks titles that retain the source vehicle", () => {
  assert.match(source, /function assertAiVariantDraftTitleTarget/);
  assert.match(source, /ai_variant_title_source_model_leak/);
  assert.match(source, /标题仍包含母车型/);
  assert.match(source, /containsExactListingModel/);
});

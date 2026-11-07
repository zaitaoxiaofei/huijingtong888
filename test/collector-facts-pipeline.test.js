import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCollectedProductFacts } from "../src/services/listing-collected-facts.js";
import {
  assignCollectedAttributeIdsFromDefinitions,
  collectedCategoryPairFromIds,
  collectedCategoryCandidates,
  normalizeCollectedDimensions,
  resolveCollectedAttributeDictionarySelections
} from "../src/services/listing-automation.js";

const collectorContentSource = readFileSync(new URL("../ozon-erp-collector-plugin/content.js", import.meta.url), "utf8");
const collectorSource = readFileSync(new URL("../ozon-erp-collector-plugin/collector.js", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("collector facts normalize stable category hints and variant facts before schema mapping", () => {
  const facts = buildCollectedProductFacts({
    detail: {
      sku: "FACT-100",
      title: "Pet toy",
      rawPayload: {
        category: "Pets / Toys",
        category_ids: ["100", "200", "300"],
        attributes: [
          {
            attribute_id: 8229,
            name: "Product type",
            values: [{ dictionary_value_id: 555, value: "toy" }]
          },
          {
            name: "Color",
            value: "Pink"
          }
        ],
        images: ["https://cdn.example.test/pet-main.jpg"]
      }
    },
    body: {
      editPayload: {
        description: "Interactive cat toy",
        rows: [
          {
            sku: "FACT-100-A",
            title: "Pet toy pink",
            images: ["https://cdn.example.test/pet-variant.jpg"]
          }
        ]
      }
    }
  }, {
    collectVariantRows: (_raw, editPayload) => editPayload.rows || []
  });

  assert.equal(facts.base.sku, "FACT-100");
  assert.equal(facts.base.title, "Pet toy");
  assert.equal(facts.categoryHints.category_text, "Pets / Toys");
  assert.deepEqual(facts.categoryHints.category_ids, ["100", "200", "300"]);
  assert.equal(facts.attributes.length, 2);
  assert.equal(facts.variants.length, 1);
  assert.equal(facts.variants[0].sku, "FACT-100-A");
  assert.equal(facts.sourceCoverage.raw_attribute_count, 2);
});

test("collector category candidates prefer facts-derived category ids before weaker raw heuristics", () => {
  const facts = {
    categoryHints: {
      description_category_id: "17001",
      type_id: "97001",
      category_ids: ["10", "17001", "97001"],
      category_text: "Facts path",
      leaf_name: "Facts leaf"
    },
    attributes: [
      {
        attribute_id: 8229,
        values: [{ dictionary_value_id: 7001, value: "pet toy" }]
      }
    ]
  };
  const detail = { category_name: "Raw path" };
  const raw = {
    category: "Raw path",
    category_ids: ["80", "81", "82"],
    attributes: [
      {
        attribute_id: 8229,
        values: [{ dictionary_value_id: 9001, value: "raw type" }]
      }
    ]
  };

  const result = collectedCategoryCandidates(raw, detail, {}, facts);

  assert.equal(result.candidates[0].descriptionCategoryId, 17001);
  assert.equal(result.candidates[0].typeId, 97001);
  assert.equal(result.candidates[0].source, "facts_category_ids_tail");
  assert.equal(result.typeOnlyCandidates[0].typeId, 7001);
  assert.equal(result.typeOnlyCandidates[0].source, "facts_attribute_8229_dictionary_value");
  assert.equal(result.categoryText, "Facts path");
  assert.equal(result.leafName, "Facts leaf");
});

test("collector category pair prefers the ids tail over a conflicting direct field", () => {
  const raw = {
    category_ids: [17027495, 17028755, 971006634],
    description_category_id: 17030014
  };

  assert.deepEqual(collectedCategoryPairFromIds(raw), {
    descriptionCategoryId: 17028755,
    typeId: 971006634
  });
  const result = collectedCategoryCandidates(raw, {}, {}, null);
  assert.equal(result.candidates[0].source, "category_ids_tail");
  assert.equal(result.candidates[0].descriptionCategoryId, 17028755);
  assert.equal(result.candidates[0].typeId, 971006634);
});

test("detail collector saves first and schedules seller fallback backfill asynchronously", () => {
  assert.match(collectorContentSource, /function scheduleSellerFallbackBackfill\(result, options = \{\}\)/);
  assert.match(collectorContentSource, /const backgroundTask = enrichDetailWithSellerFallback\(result\)/);
  assert.match(collectorContentSource, /await persistCollectedResultUpdate\(enriched\);/);
  assert.match(collectorContentSource, /const saved = await ensureCollectedSaved\(result\);[\s\S]*?scheduleSellerFallbackBackfill\(result, \{ persist: true \}\);/);
  assert.doesNotMatch(collectorContentSource, /await enrichDetailWithSellerFallback\(result\);\s*const saved = await ensureCollectedSaved\(result\);/);
  assert.doesNotMatch(collectorContentSource, /await enrichDetailWithSellerFallback\(result\);\s*return buildCollectedProductListPayload\(result\);/);
});

test("collector attribute ids can be deterministically assigned from cached category definitions", () => {
  const attributes = assignCollectedAttributeIdsFromDefinitions([
    { name: "Color", value: "Pink", source: "collector_input" },
    { name: "Unknown Field", value: "Value", source: "collector_input" }
  ], [
    { attribute_id: 10096, name: "Color", dictionary_id: 500, is_collection: true, type: "String" },
    { attribute_id: 8229, name: "Product type", dictionary_id: 600, is_collection: false, type: "String" }
  ]);

  assert.equal(attributes[0].attribute_id, 10096);
  assert.equal(attributes[0].dictionary_id, 500);
  assert.equal(attributes[0].source, "collector_input+schema_id");
  assert.equal(attributes[1].attribute_id, undefined);
});

test("collector attribute dictionary selections can be deterministically resolved from local options", () => {
  const attributes = resolveCollectedAttributeDictionarySelections([
    {
      attribute_id: 10096,
      name: "Color",
      dictionary_id: 500,
      value: "black",
      values: [
        { dictionary_value_id: 61574, value: "black", display_value_zh: "黑色" },
        { dictionary_value_id: 61575, value: "white", display_value_zh: "白色" }
      ]
    }
  ]);

  assert.deepEqual(attributes[0].selected_values, [
    { id: 61574, dictionary_value_id: 61574, value: "black", label: "黑色", display_value_zh: "黑色" }
  ]);
  assert.equal(attributes[0].values[0].dictionary_value_id, 61574);
});

test("collector logistics preserve millimeter dimensions and convert kilogram weights to grams", () => {
  assert.match(collectorSource, /function normalizeSellerWeightMeasurement\(value, unit = ''\)/);
  assert.match(collectorSource, /sourceUnit\.includes\('kg'\) \|\| sourceUnit\.includes\('кг'\)/);
  assert.match(listingSource, /normalizeDimensions: \(\.\.\.sources\) => normalizeCollectedDimensions\(\.\.\.sources\)/);
  assert.match(listingSource, /weightUnit\.includes\("kg"\) \|\| weightUnit\.includes\("кг"\)/);
  assert.deepEqual(normalizeCollectedDimensions({
    real_dimensions: "300x200x100",
    dimension_unit: "mm",
    weight: 3,
    weight_unit: "kg"
  }), {
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
    weight_g: 3000
  });
  assert.equal(normalizeCollectedDimensions({ weight_g: 450 }).weight_g, 450);
});

test("collector category ids remain editable when the local category cache has no matching row", () => {
  assert.match(listingSource, /source: `collector_fallback:\$\{candidate\.source\}`/);
  assert.match(listingSource, /ozon_category_id: `\$\{candidate\.descriptionCategoryId\}:\$\{candidate\.typeId\}`/);
});

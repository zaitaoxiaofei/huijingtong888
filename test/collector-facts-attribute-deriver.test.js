import assert from "node:assert/strict";
import test from "node:test";

import { deriveCollectedAttributesFromFacts } from "../src/services/listing-collected-attribute-deriver.js";
import { normalizeCollectedListingDraft } from "../src/services/listing-collected-normalizer.js";

test("fact-derived collector attributes preserve structured ids and only add fixed attributes from real source values", () => {
  const attributes = deriveCollectedAttributesFromFacts({
    base: {
      sku: "CAT-100",
      brand: "",
      color: "Pink",
      description: "Interactive toy for cats",
      tags: ["cat", "toy"]
    },
    attributes: [
      {
        attribute_id: "8229",
        name: "Product type",
        value: "Interactive toy",
        values: [{ value: "Interactive toy", dictionary_value_id: "6001" }],
        source: "collected_facts.attribute"
      }
    ]
  }, {}, {});

  const byId = new Map(attributes.map((item) => [String(item.attribute_id || item.name), item]));
  assert.equal(byId.has("85"), false);
  assert.equal(byId.has("9048"), false);
  assert.equal(byId.get("4191").value, "Interactive toy for cats");
  assert.equal(byId.get("8229").value, "Interactive toy");
  assert.equal(byId.get("23171").value, "cat,toy");
});

test("collector normalization can build schema input attributes from facts before schema merge", async () => {
  let capturedAttributes = [];
  await normalizeCollectedListingDraft({
    detail: {
      sku: "FACT-COLLECT-1",
      title: "Interactive cat toy",
      rawPayload: {
        category: "Pets / Toys",
        attributes: [
          {
            attribute_id: 8229,
            name: "Product type",
            values: [{ dictionary_value_id: 6001, value: "Interactive toy" }]
          }
        ]
      }
    },
    body: {
      editPayload: {
        color: "Pink",
        description: "Interactive toy for cats",
        tags: ["cat", "toy"]
      }
    }
  }, {
    sourceType: "collector_box",
    buildCollectedFacts: ({ detail, body, raw, editPayload }) => ({
      version: 1,
      base: {
        sku: detail.sku,
        brand: "",
        color: editPayload.color,
        description: editPayload.description,
        tags: editPayload.tags
      },
      media: { images: [] },
      logistics: {},
      categoryHints: { category_text: raw.category },
      attributes: [
        {
          attribute_id: "8229",
          name: "Product type",
          value: "Interactive toy",
          values: [{ value: "Interactive toy", dictionary_value_id: "6001" }],
          source: "collected_facts.attribute"
        }
      ],
      variants: [],
      sourceCoverage: {}
    }),
    buildAttributes: (_editPayload, _raw, facts) => {
      capturedAttributes = deriveCollectedAttributesFromFacts(facts, _raw, _editPayload);
      return capturedAttributes;
    },
    mergeAttributeDefinitions: async (items) => items,
    resolveCategory: async () => null
  });

  const byId = new Map(capturedAttributes.map((item) => [String(item.attribute_id || item.name), item]));
  assert.equal(byId.has("85"), false);
  assert.equal(byId.has("9048"), false);
  assert.equal(byId.get("8229").value, "Interactive toy");
  assert.equal(byId.get("23171").value, "cat,toy");
});

test("collector schema merge does not map name-only attributes into category attributes", async () => {
  const merged = await normalizeCollectedListingDraft({
    detail: {
      sku: "FACT-COLLECT-2",
      title: "Interactive cat toy",
      rawPayload: {
        description_category_id: 17031663,
        type_id: 931382950,
        attributes: [
          {
            name: "Color",
            value: "Pink"
          }
        ]
      }
    },
    body: {}
  }, {
    sourceType: "collector_box",
    buildAttributes: (_editPayload, raw) => raw.attributes || [],
    mergeAttributeDefinitions: async (items) => items,
    resolveCategory: async () => ({
      description_category_id: 17031663,
      type_id: 931382950
    })
  });

  const unknown = merged.diagnostics.attributes.unknown || [];
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, "Color");
});

test("collector category merge upgrades schema-matched text values into local dictionary selections", async () => {
  const merged = await normalizeCollectedListingDraft({
    detail: {
      sku: "FACT-COLLECT-3",
      title: "Interactive cat toy",
      rawPayload: {
        description_category_id: 17031663,
        type_id: 931382950,
        attributes: [
          {
            name: "Color",
            value: "black"
          }
        ]
      }
    },
    body: {}
  }, {
    sourceType: "collector_box",
    buildAttributes: (_editPayload, raw) => raw.attributes || [],
    mergeAttributeDefinitions: async (items) => {
      const [item] = items;
      return [{
        ...item,
        attribute_id: item.attribute_id || 10096,
        name: "Color",
        dictionary_id: 500,
        values: [
          { dictionary_value_id: 61574, value: "black", display_value_zh: "黑色" },
          { dictionary_value_id: 61575, value: "white", display_value_zh: "白色" }
        ],
        selected_values: [
          { dictionary_value_id: 61574, value: "black", display_value_zh: "黑色" }
        ]
      }];
    },
    resolveCategory: async () => ({
      description_category_id: 17031663,
      type_id: 931382950
    })
  });

  const color = (merged.payload.attributes || []).find((item) => Number(item.attribute_id || 0) === 10096);
  assert.ok(color);
  assert.deepEqual(color.selected_values, [
    { dictionary_value_id: 61574, value: "black", display_value_zh: "黑色" }
  ]);
});

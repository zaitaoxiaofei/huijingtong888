import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { repairCollectedVariantColorAxisDeterministic, validateListingTemplatePublish } from "../src/services/listing-automation.js";
import {
  buildTemplateCandidateFromAiVariantResult,
  buildTemplateCandidateFromCollectedSource,
  buildTemplateCandidateFromOnlineProductTemplate
} from "../src/services/listing-publish-normalizer.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/listing/publish-candidates.json", import.meta.url), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allMediaUrls(item) {
  return [
    item.primary_image,
    ...(Array.isArray(item.images) ? item.images : []),
    ...(Array.isArray(item.complex_attributes) ? item.complex_attributes : [])
      .flatMap((group) => Array.isArray(group.attributes) ? group.attributes : [])
      .flatMap((attribute) => Array.isArray(attribute.values) ? attribute.values : [])
      .map((value) => value?.value || value)
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function assertNoLocalMedia(payload) {
  for (const item of payload.items || []) {
    for (const url of allMediaUrls(item)) {
      assert.doesNotMatch(url, /^\/uploads\//, `local upload URL leaked: ${url}`);
      assert.doesNotMatch(url, /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i, `localhost URL leaked: ${url}`);
    }
  }
}

function attributeById(item, id) {
  return (item.attributes || []).find((attribute) => Number(attribute.id || attribute.attribute_id || 0) === Number(id));
}

function compactAttributeValues(values = []) {
  return values.map((value) => ({
    dictionary_value_id: Number(value.dictionary_value_id || 0) || undefined,
    value: String(value.value || "").trim()
  }));
}

function complexAttributeValues(item, id) {
  return (item.complex_attributes || [])
    .flatMap((group) => group.attributes || [])
    .filter((attribute) => Number(attribute.id || 0) === Number(id))
    .flatMap((attribute) => attribute.values || []);
}

function assertBaseOzonItemContract(item) {
  assert.ok(item.offer_id, "offer_id is required");
  assert.ok(item.name, "name is required");
  assert.ok(Number(item.price) > 0, "price must be positive");
  assert.ok(Number(item.description_category_id) > 0, "description_category_id is required");
  assert.ok(Number(item.type_id) > 0, "type_id is required");
  assert.equal(item.dimension_unit, "mm");
  assert.equal(item.weight_unit, "g");
  assert.ok(Number(item.depth) > 0, "depth must be positive millimeters");
  assert.ok(Number(item.width) > 0, "width must be positive millimeters");
  assert.ok(Number(item.height) > 0, "height must be positive millimeters");
  assert.ok(Number(item.weight) > 0, "weight must be positive grams");
  assert.match(item.primary_image, /^https:\/\//, "primary_image must be publishable HTTPS");
  assert.ok(Array.isArray(item.attributes), "attributes must be an array");
}

test("AI variant publish candidate becomes an Ozon-compatible import payload", async () => {
  const result = await validateListingTemplatePublish(fixtures.aiVariantCandidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "AI-TENET-T4-BLACK-001");
  assert.equal(item.depth, 680);
  assert.equal(item.width, 420);
  assert.equal(item.height, 60);
  assert.equal(item.weight, 1200);
  assertNoLocalMedia(result.payload);

  const brand = attributeById(item, 85);
  assert.deepEqual(compactAttributeValues(brand.values), [{ dictionary_value_id: 126745801, value: "No brand" }]);

  const color = attributeById(item, 10096);
  assert.deepEqual(compactAttributeValues(color.values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.doesNotMatch(JSON.stringify(item), /Other brand|white/);

  assert.deepEqual(complexAttributeValues(item, 21841), [{ value: "https://cdn.example.test/listing/ai-trunk-video.mp4" }]);
  assert.deepEqual(complexAttributeValues(item, 21845), [{ dictionary_value_id: 0, value: "https://cdn.example.test/listing/ai-trunk-video.mp4" }]);
});

test("publish payload uses edited SKU name even when variant title is stale", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.title = "Old template title";
  candidate.editable_payload.title = "Old editable title";
  candidate.editable_payload.variants[0].title = "Old variant title";
  candidate.editable_payload.variants[0].name = "Edited SKU buyer-facing name";

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items[0].name, "Edited SKU buyer-facing name");
});

test("publish validation accepts a SKU row price when the shared template price is empty", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.editable_payload.price.value = 0;
  candidate.editable_payload.price.price = 0;
  candidate.editable_payload.variants[0].price = 0;
  candidate.editable_payload.variants[0].price_value = 1299;

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items[0].price, "1299");
  assert.doesNotMatch(result.errors.join("\n"), /销售价格/);
});

test("publish validation reports a missing price when only some SKU rows have prices", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.editable_payload.price.value = 0;
  candidate.editable_payload.price.price = 0;
  candidate.editable_payload.variants[0].price = 1299;
  candidate.editable_payload.variants.push({
    ...clone(candidate.editable_payload.variants[0]),
    sku: "AI-TENET-T4-BLACK-002",
    offer_id: "AI-TENET-T4-BLACK-002",
    price: 0,
    price_value: 0
  });

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /缺少销售价格/);
});

test("publish validation accepts independent package values from every variant", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  const originalDimensions = clone(candidate.editable_payload.dimensions);
  candidate.editable_payload.dimensions = { length_cm: 0, width_cm: 0, height_cm: 0, weight_g: 0 };
  Object.assign(candidate.editable_payload.variants[0], {
    length_mm: originalDimensions.length_cm * 10,
    width_mm: originalDimensions.width_cm * 10,
    height_mm: originalDimensions.height_cm * 10,
    weight_g: originalDimensions.weight_g
  });
  candidate.editable_payload.variants.push({
    ...clone(candidate.editable_payload.variants[0]),
    sku: "AI-TENET-T4-BLACK-002",
    offer_id: "AI-TENET-T4-BLACK-002",
    length_mm: 710,
    width_mm: 430,
    height_mm: 70,
    weight_g: 1300
  });

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items[0].weight, 1200);
  assert.equal(result.payload.items[1].weight, 1300);
  assert.equal(result.payload.items[1].depth, 710);
});

test("publish validation identifies the exact variant missing package values", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.editable_payload.dimensions = { length_cm: 0, width_cm: 0, height_cm: 0, weight_g: 0 };
  candidate.editable_payload.variants.push({
    ...clone(candidate.editable_payload.variants[0]),
    sku: "AI-TENET-T4-BLACK-002",
    offer_id: "AI-TENET-T4-BLACK-002",
    length_mm: 0,
    width_mm: 0,
    height_mm: 0,
    weight_g: 0
  });

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /第 2 个变体（AI-TENET-T4-BLACK-002）缺少包裹重量/);
  assert.match(result.errors.join("\n"), /第 2 个变体（AI-TENET-T4-BLACK-002）缺少包裹长宽高/);
});

test("collector-box candidate keeps selected dictionary values and physical units", async () => {
  const result = await validateListingTemplatePublish(fixtures.collectorCandidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "COLLECTOR-BELT-PAD-BLACK-2PCS");
  assert.equal(item.depth, 250);
  assert.equal(item.width, 80);
  assert.equal(item.height, 40);
  assert.equal(item.weight, 220);
  assertNoLocalMedia(result.payload);

  const color = attributeById(item, 10096);
  assert.deepEqual(compactAttributeValues(color.values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.equal(color.values.some((value) => value.value === "white" || value.value === "red"), false);
});

test("publish-record retry candidate preserves retry offer and strips unsafe placeholders", async () => {
  const result = await validateListingTemplatePublish(fixtures.publishRecordRetryCandidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "RETRY-TENET-KEY-CASE-001");
  assert.equal(item.depth, 100);
  assert.equal(item.width, 60);
  assert.equal(item.height, 30);
  assert.equal(item.weight, 100);
  assertNoLocalMedia(result.payload);

  assert.ok(attributeById(item, 7199), "material attribute should remain publishable");
  assert.ok(attributeById(item, 9048), "model attribute should remain publishable");
  assert.deepEqual(compactAttributeValues(attributeById(item, 10096).values), [{ dictionary_value_id: 61574, value: "black" }]);
});

test("publish validation defers local-only media blocking until final shop payload", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.images[0].url = "/uploads/listing-media/local-preview.jpg";
  candidate.editable_payload.variants[0].images[0].url = "http://localhost:8788/uploads/listing-media/local-preview.jpg";

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.doesNotMatch(result.errors.join("\n"), /uploads|Local|localhost/i);
});

test("publish validation blocks missing Ozon category identifiers", async () => {
  const candidate = clone(fixtures.collectorCandidate);
  candidate.ozon_category_id = "";
  candidate.editable_payload.description_category_id = "";
  candidate.editable_payload.type_id = "";

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Ozon|description_category_id|type_id/);
});

test("publish validation blocks variants without submit-ready offer ids", async () => {
  const candidate = clone(fixtures.publishRecordRetryCandidate);
  candidate.editable_payload.variants[0].offer_id = "";
  candidate.editable_payload.variants[0].sku = "";

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /offer_id|SKU|货号/i);
});

test("collector raw source normalizes into a submit-ready Ozon candidate after offer generation", async () => {
  const candidate = buildTemplateCandidateFromCollectedSource(fixtures.collectorRawSource, {
    sourceType: "collector_box",
    sourceId: "RAW-COLLECTOR-TRUNK-001",
    templateName: "Raw collector trunk mat",
    offerId: "RAW-COLLECTOR-TRUNK-BLACK-PUBLISH"
  });

  assert.deepEqual(candidate.normalization.missing_fields, []);
  assert.equal(candidate.normalization.category.description_category_id, "17028922");
  assert.equal(candidate.normalization.category.type_id, "971712345");
  assert.equal(candidate.editable_payload.dimensions.length_cm, 70);
  assert.equal(candidate.editable_payload.dimensions.width_cm, 45);
  assert.equal(candidate.editable_payload.dimensions.height_cm, 5);
  assert.equal(candidate.editable_payload.dimensions.weight_g, 1350);
  assert.equal(candidate.editable_payload.images.length, 2);
  assert.equal(candidate.editable_payload.variants.length, 1);
  assert.equal(candidate.editable_payload.variants[0].source_sku, "RAW-COLLECTOR-TRUNK-BLACK");

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "RAW-COLLECTOR-TRUNK-BLACK-PUBLISH");
  assert.equal(item.depth, 700);
  assert.equal(item.width, 450);
  assert.equal(item.height, 50);
  assert.equal(item.weight, 1350);
  assertNoLocalMedia(result.payload);
  assert.deepEqual(compactAttributeValues(attributeById(item, 10096).values), [{ dictionary_value_id: 61574, value: "black" }]);
});

test("deterministic collector color repair hydrates single variant plain color into dictionary selection", async () => {
  const normalized = {
    category: {
      description_category_id: 17028922,
      type_id: 971712345
    },
    templatePayload: {
      editable_payload: {
        description_category_id: 17028922,
        type_id: 971712345,
        attributes: [
          {
            attribute_id: 10096,
            name: "Color",
            dictionary_id: 555,
            values: [
              { dictionary_value_id: 61574, value: "black", display_value_zh: "black" }
            ]
          }
        ],
        variants: [
          {
            sku: "SINGLE-BLACK-1",
            color: "black",
            dynamic_attributes: {}
          }
        ]
      }
    },
    draft: {
      attributes: [
        {
          attribute_id: 10096,
          name: "Color",
          dictionary_id: 555,
          values: [
            { dictionary_value_id: 61574, value: "black", display_value_zh: "black" }
          ]
        }
      ]
    },
    payload: {
      attributes: [
        {
          attribute_id: 10096,
          name: "Color",
          dictionary_id: 555,
          values: [
            { dictionary_value_id: 61574, value: "black", display_value_zh: "black" }
          ]
        }
      ]
    }
  };

  await repairCollectedVariantColorAxisDeterministic(normalized);

  const repaired = normalized.templatePayload.editable_payload.variants[0].dynamic_attributes["10096"];
  assert.ok(repaired);
  assert.deepEqual(compactAttributeValues(repaired.selected_values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.equal(normalized.templatePayload.editable_payload.variants[0].color, "black");
});

test("deterministic collector color repair projects top-level color attribute into single variant", async () => {
  const normalized = {
    category: {
      description_category_id: 17028922,
      type_id: 971712345
    },
    templatePayload: {
      editable_payload: {
        description_category_id: 17028922,
        type_id: 971712345,
        attributes: [
          {
            attribute_id: 10096,
            name: "Color",
            dictionary_id: 555,
            value: "black",
            values: [
              { dictionary_value_id: 61574, value: "black", display_value_zh: "black" }
            ],
            selected_values: [
              { dictionary_value_id: 61574, value: "black", display_value_zh: "black" }
            ]
          }
        ],
        variants: [
          {
            sku: "TOPLEVEL-BLACK-1",
            dynamic_attributes: {}
          }
        ]
      }
    },
    draft: { attributes: [] },
    payload: { attributes: [] }
  };

  await repairCollectedVariantColorAxisDeterministic(normalized);

  const repaired = normalized.templatePayload.editable_payload.variants[0].dynamic_attributes["10096"];
  assert.ok(repaired);
  assert.deepEqual(compactAttributeValues(repaired.selected_values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.deepEqual(
    compactAttributeValues(normalized.templatePayload.editable_payload.attributes[0].selected_values),
    [{ dictionary_value_id: 61574, value: "black" }]
  );
});

test("deterministic collector color repair does not select every color dictionary candidate", async () => {
  const normalized = {
    templatePayload: {
      editable_payload: {
        variants: [{
          sku: "CANDIDATE-COLORS-1",
          color: "black",
          dynamic_attributes: {
            10096: {
              attribute_id: 10096,
              name: "Color",
              value: ["black"],
              values: [
                { dictionary_value_id: 61574, value: "black" },
                { dictionary_value_id: 61575, value: "white" },
                { dictionary_value_id: 61576, value: "silver" }
              ],
              selected_values: [
                { dictionary_value_id: 61574, value: "black" },
                { dictionary_value_id: 61575, value: "white" },
                { dictionary_value_id: 61576, value: "silver" }
              ]
            }
          }
        }]
      }
    },
    draft: { attributes: [] },
    payload: { attributes: [] }
  };

  await repairCollectedVariantColorAxisDeterministic(normalized);

  const repaired = normalized.templatePayload.editable_payload.variants[0].dynamic_attributes["10096"];
  assert.deepEqual(compactAttributeValues(repaired.selected_values), [
    { dictionary_value_id: 61574, value: "black" }
  ]);
  assert.equal(repaired.values.length, 3);
});

test("AI variant raw result can be merged into a publishable Ozon candidate", async () => {
  const candidate = buildTemplateCandidateFromAiVariantResult(fixtures.aiVariantRawResult, {
    offerId: "AI-RAW-TENET-T4-PUBLISH",
    sourceType: "ai_optimization_v2_raw_fixture"
  });

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "AI-RAW-TENET-T4-PUBLISH");
  assert.equal(item.name, "AI optimized trunk mat for TENET T4, black");
  assert.equal(item.depth, 720);
  assert.equal(item.width, 480);
  assert.equal(item.height, 60);
  assert.equal(item.weight, 1450);
  assert.equal(item.primary_image, "https://cdn.example.test/listing/ai-raw-generated-main.jpg");
  assertNoLocalMedia(result.payload);
  assert.deepEqual(compactAttributeValues(attributeById(item, 10096).values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.deepEqual(complexAttributeValues(item, 21841), [{ value: "https://cdn.example.test/listing/ai-raw-generated-video.mp4" }]);
  assert.deepEqual(complexAttributeValues(item, 21845), [{ dictionary_value_id: 0, value: "https://cdn.example.test/listing/ai-raw-generated-video.mp4" }]);
  assert.doesNotMatch(JSON.stringify(item.attributes), /white/);
});

test("publish validation sanitizes AI variant tags into Ozon-safe hashtags", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.attributes = [
    ...(candidate.attributes || []).filter((attribute) => Number(attribute.attribute_id || attribute.id || 0) !== 23171),
    {
      attribute_id: 23171,
      name: "Search tags",
      type: "multiselect",
      value: ["  TENET T4  ", "багажник/коврик", "门槛条", "##car accessory", "!!!", "багажник/коврик"]
    }
  ];
  candidate.editable_payload.variants[0].hashtags = ["  TENET T4  ", "багажник/коврик", "门槛条", "##car accessory", "!!!"];

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  const item = result.payload.items[0];
  assert.deepEqual(item.tags, ["#TENET_T4", "#багажник_коврик", "#car_accessory"]);
  assert.deepEqual(
    compactAttributeValues(attributeById(item, 23171).values),
    [
      { dictionary_value_id: undefined, value: "#TENET_T4 #багажник_коврик #car_accessory" }
    ]
  );
});

test("publish validation splits space-separated AI tags into separate Ozon tags", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.attributes = (candidate.attributes || []).filter((attribute) => Number(attribute.attribute_id || attribute.id || 0) !== 23171);
  candidate.editable_payload.variants[0].hashtags = "#TENET_T4 #органайзер #автоаксессуары";

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  const item = result.payload.items[0];
  assert.deepEqual(item.tags.slice(0, 3), ["#TENET_T4", "#органайзер", "#автоаксессуары"]);
});

test("publish validation maps name-only collector product tags to Ozon attribute 23171", async () => {
  const candidate = clone(fixtures.aiVariantCandidate);
  candidate.attributes = [
    ...(candidate.attributes || []).filter((attribute) => Number(attribute.attribute_id || attribute.id || 0) !== 23171),
    {
      name: "Product tags",
      type: "multiselect",
      value: "#TENET_T4 #organizer"
    }
  ];
  candidate.editable_payload.variants[0].hashtags = [];

  const result = await validateListingTemplatePublish(candidate);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  const item = result.payload.items[0];
  assert.deepEqual(item.tags.slice(0, 2), ["#TENET_T4", "#organizer"]);
  assert.deepEqual(
    compactAttributeValues(attributeById(item, 23171).values),
    [
      { dictionary_value_id: undefined, value: "#TENET_T4 #organizer" }
    ]
  );
});

test("online product edit template standardizes into a publishable Ozon candidate", async () => {
  const standardized = await buildTemplateCandidateFromOnlineProductTemplate(clone(fixtures.onlineProductEditTemplate), {
    sourceId: "ONLINE-TENET-DEFLECTOR-SOURCE",
    offerId: "ONLINE-TENET-DEFLECTOR-SOURCE",
    onlineProductId: 99801,
    mergeCategoryAttributeDefinitions: async (attributes) => attributes,
    buildDiagnostics: async () => ({ ok: true, summary: { blockers: 0, warnings: 0 } })
  });

  assert.equal(standardized.ozon_category_id, "17032000:971701111");
  assert.equal(standardized.editable_payload.description_category_id, "17032000");
  assert.equal(standardized.editable_payload.type_id, "971701111");
  assert.equal(standardized.source_raw.from_online_product, true);
  assert.equal(standardized.source_raw.online_product_id, 99801);
  assert.equal(standardized.source_raw.listing_template_standardizer.source_type, "online_product_live");
  assert.equal(standardized.editable_payload.source_raw.listing_template_standardizer.source_type, "online_product_live");

  const result = await validateListingTemplatePublish(standardized);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assertBaseOzonItemContract(item);
  assert.equal(item.offer_id, "ONLINE-TENET-DEFLECTOR-PUBLISH");
  assert.equal(item.depth, 560);
  assert.equal(item.width, 120);
  assert.equal(item.height, 80);
  assert.equal(item.weight, 700);
  assert.equal(item.primary_image, "https://cdn.example.test/listing/online-deflector-main.jpg");
  assertNoLocalMedia(result.payload);
  assert.deepEqual(compactAttributeValues(attributeById(item, 85).values), [{ dictionary_value_id: 126745801, value: "No brand" }]);
  assert.deepEqual(compactAttributeValues(attributeById(item, 10096).values), [{ dictionary_value_id: 61574, value: "black" }]);
  assert.doesNotMatch(JSON.stringify(item.attributes), /white/);
  assert.notEqual(item.offer_id, standardized.source_raw.offer_id, "copied online product should use a publish-safe offer id");
});

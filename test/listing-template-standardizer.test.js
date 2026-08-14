import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { standardizeListingTemplatePayload } from "../src/services/listing-template-standardizer.js";

const automationSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("standardizer resolves category and merges Ozon schema attributes without changing free text", async () => {
  const calls = [];
  const payload = await standardizeListingTemplatePayload({
    template_name: "online product draft",
    title: "Дефлектор для окон, 4 шт.",
    description: "Свободное описание продавца.",
    category_name: "",
    source_raw: { offer_id: "OFFER-1" },
    editable_payload: {
      title: "Дефлектор для окон, 4 шт.",
      description: "Свободное описание продавца.",
      attributes: [
        {
          attribute_id: 85,
          name: "Бренд",
          value: "Нет бренда",
          values: [{ dictionary_value_id: 126745801, value: "Нет бренда" }]
        },
        {
          attribute_id: 4191,
          name: "Аннотация",
          value: "Свободное описание продавца."
        }
      ],
      images: [{ url: "https://example.test/a.jpg" }]
    }
  }, {
    sourceType: "online_product_live",
    sourceId: "OFFER-1",
    resolveCategory: async () => ({
      description_category_id: 17028755,
      type_id: 97593,
      path_zh: "汽车用品 / 汽车改装和外部装饰 / 晴雨挡",
      source: "attribute_8229_dictionary_value"
    }),
    mergeCategoryAttributeDefinitions: async (attributes, descriptionCategoryId, typeId, options) => {
      calls.push({ attributes, descriptionCategoryId, typeId, options });
      return [
        {
          attribute_id: 85,
          name: "品牌",
          value: "Нет бренда",
          values: [{ dictionary_value_id: 126745801, value: "Нет бренда", display_value_zh: "无品牌" }]
        },
        {
          attribute_id: 4191,
          name: "简介",
          value: "Свободное описание продавца."
        }
      ];
    }
  });

  assert.equal(payload.ozon_category_id, "17028755:97593");
  assert.equal(payload.category_name, "汽车用品 / 汽车改装和外部装饰 / 晴雨挡");
  assert.equal(payload.title, "Дефлектор для окон, 4 шт.");
  assert.equal(payload.description, "Свободное описание продавца.");
  assert.equal(payload.editable_payload.title, "Дефлектор для окон, 4 шт.");
  assert.equal(payload.editable_payload.description, "Свободное описание продавца.");
  assert.equal(payload.attributes.length, 2);
  assert.equal(payload.attributes[0].name, "品牌");
  assert.equal(payload.attributes[0].values[0].dictionary_value_id, 126745801);
  assert.equal(payload.attributes[0].values[0].display_value_zh, "无品牌");
  assert.equal(payload.editable_payload.description_category_id, "17028755");
  assert.equal(payload.editable_payload.type_id, "97593");
  assert.equal(payload.source_raw.listing_template_standardizer.source_type, "online_product_live");
  assert.equal(payload.source_raw.listing_template_standardizer.source_id, "OFFER-1");
  assert.equal(payload.source_raw.listing_template_standardizer.category_resolved_from, "attribute_8229_dictionary_value");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].descriptionCategoryId, 17028755);
  assert.equal(calls[0].typeId, 97593);
});

test("standardizer can run lightweight without diagnostics for publish record lists", async () => {
  let diagnosticsCalled = false;
  const payload = await standardizeListingTemplatePayload({
    ozon_category_id: "17028755:97593",
    category_name: "汽车用品 / 汽车改装和外部装饰 / 晴雨挡",
    title: "Дефлектор для окон, 4 шт.",
    attributes: [{ attribute_id: 85, name: "品牌", value: "Нет бренда" }],
    editable_payload: {
      variants: [{ offer_id: "OFFER-2" }]
    }
  }, {
    sourceType: "listing_publish_record",
    sourceId: "151",
    mergeCategoryAttributeDefinitions: async (attributes) => attributes,
    buildDiagnostics: null
  });

  assert.equal(payload.ozon_category_id, "17028755:97593");
  assert.equal(payload.editable_payload.description_category_id, "17028755");
  assert.equal(payload.editable_payload.type_id, "97593");
  assert.equal(payload.mapping_diagnostics, undefined);
  assert.equal(diagnosticsCalled, false);
});

test("standardizer stores diagnostics summary when diagnostics are provided", async () => {
  const diagnostics = {
    ok: true,
    summary: {
      issues: 0,
      blockers: 0,
      warnings: 0,
      schema_attributes: 35,
      template_attributes: 35
    }
  };
  const payload = await standardizeListingTemplatePayload({
    ozon_category_id: "17028755:97593",
    category_name: "汽车用品 / 汽车改装和外部装饰 / 晴雨挡",
    attributes: [{ attribute_id: 85, name: "品牌", value: "Нет бренда" }],
    editable_payload: {}
  }, {
    sourceType: "listing_publish_record",
    sourceId: "151",
    mergeCategoryAttributeDefinitions: async (attributes) => attributes,
    buildDiagnostics: async () => diagnostics
  });

  assert.equal(payload.mapping_diagnostics, diagnostics);
  assert.equal(payload.editable_payload.mapping_diagnostics, diagnostics);
  assert.deepEqual(payload.source_raw.listing_template_standardizer.diagnostics_summary, diagnostics.summary);
});

test("standardizer marks online product edit drafts as a reusable listing template source", async () => {
  const payload = await standardizeListingTemplatePayload({
    ozon_category_id: "17028755:97593",
    category_name: "汽车用品 / 汽车改装和外部装饰 / 晴雨挡",
    source_raw: {
      source_type: "online_product_live",
      online_product_id: 998,
      offer_id: "ONLINE-OFFER-1",
      from_online_product: true
    },
    editable_payload: {
      sku: "ONLINE-OFFER-1",
      title: "Дефлектор для окон",
      attributes: [{ attribute_id: 85, name: "品牌", value: "Нет бренда" }]
    }
  }, {
    sourceType: "online_product_live",
    sourceId: "ONLINE-OFFER-1",
    mergeCategoryAttributeDefinitions: async (attributes) => attributes,
    buildDiagnostics: async () => ({ ok: true, summary: { blockers: 0, warnings: 0 } })
  });

  assert.equal(payload.source_raw.from_online_product, true);
  assert.equal(payload.source_raw.online_product_id, 998);
  assert.equal(payload.source_raw.listing_template_standardizer.source_type, "online_product_live");
  assert.equal(payload.source_raw.listing_template_standardizer.source_id, "ONLINE-OFFER-1");
  assert.equal(payload.editable_payload.category_id, "17028755:97593");
  assert.equal(payload.editable_payload.source_raw.listing_template_standardizer.source_type, "online_product_live");
});

test("automation standardizer resolves dict placeholders through cached dictionary definitions", () => {
  assert.match(automationSource, /function dictionaryOptionDisplayValue/);
  assert.match(automationSource, /function dictionaryModelIdFromAny/);
  assert.match(automationSource, /dictionaryOptionDisplayValue\(item, definition\.values\)/);
  assert.match(automationSource, /dictionaryOptionDisplayValue\(value\.value \?\? value\.values\?\.\[0\] \?\? "", definition\.values\)/);
  assert.match(automationSource, /Number\(item\.dictionary_value_id \|\| item\.id \|\| item\.value_id \|\| 0\)/);
});

test("Ozon publish normalization ignores unselected dictionary option candidates", () => {
  assert.match(automationSource, /function selectedAttributeValuesForOzon\(item = \{\}\)/);
  assert.match(automationSource, /const selectedValues = normalizeArray\(item\.selected_values \|\| item\.selectedValues\);/);
  assert.match(automationSource, /function rebuildCollectionDictionaryValues\(currentValues = \[\], optionValues = \[\]\)/);
  assert.match(automationSource, /rebuildCollectionDictionaryValues\(item\.value, optionValues\)/);
  assert.match(automationSource, /const sourceValues = selectedAttributeValuesForOzon\(item\);/);
  assert.match(automationSource, /optionValues\.find\(\(option\) =>/);
  assert.doesNotMatch(automationSource, /const sourceValues = Array\.isArray\(item\.values\) && item\.values\.length \? item\.values : item\.value;/);
});

test("selected dictionary hydration also reads selected ids from matching option values", () => {
  assert.match(automationSource, /const currentKeys = new Set\(values\.map\(\(value\) => normalizeTranslationSource\(value\)\)\.filter\(Boolean\)\);/);
  assert.match(automationSource, /for \(const value of normalizeArray\(field\?\.values\)\)/);
  assert.match(automationSource, /currentKeys\.size && currentKeys\.has\(normalizeTranslationSource/);
  assert.match(automationSource, /if \(!ref\?\.dictionary_value_id\) continue;/);
  assert.match(automationSource, /function alignAttributeValueToSelectedOptions\(value, selectedValues = \[\], isCollection = false\)/);
  assert.match(automationSource, /const alignedValue = alignAttributeValueToSelectedOptions\(field\.value, mergedSelectedValues/);
});

test("automation standardizer auto-selects a single required dictionary option", () => {
  assert.match(automationSource, /function autoSelectSingleRequiredDictionaryValue\(attribute = \{\}\)/);
  assert.match(automationSource, /options\.length !== 1/);
  assert.match(automationSource, /selected_values: \[selected\]/);
  assert.match(automationSource, /autoSelectSingleRequiredDictionaryValue\(applyRequiredAttributeDefault\(attribute, attributeContextText\)\)/);
  assert.match(automationSource, /function applyRequiredAttributeDefault\(attribute = \{\}, contextText = ""\)/);
  assert.match(automationSource, /attributeId === 23487/);
  assert.match(automationSource, /attributeId === 4389/);
  assert.match(automationSource, /function findDictionaryOptionByTexts\(options = \[\], texts = \[\]\)/);
});

test("automation standardizer infers heated hair-cap product type from product context", () => {
  assert.match(automationSource, /const attributeContextText = normalizedValues/);
  assert.match(automationSource, /attributeId === 8229 && \/термошап/);
  assert.match(automationSource, /selectRequiredDictionaryDefault\(attribute, \["Термошапка", "加热发帽"\]\)/);
});

test("automation standardizer does not treat schema attribute names as generated values", () => {
  assert.match(automationSource, /const hasExplicitValue = value\.value !== undefined/);
  assert.match(automationSource, /const hasExplicitValues = Array\.isArray\(value\.values\) && value\.values\.length > 0/);
  assert.match(automationSource, /if \(!hasExplicitValue && !hasExplicitValues\) return ""/);
  assert.match(automationSource, /value\.value \?\? value\.values\?\.\[0\] \?\? ""/);
});

test("Ozon publish adds stable high-value attributes only when the category supports them", () => {
  assert.match(automationSource, /const inferredQuantity = inferListingPackageQuantity\(item\)/);
  assert.match(automationSource, /if \(hasCategoryAttr\(4384\)\) addPlainOzonAttribute\(byId, 4384, inferredQuantity\.label\)/);
  assert.match(automationSource, /if \(hasCategoryAttr\(11650\)\) addPlainOzonAttribute\(byId, 11650, inferredQuantity\.count\)/);
  assert.match(automationSource, /if \(hasCategoryAttr\(23249\)\) addPlainOzonAttribute\(byId, 23249, inferredQuantity\.count\)/);
  assert.match(automationSource, /if \(hasCategoryAttr\(5629\)\) await addDictionaryOzonAttribute/);
  assert.match(automationSource, /vehicle\.model, vehicle\.full/);
  assert.match(automationSource, /function shouldAutoPublishMaterialAttribute\(descriptionCategoryId, typeId\)/);
  assert.match(automationSource, /const safeTags = cleanPublishOzonTagList\(item\)/);
  assert.match(automationSource, /byId\.set\(23171, \{ id: 23171, values: safeTags\.map\(\(value\) => \(\{ value \}\)\) \}\)/);
  assert.match(automationSource, /const isTagAttribute = attributeId === 23171/);
  assert.match(automationSource, /if \(isTagAttribute\) return normalizeOzonHashtags\(text, 20\)\.map\(\(tag\) => \(\{ value: tag \}\)\)/);
  assert.doesNotMatch(automationSource, /publishOzonTagList\(item\)\.join\(" "\)/);
});

test("Ozon publish auto-selects missing required dictionary attributes only from provided options", () => {
  assert.match(automationSource, /async function autoSelectMissingRequiredDictionaryAttributes/);
  assert.match(automationSource, /await autoSelectMissingRequiredDictionaryAttributes\(byId/);
  assert.match(automationSource, /Choose only from the provided option dictionary_value_id values/);
  assert.match(automationSource, /Do not invent values/);
  assert.match(automationSource, /const selected = options\.find\(\(option\) => Number\(option\.dictionary_value_id/);
  assert.match(automationSource, /source: "ai_required_dictionary_option"/);
  assert.match(automationSource, /export async function validateListingTemplatePublishForShop/);
  assert.match(automationSource, /await validateListingTemplatePublishForShop\(body\.template \|\| body, shops\[0\]\.id, session\)/);
});

test("publish precheck blocks public listing media that is not fully downloadable", () => {
  const reachabilitySource = automationSource.match(/async function assertPublishPayloadMediaReachable\(payload = \{\}, validation = null\)[\s\S]*?export async function publishListingTemplateToOzon/)?.[0] || "";
  assert.match(automationSource, /async function unreachablePublishMediaUrls\(urls = \[\]\)/);
  assert.match(automationSource, /async function isReachableRemoteMediaUrl\(url = ""\)/);
  assert.match(automationSource, /async function assertPublishPayloadMediaReachable\(payload = \{\}, validation = null\)/);
  assert.doesNotMatch(automationSource, /if \(resolveListingMediaLocalPath\(url\)\) return null;/);
  assert.match(reachabilitySource, /Public media is not fully downloadable; Ozon submit was blocked/);
  assert.match(reachabilitySource, /validation\.errors = \[\.\.\.normalizeArray\(validation\.errors\), message\]/);
  assert.match(reachabilitySource, /error\.unreachable_media = unavailableRemoteMedia/);
  assert.match(reachabilitySource, /throw error/);
});

test("listing media upload syncs local files to the public ERP before publishing", () => {
  assert.match(automationSource, /async function ensureListingMediaPublicUrl\(/);
  assert.match(automationSource, /async function syncListingMediaFileToPublicBase\(/);
  assert.match(automationSource, /\/api\/listing\/media\/public-upload/);
  assert.match(automationSource, /config\.localPluginPublicToken/);
  assert.match(automationSource, /skip_public_sync/);
});

test("publish record previews can localize configured public listing media URLs", () => {
  assert.match(automationSource, /function localListingPreviewUrl\(url = ""\)/);
  assert.match(automationSource, /config\.listingMediaPublicBaseUrl \|\| config\.appBaseUrl/);
  assert.match(automationSource, /parsed\.origin === appOrigin \|\| parsed\.origin === mediaOrigin/);
});

test("Ozon content rating errors fall back to local quality instead of zeroing the record", () => {
  assert.match(automationSource, /function localQualityFallbackFromRecord\(record = \{\}, source = "local_estimate", issues = \[\]\)/);
  assert.match(automationSource, /local_estimate_after_ozon_rating_error/);
  assert.doesNotMatch(automationSource, /source: "ozon_rating_error",\n\s+issues: \["Ozon 内容评分接口查询失败"\]/);
});

test("collector template creation pre-resolves cached dictionary display values before editor opens", () => {
  assert.match(automationSource, /async function preResolveAttributeDictionaryValues\(attributes = \[\], descriptionCategoryId, typeId\)/);
  assert.match(automationSource, /const resolved = await preResolveAttributeDictionaryValues\(inferred, descriptionCategoryId, typeId\);/);
  assert.match(automationSource, /function loadCachedDictionaryMatches\(descriptionCategoryId, typeId, plans = \[\]\)/);
  assert.match(automationSource, /LOWER\(display_value_zh\) IN/);
  assert.match(automationSource, /function applyCachedDictionaryResolution\(attribute = \{\}, index = \{\}\)/);
  assert.match(automationSource, /selected_values: selectedValues/);
  assert.match(automationSource, /const values = mergeSelectedDictionaryOptions\(resolvedSelected, attribute\.values \|\| \[\]\);/);
  assert.match(automationSource, /values/);
  assert.match(automationSource, /attribute_id: Number\(row\.attribute_id \|\| row\.attributeId/);
  assert.match(automationSource, /мерсеризованн\.\*хлоп/);
});

test("editor template detail hydrates selected dictionary labels before compaction", () => {
  assert.match(automationSource, /const editorMode = query\?\.mode === "editor"/);
  assert.match(automationSource, /const template = await listingCategoryTemplate\(id, session\);/);
  assert.match(automationSource, /if \(editorMode\) return compactTemplateForEditor\(template\);/);
  assert.match(automationSource, /function compactAttributesForEditor\(attributes = \[\]\)/);
  assert.match(automationSource, /return picked\.slice\(0, 20\);/);
  assert.match(automationSource, /normalizeArray\(field\.values\)\.slice\(0, 8\)\.forEach\(pushOption\);/);
  assert.match(automationSource, /function compactVariantsForEditor\(variants = \[\]\)/);
  assert.match(automationSource, /attributes,\s*attribute_values,\s*characteristics,\s*raw,/);
  assert.match(automationSource, /dynamic_attributes: compactVariantDynamicAttributesForEditor/);
});

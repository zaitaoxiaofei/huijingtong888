import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const assetSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");

test("listing automation exposes a shared standardizer for automation sources", () => {
  assert.match(listingSource, /export async function standardizeListingTemplateForAutomation/);
  assert.match(listingSource, /standardizeListingTemplatePayload\(payload, listingTemplateStandardizerOptions\(options\)\)/);
});

test("selection publish asset templates pass through common listing template layer", () => {
  assert.match(assetSource, /standardizeListingTemplateForAutomation/);
  assert.match(assetSource, /sourceType:\s*"asset_variant_engine"/);
  assert.match(assetSource, /from_selection_product:\s*Boolean\(variant\.source_product_id\)/);
  assert.match(assetSource, /selection_product_id:\s*Number\(variant\.source_product_id \|\| 0\) \|\| null/);
  assert.match(assetSource, /autoSync:\s*false/);
  assert.match(assetSource, /syncValues:\s*false/);
});

test("selection publish stores standardized template fields", () => {
  assert.match(assetSource, /JSON\.stringify\(templatePayload\.source_raw \|\| sourceRaw\)/);
  assert.match(assetSource, /JSON\.stringify\(templatePayload\.editable_payload \|\| editablePayload\)/);
  assert.match(assetSource, /JSON\.stringify\(templatePayload\.attributes \|\| attributes\)/);
  assert.match(assetSource, /JSON\.stringify\(templatePayload\.images \|\| images\)/);
});

test("selection publish reuses prepared shop watermarked media", () => {
  assert.match(assetSource, /shop_watermark_applied:\s*Boolean\(variant\.watermark_path\)/);
  assert.match(assetSource, /publish_media_pre_watermarked:\s*Boolean\(variant\.watermark_path\)/);
  assert.match(assetSource, /watermarkTemplateId:\s*shop\.watermarkPath \? `shop-\$\{shop\.id\}` : ""/);
  assert.match(listingSource, /function shouldReusePreparedShopWatermarkMedia\(body = \{\}, shop = \{\}\)/);
  assert.match(listingSource, /sourceType !== "asset_variant_engine"/);
  assert.match(listingSource, /sourceShopId !== Number\(shop\.id \|\| 0\)/);
  assert.match(listingSource, /preparedShopWatermarkSummary\(defaultedPayload, shop\)/);
});

test("selection publish product identity guard does not recurse", () => {
  assert.match(assetSource, /function buildListingProductIdentity\(material = \{\}\)/);
  assert.match(assetSource, /function requireListingProductIdentity\(material = \{\}\) \{\s+const identity = buildListingProductIdentity\(material\);/);
  assert.doesNotMatch(assetSource, /function requireListingProductIdentity\(material = \{\}\) \{\s+const identity = requireListingProductIdentity\(material\);/);
});

test("selection publish auto-fills safe Ozon attributes before publish", () => {
  assert.match(listingSource, /async function autoFillKnownSafeCategoryAttributes/);
  assert.match(listingSource, /await autoFillKnownSafeCategoryAttributes\(byId/);
  assert.match(listingSource, /function safeAutoAttributeCandidates/);
  assert.match(listingSource, /attributeId === 4389/);
  assert.match(listingSource, /attributeId === 7199/);
  assert.match(listingSource, /attributeId === 10096/);
  assert.match(listingSource, /shouldSkipAutoPublishAttribute/);
});

test("selection publish infers package quantity from product facts instead of defaulting to one", () => {
  assert.match(listingSource, /function inferListingPackageQuantity\(item = \{\}\)/);
  assert.match(listingSource, /function extractPackageQuantityFromText\(value = ""\)/);
  assert.match(listingSource, /item\.title/);
  assert.match(listingSource, /件套\|件装\|个装/);
  assert.match(listingSource, /if \(!fromText\) return \{ count: "", label: "" \};/);
  assert.doesNotMatch(listingSource, /return match \? match\[0\]\.replace\(",", "\."\) : "1";/);
  assert.doesNotMatch(listingSource, /addPlainOzonAttribute\(byId, 4384, "1 шт\."\)/);
  assert.doesNotMatch(listingSource, /addDictionaryOzonAttribute\(byId, shop, descriptionCategoryId, typeId, 7202, \[item\.quantity, "1"\]/);
});

test("selection publish product type is inferred instead of hardcoded to key case", () => {
  assert.match(listingSource, /function productTypeDictionaryQueries\(item = \{\}\)/);
  assert.match(listingSource, /накладки на пороги/);
  assert.match(listingSource, /брелок для ключей/);
  assert.doesNotMatch(listingSource, /values:\s*\[\{\s*dictionary_value_id:\s*typeId,\s*value:\s*"Чехол брелка автосигнализации"\s*\}\]/);
});

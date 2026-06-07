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

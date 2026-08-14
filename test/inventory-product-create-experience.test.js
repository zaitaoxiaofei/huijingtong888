import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");
const namingServiceSource = readFileSync(new URL("../src/services/inventory-product-naming.js", import.meta.url), "utf8");
const vehicleCatalogSource = readFileSync(new URL("../src/services/ai-vehicle-catalog.js", import.meta.url), "utf8");

test("inventory creation reuses the AI vehicle catalog instead of a product brand dictionary", () => {
  assert.match(dialogSource, /\/api\/ai-variant-lab\/vehicle-catalog/);
  assert.match(dialogSource, /vehicle_brand/);
  assert.match(dialogSource, /vehicle_models/);
  assert.match(vehicleCatalogSource, /VEHICLE_BRAND_ZH/);
  assert.match(vehicleCatalogSource, /label:\s*\[brandZh, row\.brand_name\]/);
  assert.doesNotMatch(dialogSource, /brand_zh/);
  assert.doesNotMatch(dialogSource, /brand_en/);
});

test("vehicle models depend on the selected car brand and style defaults to ordinary", () => {
  assert.match(dialogSource, /:disabled="!form\.structured_naming\.vehicle_brand"/);
  assert.match(dialogSource, /multiple filterable clearable collapse-tags/);
  assert.match(dialogSource, /accessory: "普通款"/);
  assert.match(namingServiceSource, /if \(type === "accessory" && !category\)/);
});

test("main image controls live in the standard naming header", () => {
  assert.match(dialogSource, /class="naming-main-image"/);
  assert.match(dialogSource, /size="portrait" fit="cover"/);
  assert.match(dialogSource, /width:\s*168px/);
  assert.match(dialogSource, /height:\s*224px/);
  assert.match(dialogSource, /aspect-ratio:\s*3\s*\/\s*4/);
  assert.match(dialogSource, />上传主图<\/el-button>/);
  assert.doesNotMatch(dialogSource, /label="图片上传"/);
});

test("owner selector uses person names while keeping ids as string values", () => {
  assert.match(dialogSource, /:label="person\.name"\s+:value="String\(person\.id\)"/);
  assert.match(dialogSource, /form\.owner_person_id = props\.people\[0\]\?\.id \? String\(props\.people\[0\]\.id\) : ""/);
});

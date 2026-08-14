import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const namingService = readFileSync(new URL("../src/services/inventory-product-naming.js", import.meta.url), "utf8");
const mysqlService = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");
const search = readFileSync(new URL("../frontend/admin/components/inventory/InventoryStructuredSearch.vue", import.meta.url), "utf8");

test("core product names are limited to seven Unicode characters on writes", () => {
  assert.match(namingService, /CORE_PRODUCT_NAME_MAX_LENGTH = 7/);
  assert.match(namingService, /Array\.from\(text\)\.length > CORE_PRODUCT_NAME_MAX_LENGTH/);
  assert.match(namingService, /optionType === "category" \? validateCoreProductName/);
  assert.match(mysqlService, /Array\.from\(category\)\.length > 7/);
});

test("core product name inputs explain and enforce the seven-character limit", () => {
  assert.match(dialog, /核心品名最多 7 个字/);
  assert.match(dialog, /Array\.from\(text\)\.length <= 7/);
  assert.match(search, /核心品名最多 7 个字/);
  assert.match(search, /Array\.from\(String\(value/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const optimizerSource = readFileSync(new URL("../scripts/optimize-mysql-indexes.mjs", import.meta.url), "utf8");

test("inventory product search resolves exact identifiers before broad contains search", () => {
  assert.match(serviceSource, /async function exactInventoryProductSearchIdsMysql/);
  assert.match(serviceSource, /sm\.active = 1 AND \(sm\.ozon_sku = \? OR sm\.offer_id = \?\)/);
  assert.match(serviceSource, /if \(exactSearchProductIds\.length\)/);
});

test("inventory name search tokenizes fixed naming fields and requires every keyword", () => {
  assert.match(serviceSource, /function inventoryProductSearchTermsMysql/);
  assert.match(serviceSource, /split\(\/\[\\s,，;；\/\+\]\+\//);
  assert.match(serviceSource, /async function structuredInventoryProductSearchIdsMysql/);
  for (const field of [
    "p.name",
    "p.inventory_category",
    "p.vehicle_brand",
    "p.vehicle_model",
    "p.accessory_name",
    "p.color",
    "p.package_contents"
  ]) {
    assert.match(serviceSource, new RegExp(field.replace(".", "\\.")));
  }
  assert.match(serviceSource, /terms\.map\(\(\) => `\$\{searchableNameSql\} LIKE \?`\)\.join\(" AND "\)/);
  assert.match(serviceSource, /structuredSearch\.complete && structuredSearch\.ids\.length/);
});

test("inventory list aggregation and identifier lookup indexes are maintained", () => {
  for (const indexName of [
    "idx_sku_mappings_sku_active_product",
    "idx_sku_mappings_offer_active_product",
    "idx_outbound_product_status_item",
    "idx_inbound_product_status",
    "idx_fbp_transfer_product_status"
  ]) {
    assert.match(optimizerSource, new RegExp(indexName));
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/services/mysql-cutover.js", "utf8");

test("online product SKU helpers used by MySQL cutover are imported", () => {
  const importBlock = source.match(/import \{([\s\S]*?)\} from "\.\/mysql-online-product-sku\.js";/)?.[1] || "";
  assert.match(importBlock, /\bnormalizedOzonSkuCandidateMysql\b/);
  assert.match(importBlock, /\bmissingOnlineProductSkuMarker\b/);
});

test("product naming index stays within the utf8mb4 InnoDB key limit", () => {
  const indexColumns = source.match(
    /CREATE INDEX idx_products_inventory_naming ON products \(([^"]+)\)/
  )?.[1];
  assert.ok(indexColumns, "product naming index definition is missing");

  const prefixLengths = [...indexColumns.matchAll(/\((\d+)\)/g)].map((match) => Number(match[1]));
  assert.equal(prefixLengths.length, 4);
  assert.ok(
    prefixLengths.reduce((total, length) => total + length * 4, 0) <= 3072,
    "utf8mb4 index may exceed InnoDB's 3072-byte key limit"
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const optimizer = fs.readFileSync("scripts/optimize-mysql-indexes.mjs", "utf8");
const schema = fs.readFileSync("scripts/init-mysql-schema.mjs", "utf8");

test("MySQL optimizer adds high-value composite indexes", () => {
  for (const index of [
    "idx_order_profit_items_item_status",
    "idx_inventory_product_location_status_created",
    "idx_online_products_shop_state_updated",
    "idx_procurement_status_order_created_product",
    "idx_finance_posting_date"
  ]) {
    assert.match(optimizer, new RegExp(index));
  }
});

test("new MySQL index definitions only use columns present in the base schema", () => {
  const definitions = [...optimizer.matchAll(/\["([^"]+)", "([^"]+)", "CREATE INDEX [^"]+ ON [^(]+ \(([^)]+)\)"\]/g)];
  for (const [, table, index, rawColumns] of definitions) {
    const tableMatch = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\) ENGINE=`));
    if (!tableMatch) continue;
    const columns = rawColumns.split(",").map((column) => column.trim().split(/\s+/)[0].replaceAll("`", ""));
    for (const column of columns) {
      assert.match(tableMatch[1], new RegExp(`\\b${column}\\b`), `${index} references missing ${table}.${column}`);
    }
  }
});

test("redundant MySQL indexes are reported by default and only dropped explicitly", () => {
  assert.match(optimizer, /process\.argv\.includes\("--drop-redundant"\)/);
  assert.match(optimizer, /if \(!dropRedundant\)/);
  assert.match(optimizer, /ALTER TABLE.*DROP INDEX/);
  assert.equal((schema.match(/KEY idx_ozon_stock_sku_type /g) || []).length, 0);
});

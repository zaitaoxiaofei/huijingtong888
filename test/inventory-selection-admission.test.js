import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("inventory keeps historically bound selections but excludes unbound drafts", () => {
  assert.match(source, /function inventoryProductPredicateMysql/);
  assert.match(source, /EXISTS \(SELECT 1 FROM sku_mappings inventory_sm/);
  assert.match(source, /EXISTS \(SELECT 1 FROM inventory_movements inventory_im/);
  assert.match(source, /const where = \["p\.active = 1", inventoryProductPredicateMysql\("p"\)\]/);
  assert.match(source, /export async function hiddenProductsMysql[\s\S]*const where = \["p\.active = 0"\]/);
});

test("selection admission validates inventory master data before promotion", () => {
  assert.match(source, /加入库存前请先在选品资料中完善/);
  assert.match(source, /库存分类（inventory_category）/);
  assert.match(source, /采购成本（purchase_cost）/);
  assert.match(source, /包装长宽高（length_cm \/ width_cm \/ height_cm）/);
  assert.match(source, /负责人（owner_person_id）/);
});

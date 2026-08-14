import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("structured inventory names are repaired before inventory and order reads", () => {
  assert.match(source, /function structuredInventoryProductNameSqlMysql/);
  assert.match(source, /await syncStructuredInventoryProductNamesMysql\(\);\s*productNamingSchemaReadyMysql = true/);
  assert.match(source, /field\("inventory_category"\)/);
  assert.match(source, /field\("accessory_name"\).*'普通款'/s);
  assert.match(source, /field\("material"\)/);
  assert.match(source, /BINARY COALESCE\(name, ''\) <> BINARY/);
  assert.match(source, /export async function ordersMysql\(\)[\s\S]*?await ensureProductNamingSchemaMysql\(\);/);
  assert.match(source, /export async function ordersPagedMysql\(query = \{\}\)[\s\S]*?ensureProductNamingSchemaMysql\(\)/);
});

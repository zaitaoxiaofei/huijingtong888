import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsViewSource = fs.readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");
const mysqlCutoverSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const apiClientSource = fs.readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");
const shopDictionarySource = fs.readFileSync(new URL("../frontend/admin/utils/shop-dictionary.js", import.meta.url), "utf8");
const ordersPageSource = fs.readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

test("shop settings force refresh bypasses cached shop list after mutations", () => {
  assert.match(settingsViewSource, /loadShopDictionary\(\{ force \}\)/);
  assert.match(settingsViewSource, /state\.shops = state\.shops\.filter\(\(item\) => Number\(item\.id\) !== Number\(row\.id\)\)/);
});

test("shop dictionary invalidates and broadcasts after shop mutations", () => {
  assert.match(apiClientSource, /window\.dispatchEvent\(new CustomEvent\("erp:shops-changed"\)\)/);
  assert.match(apiClientSource, /window\.localStorage\?\.setItem\("erp:shops-changed", String\(Date\.now\(\)\)\)/);
  assert.match(shopDictionarySource, /window\.addEventListener\("erp:shops-changed", markStale\)/);
  assert.match(shopDictionarySource, /event\.key === "erp:shops-changed"/);
});

test("orders page uses shared shop dictionary instead of a local shop cache", () => {
  assert.match(ordersPageSource, /import \{ loadShopDictionary \} from "\.\.\/\.\.\/admin\/utils\/shop-dictionary\.js"/);
  assert.match(ordersPageSource, /loadShopDictionary\(\)\.catch/);
  assert.doesNotMatch(ordersPageSource, /SHOPS_CACHE_TTL_MS|shopsCache|fetchShopsCached/);
});

test("shop create and update reject duplicate active shop names", () => {
  assert.match(mysqlCutoverSource, /async function assertUniqueShopNameMysql\(name, exceptId = 0\)/);
  assert.match(mysqlCutoverSource, /LOWER\(TRIM\(name\)\) = LOWER\(TRIM\(\?\)\)/);
  assert.match(mysqlCutoverSource, /const shopName = await assertUniqueShopNameMysql\(body\.name\);/);
  assert.match(mysqlCutoverSource, /const shopName = await assertUniqueShopNameMysql\(body\.name, Number\(id\)\);/);
  assert.match(mysqlCutoverSource, /请编辑已有店铺，不要重复新增/);
});

test("shop settings binds each shop to a person user id", () => {
  assert.match(settingsViewSource, /<el-select v-model="shopDialog\.form\.user_id" filterable placeholder="请选择店长"/);
  assert.match(settingsViewSource, /user_id: \[\{ required: true, message: "请选择店长"/);
  assert.match(settingsViewSource, /apiClient\.get\("\/api\/people"\)/);
  assert.match(mysqlCutoverSource, /ALTER TABLE shops ADD COLUMN user_id BIGINT UNSIGNED NULL/);
  assert.match(mysqlCutoverSource, /LEFT JOIN people p ON p\.id = s\.user_id/);
  assert.match(mysqlCutoverSource, /const userId = await requireShopUserIdMysql\(body\.user_id\)/);
});

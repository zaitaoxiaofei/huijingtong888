import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsViewSource = fs.readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");
const tenantShopsSource = fs.readFileSync(new URL("../frontend/admin/views/settings/TenantShopsView.vue", import.meta.url), "utf8");
const mysqlCutoverSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const apiClientSource = fs.readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");
const shopDictionarySource = fs.readFileSync(new URL("../frontend/admin/utils/shop-dictionary.js", import.meta.url), "utf8");
const ordersPageSource = fs.readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

test("enterprise shops force a fresh dictionary after mutations and shared rules have no duplicate shop editor", () => {
  assert.match(tenantShopsSource, /apiClient\.get\("\/api\/shops", \{ noCache: true \}\)/);
  assert.match(tenantShopsSource, /await load\(\)/);
  assert.doesNotMatch(settingsViewSource, /shopDialog|\/api\/shops/);
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
  assert.match(mysqlCutoverSource, /async function assertUniqueShopNameMysql\(name, tenantId, exceptId = 0\)/);
  assert.match(mysqlCutoverSource, /LOWER\(TRIM\(name\)\) = LOWER\(TRIM\(\?\)\)/);
  assert.match(mysqlCutoverSource, /const shopName = await assertUniqueShopNameMysql\(body\.name, normalizedTenantId\);/);
  assert.match(mysqlCutoverSource, /const shopName = await assertUniqueShopNameMysql\(body\.name, normalizedTenantId, Number\(id\)\);/);
  assert.match(mysqlCutoverSource, /请编辑已有店铺，不要重复新增/);
});

test("shop settings binds each shop to a person user id", () => {
  assert.match(tenantShopsSource, /<el-select v-model="form\.user_id" filterable placeholder="请选择本企业成员"/);
  assert.match(tenantShopsSource, /if \(!form\.user_id\) return ElMessage\.warning/);
  assert.match(tenantShopsSource, /apiClient\.get\("\/api\/enterprise\/people", \{ noCache: true \}\)/);
  assert.match(mysqlCutoverSource, /ALTER TABLE shops ADD COLUMN user_id BIGINT UNSIGNED NULL/);
  assert.match(mysqlCutoverSource, /LEFT JOIN people p ON p\.id = s\.user_id/);
  assert.match(mysqlCutoverSource, /const userId = await requireShopUserIdMysql\(body\.user_id, normalizedTenantId\)/);
});

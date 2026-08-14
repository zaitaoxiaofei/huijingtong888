import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceSource = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("../frontend/admin/components/inventory/ProductCompositionDialog.vue", import.meta.url), "utf8");

test("late component binding migrates only unfinished order outbounds", () => {
  assert.match(serviceSource, /options\.open_only \? `AND NOT \(\$\{orderStatusSqlMysql\("delivered"\)\}\)` : ""/);
  assert.match(serviceSource, /syncOutboundForOpenOrdersMysql\(\{ product_id: productId, open_only: true \}\)/);
  assert.match(serviceSource, /component_migrations: componentMigrations/);
});

test("component editor reports migrated unfinished orders", () => {
  assert.match(dialogSource, /result\?\.outbound_sync\?\.component_migrations/);
  assert.match(dialogSource, /已迁移 \$\{migratedCount\} 条未完成订单扣库/);
});

test("component editor warns without changing profit when component costs differ", () => {
  assert.match(dialogSource, /componentPurchaseCost/);
  assert.match(dialogSource, /Math\.abs\(purchaseCostDifference\.value\) > 0\.01/);
  assert.match(dialogSource, /保存子产品不会自动修改利润/);
  assert.match(dialogSource, /v-if="hasPurchaseCostMismatch"/);
});

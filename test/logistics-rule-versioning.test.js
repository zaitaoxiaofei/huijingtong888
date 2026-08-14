import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serviceSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../frontend/admin/views/settings/SettingsView.vue", import.meta.url), "utf8");
const schemaSource = fs.readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");

test("logistics rules keep effective-dated versions for order-time freight", () => {
  assert.match(serviceSource, /version_group_id/);
  assert.match(serviceSource, /effective_from <= \?/);
  assert.match(serviceSource, /candidate\.effective_to IS NULL OR candidate\.effective_to > \?/);
  assert.match(serviceSource, /productForProfitEstimateMysql\(mapping\.product_id, item\.ordered_at, \{ raw_json: item\.ozon_raw_json \}\)/);
  assert.match(serviceSource, /productForProfitEstimateMysql\(mapping\.product_id, order\.ordered_at, rawOrder\)/);
  assert.match(serviceSource, /productForProfitEstimateMysql\(mapping\.product_id, posting\.ordered_at, posting\)/);
});

test("order item snapshots record the matched logistics rule version", () => {
  assert.match(serviceSource, /frozen_logistics_rule_id = \?/);
  assert.match(serviceSource, /frozen_international_shipping, frozen_logistics_rule_id, frozen_handling_fee/);
  assert.match(serviceSource, /resolved_logistics_rule_id \|\| product\?\.logistics_rule_id/);
});

test("batch repairs can defer expensive per-order snapshot refreshes", () => {
  assert.match(serviceSource, /recalculateOrderProfitMysql\(orderId, options = \{\}\)/);
  assert.match(serviceSource, /options\.sync_outbound !== false/);
  assert.match(serviceSource, /options\.refresh_snapshots !== false/);
});

test("order logistics filters keep carriers separate even when weight bands overlap", () => {
  assert.match(serviceSource, /SELECT id, version_group_id, name, filter_keywords, carrier, channel/);
  assert.match(serviceSource, /const value = `logistics_rule_\$\{Number\(row\.version_group_id \|\| row\.id\)\}`/);
  assert.match(serviceSource, /orders:logistics-summary:v4:/);
  assert.match(serviceSource, /orders:logistics-options:v4:/);
  assert.match(serviceSource, /explicitValue\.startsWith\("logistics_rule_"\)/);
});

test("order freight prioritizes the actual Ozon delivery method", () => {
  assert.match(serviceSource, /resolveOrderFreightDescriptor\(posting\)/);
  assert.match(serviceSource, /logistics_rule_source: source/);
  assert.match(serviceSource, /"ozon_delivery_method"/);
  assert.match(serviceSource, /productForProfitEstimateMysql\(mapping\.product_id, posting\.ordered_at, posting\)/);
  assert.match(serviceSource, /productForProfitEstimateMysql\(mapping\.product_id, order\.ordered_at, rawOrder\)/);
  assert.match(serviceSource, /ozon_raw_json/);
  assert.match(serviceSource, /WHEN candidate\.name LIKE '% Premium Big' THEN 'Premium Big'/);
  assert.match(serviceSource, /WHEN candidate\.name LIKE '% Extra Small' THEN 'Extra Small'/);
  assert.match(serviceSource, /END = \?/);
  assert.doesNotMatch(serviceSource, /`% \$\{descriptor\.serviceClass\}`/);
});

test("settings require a new version for freight changes", () => {
  assert.match(settingsSource, /新增运费版本/);
  assert.match(settingsSource, /openVersionLogisticsDialog/);
  assert.match(settingsSource, /effective_from/);
  assert.match(serviceSource, /运费金额或计费范围不能直接覆盖/);
  assert.match(settingsSource, /生效时间（北京时间）/);
  assert.match(settingsSource, /失效时间（北京时间）/);
  assert.match(settingsSource, /logisticsRateDelta/);
  assert.match(settingsSource, /PageFooterPagination/);
});

test("CEL V7.24 database migration is effective-dated and idempotent", () => {
  const migrationSource = fs.readFileSync(new URL("../scripts/apply-cel-v724-rates.mjs", import.meta.url), "utf8");
  assert.match(migrationSource, /effectiveFrom = "2026-07-23 16:00:00"/);
  assert.match(migrationSource, /existing\.length/);
  assert.match(migrationSource, /"CEL 陆运经济 Big": \[0\.01768, 37\.44, 0\.0191, 40\.44\]/);
  assert.match(serviceSource, /candidate\.version_group_id = COALESCE\(selected\.version_group_id, selected\.id\)/);
  assert.doesNotMatch(migrationSource, /"CEL 香港空运 HK": \[/);
});

test("GUOO V7.24 migration adds 15 realFBS rules with a Beijing effective time", () => {
  const migrationSource = fs.readFileSync(new URL("../scripts/apply-guoo-v724-rates.mjs", import.meta.url), "utf8");
  assert.match(migrationSource, /effectiveFrom = "2026-07-23 16:00:00"/);
  assert.match(migrationSource, /effective_at_beijing: "2026-07-24 00:00:00"/);
  assert.match(migrationSource, /carrier = 'GUOO' AND name = \? AND effective_from = \?/);
  assert.match(migrationSource, /version_group_id = \? WHERE id = \?/);
  assert.match(migrationSource, /GUOO 特快 Extra Small/);
  assert.match(migrationSource, /0\.05055, 3\.37/);
  assert.match(migrationSource, /MODIFY COLUMN per_gram_cny DECIMAL\(18,6\)/);
  assert.match(schemaSource, /per_gram_cny DECIMAL\(18,6\)/);
  assert.match(migrationSource, /GUOO 经济 Premium Big/);
  assert.doesNotMatch(migrationSource, /GUOO 特快 Budget/);
  assert.match(migrationSource, /result\.rule_count !== rules\.length/);
});

test("logistics rule deletion is separate and reference protected", () => {
  assert.match(serviceSource, /SELECT COUNT\(\*\) FROM products WHERE logistics_rule_id = \?/);
  assert.match(serviceSource, /SELECT COUNT\(\*\) FROM order_items WHERE frozen_logistics_rule_id = \?/);
  assert.match(serviceSource, /DELETE FROM logistics_fee_rules WHERE id = \?/);
  assert.match(settingsSource, /deleteLogisticsRule\(row\)/);
});

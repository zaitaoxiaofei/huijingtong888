import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

test("listing tenant keys resolve to an explicit default slug or numeric tenant primary key", () => {
  assert.deepEqual(listingTenantLookup("admin"), { column: "slug", value: "default", key: "admin" });
  assert.deepEqual(listingTenantLookup("0042"), { column: "id", value: 42, key: "42" });
});

test("listing tenant lookup rejects non-numeric non-default keys", () => {
  for (const key of ["default", "company-a", "0", "-4", "1.5", "9007199254740992"]) {
    assert.throws(() => listingTenantLookup(key), /企业上下文无效/);
  }
});

test("listing inventory auto-binding resolves its tenant from the stored publish record", () => {
  const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
  const bind = service.match(/async function autoBindPublishRecordInventory\([\s\S]*?(?=\nasync function markPublishRecordInventoryBound)/)?.[0] || "";
  assert.match(bind, /SELECT id, tenant_id, shop_id, offer_id, ozon_product_id, ozon_sku, source_product_id/);
  assert.match(bind, /listingTenantLookup\(record\.tenant_id \|\| "admin"\)/);
  assert.match(bind, /SELECT id FROM tenants WHERE \$\{tenantLookup\.column\} = \? AND status = 'active'/);
  assert.match(bind, /发布记录的企业上下文无效，无法绑定库存/);
  assert.match(bind, /const defaultTenant = tenantLookup\.key === "admin"/);
  assert.match(bind, /SELECT id FROM shops[\s\S]*?AND \(tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}\)/);
  assert.match(bind, /发布记录的店铺不属于当前企业，无法绑定库存/);
  const onlineLookup = bind.match(/const online = await row\(`([\s\S]*?)`/)?.[1] || "";
  assert.match(onlineLookup, /JOIN shops s ON s\.id = op\.shop_id/);
  assert.match(onlineLookup, /WHERE op\.shop_id = \? AND s\.id = \?/);
  assert.match(onlineLookup, /s\.tenant_id = \?\$\{defaultTenant \? " OR s\.tenant_id IS NULL" : ""\}/);
  assert.match(bind, /SELECT id FROM products[\s\S]*?AND \(tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}\)/);
  assert.match(bind, /\[sourceProductId, tenantPk\]/);
  assert.match(bind, /UPDATE online_products op[\s\S]*?JOIN shops s ON s\.id = op\.shop_id[\s\S]*?WHERE op\.id = \? AND op\.shop_id = \?[\s\S]*?s\.tenant_id = \?\$\{defaultTenant \? " OR s\.tenant_id IS NULL" : ""\}/);
  assert.match(bind, /sourceProductId,\s+Number\(online\.id\),\s+shopId,\s+tenantPk/);
  assert.match(bind, /inferHistoricalInventoryBinding\(online, tenantPk, defaultTenant\)/);
  const inference = service.match(/async function inferHistoricalInventoryBinding\([\s\S]*?(?=\nexport async function listingInventoryBindings)/)?.[0] || "";
  assert.match(inference, /online_products WHERE id=\? AND shop_id=\?/);
  assert.equal((inference.match(/tenant_id=\?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/g) || []).length, 3);
  assert.match(inference, /\[onlineId, shopId, onlineId, shopId, tenantPk, shopId, tenantPk, sku, sku, shopId, tenantPk, offerId, offerId\]/);
  assert.match(bind, /SELECT id FROM sku_mappings[\s\S]*?WHERE online_product_id = \? AND shop_id = \?[\s\S]*?tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/);
  assert.match(bind, /\[Number\(online\.id\), shopId, tenantPk\]/);
  assert.match(bind, /SELECT id,product_id FROM sku_mappings[\s\S]*?WHERE shop_id = \? AND ozon_sku = \?[\s\S]*?tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/);
  assert.match(bind, /shopId,\s+ozonSku,\s+tenantPk/);
  assert.match(bind, /SET product_id = \?, tenant_id = \?, offer_id = \?, display_name = \?, active = 1[\s\S]*?WHERE id = \? AND online_product_id = \? AND shop_id = \?[\s\S]*?tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/);
  assert.match(bind, /Number\(existingByOnline\.id\), Number\(online\.id\), shopId, tenantPk/);
  assert.match(bind, /SET product_id = \?, tenant_id = \?, online_product_id = \?, offer_id = \?, display_name = \?, active = 1[\s\S]*?WHERE id = \? AND shop_id = \? AND ozon_sku = \?[\s\S]*?tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/);
  assert.match(bind, /Number\(existing\.id\), shopId, ozonSku, tenantPk/);
  assert.match(bind, /INSERT INTO sku_mappings[\s\S]*?\(shop_id, tenant_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name\)[\s\S]*?VALUES \(\?, \?, \?, NULL, \?, \?, \?, \?\)/);
  assert.match(bind, /shopId,\s+tenantPk,\s+sourceProductId,\s+Number\(online\.id\)/);
});

test("listing inventory retry and manual binding are constrained to the active tenant", () => {
  const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
  const retry = service.match(/export async function retryListingInventoryBindings\([\s\S]*?(?=\nexport async function bindListingRecordToInventory)/)?.[0] || "";
  assert.match(retry, /listingTenantId\(session\)/);
  assert.match(retry, /tenant_id = \? OR tenant_id IS NULL OR tenant_id = ''/);
  assert.match(retry, /const scoped = await all\(`SELECT id FROM listing_publish_records/);

  const bind = service.match(/export async function bindListingRecordToInventory\([\s\S]*?(?=\nfunction buildOzonPublishErrorPayload)/)?.[0] || "";
  assert.match(bind, /listingTenantId\(session\)/);
  assert.match(bind, /SELECT id FROM products WHERE id=\? AND active=1 AND \(tenant_id=\?/);
  assert.match(bind, /发布记录不存在或不属于当前企业/);
  assert.match(bind, /JOIN shops s ON s\.id=op\.shop_id/);
  assert.match(bind, /INSERT INTO sku_mappings \(shop_id,tenant_id,product_id,online_product_id,ozon_sku,offer_id,display_name,active\)/);
  assert.match(bind, /UPDATE order_items oi JOIN orders o ON o\.id=oi\.order_id JOIN shops s ON s\.id=o\.shop_id/);
  assert.match(bind, /s\.tenant_id=\?\$\{defaultTenant \? " OR s\.tenant_id IS NULL" : ""\}/);
});

test("listing inventory binding reads, joins, and sales aggregation are tenant-scoped before routes open", () => {
  const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
  const inventory = service.match(/export async function listingInventoryBindings\([\s\S]*?(?=\nexport async function retryListingInventoryBindings)/)?.[0] || "";
  assert.match(inventory, /const tenantId = listingTenantId\(session\)/);
  assert.match(inventory, /tenant_id = \? OR tenant_id IS NULL OR tenant_id = ''/);
  assert.match(inventory, /LEFT JOIN products p ON p\.id=r\.source_product_id AND \$\{tenantOwnedProductPredicate\("p"\)\}/);
  assert.match(inventory, /LEFT JOIN listing_drafts d ON d\.id=r\.draft_id AND \$\{defaultTenant \? "\(d\.tenant_id = \? OR d\.tenant_id IS NULL OR d\.tenant_id = ''\)" : "d\.tenant_id = \?"\}/);
  assert.match(inventory, /LEFT JOIN online_products op ON os\.id IS NOT NULL/);
  const bindingRows = inventory.slice(0, inventory.indexOf("const representedOnlineIds"));
  assert.equal((bindingRows.match(/tenantOwnedProductPredicate\("sm(?:_sku|_offer)?"\)/g) || []).length, 3);
  assert.match(inventory, /mapped_product_id,\s*0 order_count/);
  assert.match(inventory, /JOIN orders o ON o\.id=oi\.order_id\s*JOIN shops s ON s\.id=o\.shop_id/);

  const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
  assert.match(routeSource, /listingInventoryBindings\(req\.query \|\| \{\}, req\._session\)/);
  assert.match(routeSource, /retryListingInventoryBindings\(await readJson\(req\), req\._session\)/);
  assert.match(routeSource, /bindListingRecordToInventory\(await readJson\(req\), req\._session\)/);
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "inventory-bindings"]],
    ["POST", ["api", "listing", "inventory-bindings", "retry"]],
    ["POST", ["api", "listing", "inventory-bindings", "bind"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "inventory-bindings", "unexpected"], "POST").allowed, false);
});

test("publish refresh helpers propagate the request tenant through quality and inventory writes", () => {
  const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
  const submit = service.match(/async function updatePublishRecordAfterSubmit\([\s\S]*?(?=\nasync function autoBindPublishRecordInventory)/)?.[0] || "";
  const bind = service.match(/async function autoBindPublishRecordInventory\([\s\S]*?(?=\nasync function markPublishRecordInventoryBound)/)?.[0] || "";
  const markBound = service.match(/async function markPublishRecordInventoryBound\([\s\S]*?(?=\nasync function inferHistoricalInventoryBinding)/)?.[0] || "";
  const quality = service.match(/async function refreshPublishRecordQuality\([\s\S]*?(?=\nfunction localQualityFallbackFromRecord)/)?.[0] || "";

  assert.match(submit, /tenantId = ""/);
  assert.match(submit, /WHERE id = \? \$\{tenantRecordScope\}/);
  assert.match(submit, /autoBindPublishRecordInventory\(recordId, tenantId\)/);
  assert.match(bind, /WHERE id = \? AND status <> 'deleted' \$\{tenantRecordScope\}/);
  assert.ok((bind.match(/\$\{tenantRecordScope\}/g) || []).length >= 8);
  assert.match(bind, /markPublishRecordInventoryBound\(recordId, bindingSource, expectedTenantId\)/);
  assert.match(markBound, /COALESCE\(NULLIF\(tenant_id, ''\), 'admin'\) = \?/);
  assert.match(quality, /WHERE r\.id = \? \$\{tenantRecordScope\}/);
  assert.match(quality, /WHERE id = \? \$\{updateTenantScope\}/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serviceSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const inventoryPageSource = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const productDialogSource = fs.readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");
const ordersPageSource = fs.readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const pendingSettlementPageSource = fs.readFileSync(new URL("../frontend/admin/views/profit/PendingSettlementCostsView.vue", import.meta.url), "utf8");

function pendingSettlementSource() {
  const start = serviceSource.indexOf("export async function pendingSettlementCostsMysql");
  const end = serviceSource.indexOf("async function dashboardSnapshotIsStaleMysql", start);
  assert.ok(start >= 0 && end > start, "pending settlement service should exist");
  return serviceSource.slice(start, end);
}

test("pending settlement falls back to active shop and SKU binding", () => {
  const source = pendingSettlementSource();

  assert.match(source, /LEFT JOIN sku_mappings direct_sm[\s\S]*direct_sm\.id = oi\.sku_mapping_id[\s\S]*direct_sm\.shop_id = o\.shop_id[\s\S]*direct_sm\.ozon_sku = oi\.ozon_sku[\s\S]*direct_sm\.active = 1/);
  assert.match(source, /LEFT JOIN sku_mappings fallback_sm[\s\S]*fallback_sm\.shop_id = o\.shop_id[\s\S]*fallback_sm\.ozon_sku = oi\.ozon_sku[\s\S]*fallback_sm\.active = 1/);
  assert.match(source, /COALESCE\(direct_sm\.product_id, fallback_sm\.product_id\) AS mapped_product_id/);
  assert.match(source, /p\.id AS product_id/);
  assert.match(source, /p\.id = COALESCE\(direct_sm\.product_id, fallback_sm\.product_id\)/);
});

test("pending settlement explains binding state, returns images, and reuses order inventory dialogs", () => {
  const source = pendingSettlementSource();
  assert.match(source, /COALESCE\(NULLIF\(oi\.ozon_image_url/);
  assert.match(source, /inventory_binding_status:/);
  assert.match(pendingSettlementPageSource, /openOrderInventoryDialog\(row, 'bind'\)/);
  assert.match(pendingSettlementPageSource, /openOrderInventoryDialog\(row, 'create'\)/);
  assert.match(pendingSettlementPageSource, /ProductImagePreview/);
  assert.match(pendingSettlementPageSource, /size="portrait"/);
  assert.match(ordersPageSource, /routeAction === "bind"/);
  assert.match(ordersPageSource, /handleOpenCreateProductFromOrder\(orderId, routeSku\)/);
});

test("inventory edit is pinned to the existing product and cannot turn it into a selection", () => {
  assert.match(inventoryPageSource, /:edit-product-id="dialogProduct\?\.id \|\| null"/);
  assert.match(productDialogSource, /if \(isEditMode\.value && editProductId <= 0\)/);
  assert.match(productDialogSource, /apiClient\.put\(`\/api\/products\/\$\{editProductId\}`/);
  assert.match(productDialogSource, /selection_status: isInventoryTarget\.value \? "listed"/);
  assert.match(productDialogSource, /product_type: isInventoryTarget\.value \? "main"/);
  assert.match(productDialogSource, /composition_items: form\.composition_items\.map/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const ordersPage = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const component = readFileSync(new URL("../frontend/admin/components/inventory/InventoryStructuredSearch.vue", import.meta.url), "utf8");
const optionCache = readFileSync(new URL("../frontend/admin/utils/inventory-naming-options.js", import.meta.url), "utf8");
const namingService = readFileSync(new URL("../src/services/inventory-product-naming.js", import.meta.url), "utf8");
const listingService = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const listingRoutes = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const productDialog = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");

test("product API combines structured inventory filters", () => {
  for (const field of ["inventoryCategory", "productName", "vehicleBrand", "vehicleModel", "accessoryName", "color", "material", "process"]) {
    assert.match(service, new RegExp(`query\\.${field}`));
  }
  assert.match(service, /p\.inventory_category = \?/);
  assert.match(service, /p\.vehicle_brand = \?/);
  assert.match(service, /COALESCE\(p\.vehicle_model, ''\)/);
  assert.match(service, /p\.accessory_name = \?/);
});

test("inventory and order binding searches share fuzzy and exact modes", () => {
  for (const source of [inventoryPage, ordersPage]) {
    assert.match(source, /InventoryStructuredSearch/);
    assert.match(source, /模糊搜索/);
    assert.match(source, /精确搜索/);
  }
  assert.match(inventoryPage, /searchMode:\s*"exact"/);
  assert.match(ordersPage, /bindProductSearchMode = ref\("exact"\)/);
});

test("structured search reuses controlled naming options and the AI vehicle catalog", () => {
  assert.match(optionCache, /\/api\/inventory-product-naming\/options/);
  assert.match(optionCache, /\/api\/ai-variant-lab\/vehicle-catalog/);
  assert.match(optionCache, /inflightRequests/);
  assert.match(optionCache, /CACHE_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(component, /选择核心品名/);
  assert.match(component, /inventoryCategory/);
  assert.match(component, /vehicleBrand/);
  assert.match(component, /vehicleModel/);
  assert.match(component, /accessoryName/);
  assert.match(component, /optionTypes = \["category", "brand", "vehicle_model", "accessory", "color", "material", "process"\]/);
  assert.match(component, /options\.brand/);
  assert.match(component, /function normalizeVehicleBrandValue/);
  assert.match(component, /replace\(\/\\\|\/g, " "\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(component, /const value = normalizeVehicleBrandValue\(item\.value\)/);
  assert.match(component, /options\.vehicle_model/);
  assert.match(component, /loadOption\("vehicle_model"\)/);
  assert.match(component, /Promise\.allSettled/);
  assert.match(optionCache, /routeScoped:\s*false/);
  assert.match(component, /params\.set\("brand", normalizeVehicleBrandValue\(brand\)\)/);
  assert.match(component, /params\.set\("fitment_type", fitmentType\)/);
  assert.match(component, /params\.set\("vehicle_model", vehicleModels\[0\]\)/);
  assert.match(component, /请先选择核心品名/);
  assert.match(component, /optionLabel\(item\)/);
  assert.match(component, /material/);
  assert.match(component, /process/);
  assert.match(component, /!options\[type\]\.length/);
});

test("structured vehicle brand normalization removes legacy separators before exact matching", () => {
  const normalizedQueryPattern = /String\(query\.vehicleBrand \|\| query\.vehicle_brand \|\| ""\)\.replace\(\/\\\|\/g, " "\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/g;
  assert.equal(service.match(normalizedQueryPattern)?.length, 3);
  assert.match(namingService, /clean\(query\.brand, 255\)\.replace\(\/\\\|\/g, " "\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
});

test("naming option API expands stored material combinations into selectable specification terms", () => {
  assert.match(namingService, /type === "material"[\s\S]*?rawText\.split/);
  assert.match(namingService, /schemaReadyPromise = initializeSchema\(\)/);
  assert.match(namingService, /productCoreNameSchemaReadyPromise = initializeProductCoreNameSchema\(\)/);
});

test("dictionary history is not exposed as the current linked product count", () => {
  assert.match(namingService, /0 AS linked_product_count/);
  assert.match(namingService, /linked_product_count: Number\(row\.linked_product_count \|\| 0\)/);
});

test("every structured naming count uses the same bindable inventory scope", () => {
  assert.match(namingService, /function bindableInventoryProductPredicate/);
  assert.match(namingService, /products\.active = 1.*bindableInventoryProductPredicate\("products"\)/);
  assert.match(namingService, /existing\.linked_product_count \+= Number\(row\.linked_product_count \|\| 0\)/);
  assert.match(namingService, /new Set\(rawValues\.map/);
  assert.match(namingService, /right\.linked_product_count - left\.linked_product_count/);
});

test("inventory creation can save a pre-bound quick listing draft from the dialog header", () => {
  assert.match(productDialog, /#header/);
  assert.match(productDialog, />建草稿<\/el-button>/);
  assert.match(productDialog, /仅保存库存商品，暂不创建上架草稿/);
  assert.match(productDialog, /已存在相同标准产品/);
  assert.match(productDialog, /使用并建草稿/);
  assert.match(productDialog, /submitAndCreateDraft/);
  assert.match(productDialog, /\/api\/listing\/drafts\/from-inventory-product/);
  assert.match(productDialog, /path: "\/listing-records"/);
  assert.match(listingRoutes, /POST \/api\/listing\/drafts\/from-inventory-product/);
  assert.match(listingService, /export async function createInventoryProductListingDraft/);
  assert.match(listingService, /source_product_id = \? AND status = 'draft'/);
  assert.match(listingService, /'inventory_quick_draft'/);
});

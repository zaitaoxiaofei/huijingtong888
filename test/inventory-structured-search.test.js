import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const ordersPage = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const component = readFileSync(new URL("../frontend/admin/components/inventory/InventoryStructuredSearch.vue", import.meta.url), "utf8");

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
});

test("structured search reuses controlled naming options and the AI vehicle catalog", () => {
  assert.match(component, /\/api\/inventory-product-naming\/options/);
  assert.match(component, /\/api\/ai-variant-lab\/vehicle-catalog/);
  assert.match(component, /选择核心品名/);
  assert.match(component, /inventoryCategory/);
  assert.match(component, /vehicleBrand/);
  assert.match(component, /vehicleModel/);
  assert.match(component, /accessoryName/);
  assert.match(component, /optionTypes = \["category", "accessory", "color", "material", "process"\]/);
  assert.match(component, /Promise\.allSettled/);
  assert.match(component, /routeScoped:\s*false/);
  assert.match(component, /params\.set\("brand", brand\)/);
  assert.match(component, /params\.set\("fitment_type", fitmentType\)/);
  assert.match(component, /params\.set\("vehicle_model", vehicleModels\[0\]\)/);
  assert.match(component, /请先选择核心品名/);
  assert.match(component, /optionLabel\(item\)/);
  assert.match(component, /material/);
  assert.match(component, /process/);
  assert.match(component, /!options\[type\]\.length/);
});

test("naming option API expands stored material combinations into selectable specification terms", () => {
  const namingService = readFileSync(new URL("../src/services/inventory-product-naming.js", import.meta.url), "utf8");
  assert.match(namingService, /type === "material"[\s\S]*?rawText\.split/);
  assert.match(namingService, /schemaReadyPromise = initializeSchema\(\)/);
  assert.match(namingService, /productCoreNameSchemaReadyPromise = initializeProductCoreNameSchema\(\)/);
});

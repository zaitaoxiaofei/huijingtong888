import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildShortInventoryName, scoreInventorySimilarity } from "../frontend/admin/utils/inventory-similarity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("standard inventory creation offers existing similar products", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const inventoryPage = read("frontend/admin/views/inventory/InventoryProductsPage.vue");

  assert.match(dialog, /已有相似库存/);
  assert.match(dialog, /matchMode:\s*"any"/);
  assert.match(dialog, /query:\s*form\.structured_naming\.category/);
  assert.match(dialog, /emit\("existing-selected", row\)/);
  assert.match(inventoryPage, /@existing-selected="handleExistingProductSelected"/);
});

test("order inventory creation can bind an existing similar product", () => {
  const ordersPage = read("frontend/orders/OrdersPage.vue");
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const service = read("src/services/mysql-cutover.js");

  assert.match(ordersPage, /inventoryProductEditorCreateContext\.value = \{/);
  assert.match(ordersPage, /image_url:\s*context\.imageUrl/);
  assert.match(ordersPage, /package_weight_g:\s*context\.baseWeightG/);
  assert.match(ordersPage, /:create-endpoint="inventoryProductEditorCreateContext \? '\/api\/online-products\/create-product'/);
  assert.match(ordersPage, /@existing-selected="handleInventoryProductEditorExistingSelected"/);
  assert.match(ordersPage, /\/api\/online-products\/bind/);
  assert.match(dialog, /createEndpoint:\s*\{ type: String, default: "\/api\/products" \}/);
  assert.match(dialog, /apiClient\.post\(props\.createEndpoint/);
  assert.match(service, /const product = await createProductMysql\(\{\s*\.\.\.body,/);
  assert.match(service, /structured_naming:\s*body\.structured_naming \|\| body\.structuredNaming/);
  assert.match(service, /saveStructuredNamingMysql\(productId, body, connection\)/);
  assert.match(service, /if \(!connection\) return mysqlExecute\(sql, params\)/);
});

test("product search supports broad any-token matching without changing the default mode", () => {
  const service = read("src/services/mysql-cutover.js");

  assert.match(service, /const searchMatchMode = String\(query\.matchMode \|\| query\.match_mode/);
  assert.match(service, /if \(searchMatchMode === "any"\)/);
  assert.match(service, /searchClauses\.join\(" OR "\)/);
});

test("similarity requires the same core product and ranks matching attributes", () => {
  const input = {
    coreName: "防踢垫",
    brand: "TENET",
    colors: ["黑色"],
    feature: "带Logo",
    quantity: 4,
    packageMode: "set"
  };
  const relevant = scoreInventorySimilarity({ name: "TENET 通用 后座防踢垫 黑色 4件套" }, input);
  const irrelevant = scoreInventorySimilarity({ name: "TENET T7 黑色 TPU 钥匙保护壳" }, input);

  assert.ok(relevant);
  assert.ok(relevant.score >= 65);
  assert.equal(irrelevant, null);
});

test("short inventory names follow the canonical field order and append a set suffix", () => {
  assert.equal(buildShortInventoryName({
    coreName: "防踢垫",
    vehicleBrand: "TENET",
    vehicleModels: ["T4L", "T4"],
    feature: "带Logo",
    colors: ["黑色"],
    material: "TPU",
    process: "拉丝",
    quantity: 4,
    stockUnit: "个",
    packageMode: "set",
    includedAccessories: "Logo手绳 + 圆环扣",
    giftContents: "刮板"
  }), "防踢垫 TENET T4/T4L 黑色 LOGO定制款 TPU 拉丝 4个 套装");
});

test("fixed components and gifts bind existing inventory instead of accepting free text", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const service = read("src/services/mysql-cutover.js");
  const inventoryPage = read("frontend/admin/views/inventory/InventoryProductsPage.vue");

  assert.doesNotMatch(dialog, /v-model="form\.structured_naming\.included_accessories"/);
  assert.doesNotMatch(dialog, /v-model="form\.structured_naming\.gift_contents"/);
  assert.match(dialog, /v-model="componentRole"/);
  assert.match(dialog, /component_role:\s*item\.component_role === "gift"/);
  assert.match(dialog, /快速创建配件/);
  assert.match(inventoryPage, /@quick-create-component="openQuickComponentCreate"/);
  assert.match(service, /ADD COLUMN component_role/);
  assert.match(service, /INSERT INTO product_components \(product_id, component_product_id, quantity, component_role\)/);
  assert.match(service, /ADD COLUMN included_accessories/);
  assert.match(service, /ADD COLUMN gift_contents/);
  assert.match(service, /AND included_accessories = \? AND gift_contents = \?/);
});

test("inventory create dialog uses a wide compact layout without hiding pricing fields", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");

  assert.match(dialog, /min\(1880px, 99vw\)/);
  assert.equal((dialog.match(/<div class="standard-name-preview standard-name-preview--top">/g) || []).length, 1);
  assert.doesNotMatch(dialog, /<el-form-item label="标准名称"/);
  assert.doesNotMatch(dialog, /<el-form-item label="库存单位"/);
  assert.match(dialog, /可作为单品/);
  assert.match(dialog, /可作为配件/);
  assert.doesNotMatch(dialog, /展开高级字段/);
  assert.match(dialog, /\.composition-section\s*\{\s*order:\s*2/);
  assert.match(dialog, /\.basic-info-section\s*\{\s*order:\s*3/);
  assert.match(dialog, /class="naming-fields-grid"/);
  assert.match(dialog, /grid-template-columns:\s*repeat\(15,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(dialog, /\.naming-field--identity\s*\{\s*grid-column:\s*span 5/);
  assert.match(dialog, /\.naming-field--spec\s*\{\s*grid-column:\s*span 3/);
  assert.match(dialog, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+220px/);
  assert.doesNotMatch(dialog, /<el-col :span="12" v-if="form\.structured_naming\.fitment_type === 'specific'">/);
  assert.match(dialog, /最终标准名称/);
  assert.match(dialog, /1\. 产品身份/);
  assert.match(dialog, /2\. 规格属性/);
  assert.match(dialog, /3\. 库存计量与履约/);
  assert.match(dialog, /<aside class="similar-products-panel"/);
  assert.doesNotMatch(dialog, /if \(!props\.visible \|\| isEditMode\.value\) return/);
  assert.match(dialog, /height:\s*88vh/);
  assert.match(dialog, /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(dialog, /return_rate:\s*5/);
  assert.match(dialog, /<el-col :span="8">\s*<el-form-item label="长\(cm\)">/);
  assert.match(dialog, /<el-col :span="8">\s*<el-form-item label="宽\(cm\)">/);
  assert.match(dialog, /<el-col :span="8">\s*<el-form-item label="高\(cm\)">/);
  assert.doesNotMatch(dialog, /selectionPreviewRows/);
});

test("editing an inventory product restores every structured naming field", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const service = read("src/services/mysql-cutover.js");

  assert.match(service, /p\.inventory_category,\s*p\.fitment_type,\s*p\.accessory_name,\s*p\.product_quantity/);
  assert.match(service, /p\.package_contents, p\.included_accessories, p\.gift_contents/);
  assert.match(service, /structured_naming:\s*\{/);
  assert.match(service, /category:\s*row\.inventory_category/);
  assert.match(service, /vehicle_brand:\s*String\(row\.vehicle_brand/);
  assert.match(service, /vehicle_model:\s*row\.vehicle_model/);
  assert.match(service, /package_mode:\s*row\.package_mode === "set"/);
  assert.match(service, /version_updated_at:\s*normalizeMysqlDateTime\(row\.updated_at\)/);
  assert.match(service, /return body\.version_updated_at \|\| body\.versionUpdatedAt \|\| body\.updated_at/);
  assert.match(dialog, /vehicle_brand:\s*savedNaming\.vehicle_brand/);
  assert.match(dialog, /fitment_type:\s*savedNaming\.fitment_type \|\| value\.fitment_type/);
  assert.match(dialog, /hydrateLegacyStructuredNaming/);
  assert.match(dialog, /if \(!isEditMode\.value && !props\.value\) return/);
  assert.match(dialog, /item\.vehicle_brand = matchedBrand\?\.name/);
  assert.match(dialog, /return String\(form\.name \|\| ""\)\.trim\(\)/);
  assert.match(dialog, /originalName\.match\(\/\(\\d\+\)\\s\*\(个\|件\|套\|对\|双\|条\|片\|张\|盒\)/);
  assert.match(dialog, /if \(!item\.category && candidates\[0\]\) item\.category = candidates\[0\]/);
  assert.match(dialog, /if \(!item\.accessory && candidates\[1\]\) item\.accessory = candidates\[1\]/);
  assert.match(dialog, /const commonColors = \["黑色", "白色", "灰色", "银色"/);
  assert.match(dialog, /type === "color"\s*\?\s*\(Array\.isArray\(item\.colors\)/);
  assert.match(dialog, /type === "quantity"\s*\?\s*\[Number\(item\.quantity \|\| 1\)\]/);
  assert.match(dialog, /:allow-create="canMaintainNamingOptions"/);
});

test("inventory editor loads logistics rules independently and hides merged recommendations", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const service = read("src/services/mysql-cutover.js");

  assert.match(dialog, /loadFallbackLogisticsRules/);
  assert.match(dialog, /apiClient\.get\("\/api\/logistics-rules", \{ noCache: true \}\)/);
  assert.match(dialog, /String\(row\.selection_status \|\| ""\) !== "merged"/);
  assert.match(dialog, /Number\(row\.parent_product_id \|\| 0\) === 0/);
  assert.match(service, /p\.product_type, p\.selection_status, p\.parent_product_id/);
});

test("naming options are controlled while car brand and model reuse the AI catalog", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const namingService = read("src/services/inventory-product-naming.js");

  assert.match(namingService, /type === "accessory" && !category/);
  assert.match(namingService, /ORDER BY usage_count DESC, last_used_at DESC/);
  assert.match(dialog, /handleCategoryChange/);
  assert.match(dialog, /handleVehicleModelsChange/);
  assert.match(dialog, /form\.structured_naming\.accessory = "普通款"/);
  assert.match(dialog, /vehicleBrandOptions/);
  assert.match(dialog, /vehicleModelOptions/);
  assert.match(namingService, /'material', 'process'/);
  assert.match(namingService, /const dictionaryRows = await mysqlQuery/);
  assert.match(namingService, /\['accessory', '普通款', '普通款'\]/);
  assert.match(namingService, /\['material', '不锈钢', '不锈钢'\]/);
  assert.match(namingService, /\['process', '激光', '激光'\]/);
});

test("fixed components use a structured inventory directory and restore bound paths", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const service = read("src/services/mysql-cutover.js");

  assert.match(dialog, /输入核心品名，例如：雨刷、钥匙壳/);
  assert.match(dialog, /class="component-directory"/);
  assert.match(dialog, /componentDirectoryBrands/);
  assert.match(dialog, /componentDirectoryModels/);
  assert.match(dialog, /componentDirectoryAccessories/);
  assert.match(dialog, /namingOptionValues/);
  assert.match(dialog, /条件可按任意顺序输入或选择，组合条件实时筛选/);
  assert.match(dialog, /allow-create default-first-option clearable placeholder="品牌"/);
  assert.match(dialog, /allow-create default-first-option clearable placeholder="颜色"/);
  assert.match(dialog, /componentSearchActive \? '高匹配子产品' : '已有相似库存'/);
  assert.match(dialog, /添加为\{\{ componentRole === 'gift' \? '固定赠品' : '固定组成' \}\}/);
  assert.match(dialog, /v-model:current-page="componentPage"/);
  assert.match(dialog, /v-for="row in pagedComponentOptions"/);
  assert.match(dialog, /while \(rows\.length < total\)/);
  assert.match(service, /p\.inventory_category,\s*p\.vehicle_brand,\s*p\.fitment_type/);
  assert.match(service, /accessory_name:\s*row\.accessory_name/);
  assert.match(service, /p\.inventory_category, p\.vehicle_brand, p\.fitment_type, p\.vehicle_model/);
  assert.match(dialog, /String\(item\.name \|\| ""\)\.toLowerCase\(\)\.includes\(componentDirectory\.category\.toLowerCase\(\)\)/);
});

test("inventory creation can add child products before the main product is saved", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const composition = read("frontend/admin/components/inventory/ProductCompositionDialog.vue");
  const inventoryPage = read("frontend/admin/views/inventory/InventoryProductsPage.vue");

  assert.match(dialog, /<div class="form-section-title">添加子产品<\/div>/);
  assert.doesNotMatch(dialog, /保存后添加子产品/);
  assert.doesNotMatch(dialog, /v-if="false" class="form-section composition-section"/);
  assert.match(dialog, /建品时即可从已有库存选择子产品/);
  assert.match(dialog, /composition_items:\s*form\.composition_items/);
  assert.match(dialog, /defineExpose\(\{ addExternalComponentProduct \}\)/);
  assert.match(dialog, /请选择颜色（可不填）/);
  assert.match(dialog, /canMaintainNamingOptions/);
  assert.match(dialog, /component-product-with-image/);
  assert.match(dialog, /ProductImagePreview :src="row\.image_url" size="small"/);
  assert.match(inventoryPage, /ref="productCreateDialogRef"/);
  assert.match(inventoryPage, /addExternalComponentProduct/);
  assert.match(inventoryPage, /配件库存已创建并加入当前商品/);
  assert.match(composition, /grid-template-areas:\s*"picker current"/);
  assert.match(composition, /\.composition-picker\s*\{\s*grid-area:\s*picker/);
  assert.match(composition, /\.composition-current\s*\{\s*grid-area:\s*current/);
  assert.match(composition, /const optionPageSize = ref\(20\)/);
});

test("switching from edit to create clears identifiers owned by the previous product", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");

  assert.match(dialog, /id: null,\s*selection_id: "",\s*code: ""/);
  assert.match(dialog, /uk_products_selection_id/);
  assert.match(dialog, /系统将自动生成新编号/);
});

test("core product names can be edited globally and unused names can be removed", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const namingService = read("src/services/inventory-product-naming.js");
  const routes = read("src/server/routes/catalog.js");

  assert.match(dialog, /editCoreNameOption/);
  assert.match(dialog, /deleteCoreNameOption/);
  assert.match(dialog, />－<\/el-button>/);
  assert.match(namingService, /export async function updateInventoryProductNamingOption/);
  assert.match(namingService, /SET inventory_category = \?, name = \?/);
  assert.match(namingService, /已绑定 .* 个商品，请先编辑合并，不能直接删除/);
  assert.match(namingService, /SET status = 'archived'/);
  assert.match(routes, /services\.updateInventoryProductNamingOption/);
  assert.match(routes, /services\.deleteInventoryProductNamingOption/);
});

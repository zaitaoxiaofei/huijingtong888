import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backend = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const page = await readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const navigation = await readFile(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");

test("procurement can be created before inventory binding", () => {
  assert.match(backend, /MODIFY COLUMN product_id BIGINT UNSIGNED NULL/);
  assert.match(backend, /raw_name VARCHAR\(255\)/);
  assert.match(backend, /productId \? "bound" : "unbound"/);
  assert.match(backend, /Array\.isArray\(body\.items\)/);
  assert.match(routes, /GET \/api\/procurement\/binding-suggestions/);
});

test("procurement workspace keeps owner, free names, multi-item creation and later binding visible", () => {
  assert.match(navigation, /采购工作台/);
  assert.match(page, /采购负责人/);
  assert.match(page, /采购名称/);
  assert.match(page, /添加商品/);
  assert.match(page, /快速选择库存/);
  assert.match(page, /输入库存 ID 精确查找/);
  assert.match(page, /输入商品名称模糊搜索/);
  assert.match(page, /searchMode: mode/);
  assert.match(page, /创建标准库存并绑定/);
  assert.match(page, /未找到？创建标准库存并绑定/);
  assert.match(page, /库存已创建并绑定到当前采购明细/);
  assert.match(page, /已选用已有库存并绑定到当前采购明细/);
  assert.match(page, /function productPreviewImage/);
  assert.match(page, /:preview-list="\[productPreviewImage\(row\)\]"/);
  assert.match(page, /已登记.*采购，现已进入采购在途/);
  assert.match(page, /系统会把这次确认用于后续推荐/);
});

test("free purchase uses visible direct number inputs and seeds standard inventory creation", () => {
  assert.match(page, /width="min\(1760px, calc\(100vw - 32px\)\)"/);
  assert.match(page, /class="free-purchase-number"[\s\S]*?:controls="false"/);
  assert.match(page, /inputmode="numeric"/);
  assert.match(page, /inputmode="decimal"/);
  assert.match(page, /const quickInventoryCreateValue = computed/);
  assert.match(page, /:value="quickInventoryCreateValue"/);
  assert.match(page, /class="free-purchase-name-preview-image"/);
  assert.match(page, /title="上传库存主图"/);
  assert.match(page, />上传主图<\/span>/);
  assert.match(page, /UploadFilled/);
  assert.match(page, /uploadQuickInventoryImage/);
  assert.match(page, /image_url: String\(item\.image_url \|\| ""\)\.trim\(\)/);
  assert.match(page, /activeItem\.value\.raw_name = selected\.product_name/);
});

test("free purchase hydrates selected inventory and allows price anomaly review", () => {
  assert.match(page, /activeItem\.value\.structured_naming = \{ \.\.\.defaultItem\(\)\.structured_naming, \.\.\.selected\.structured_naming \}/);
  assert.match(page, /activeItem\.value\.historical_unit_cost = Number\(selected\.historical_unit_cost \|\| 0\)/);
  assert.match(page, /activeItem\.value\?\.product_id[\s\S]*?activeItem\.value\.product_name/);
  assert.match(page, /class="bound-inventory-specs"/);
  assert.match(page, /本次采购信息/);
  assert.match(page, /freePurchasePriceChange\(activeItem\) > 0\.1/);
  assert.match(page, /请选择价格异常原因/);
  assert.match(page, /价格异常说明（正常价格可不填）/);
  assert.match(page, /anomaly_reason: freePurchaseAnomalyReason\(item\)/);
});

test("free purchase derives its inventory name from the standard naming fields", () => {
  assert.match(page, /InventoryStructuredSearch layout="inventory-form" simple :show-keyword="false" :show-measurement="true" v-model="activeItemNaming"/);
  assert.match(page, /标准库存名称/);
  assert.match(page, /buildShortInventoryName/);
  assert.match(page, /show-measurement="true"/);
  assert.match(page, /请先完成核心品名和款式/);
  assert.match(page, /structured_naming: \{/);
});

test("procurement workspace keeps high-frequency actions together and automatically searches existing inventory", () => {
  assert.doesNotMatch(page, /<el-button[^>]*>采购与库存对账<\/el-button>/);
  assert.doesNotMatch(page, /<el-button[^>]*>现货成本待核<\/el-button>/);
  assert.doesNotMatch(page, /系统任务采购（/);
  assert.match(page, /<DailyPurchaseExport :filters="state\.filters" \/>/);
  assert.match(page, /fetchQuickInventoryProducts\(text, "name"\)/);
  assert.match(page, /fetchQuickInventoryProducts\(coreName, "name"\)/);
  assert.match(page, /quickInventorySearch\.productName = text/);
  assert.match(page, /product\?\.inventory_number \|\| product\?\.inventory_id/);
});

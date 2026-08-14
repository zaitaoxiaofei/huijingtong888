import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const tableSource = await readFile(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
const compositionSource = await readFile(new URL("../frontend/admin/components/inventory/ProductCompositionDialog.vue", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("bound order inventory products expose the child-product editor beside binding", () => {
  assert.match(tableSource, /修改绑定[\s\S]*emit\('edit-inventory-product', product\.productId\)[\s\S]*编辑库存/);
  assert.match(pageSource, /@edit-inventory-product="\(productId\) => openInventoryProductEditor\(\{ id: productId \}\)"/);
  assert.match(tableSource, /修改绑定[\s\S]*v-if="product\.inventoryMode === 'single' && Number\(product\.productId \|\| 0\) > 0"[\s\S]*绑定子产品/);
  assert.match(tableSource, /emit\('open-product-components', product\.productId\)/);
  assert.match(pageSource, /import ProductCompositionDialog from "\.\.\/admin\/components\/inventory\/ProductCompositionDialog\.vue"/);
  assert.match(pageSource, /@open-product-components="openProductCompositionDialog"/);
  assert.match(tableSource, /绑定子产品[\s\S]*Number\(product\.componentCount \|\| 0\) > 0[\s\S]*查看子产品/);
  assert.match(pageSource, /@view-product-components="viewProductCompositionDialog"/);
  assert.match(pageSource, /:read-only="compositionDialogReadOnly"/);
  assert.match(pageSource, /<ProductCompositionDialog[\s\S]*@saved="handleProductCompositionSaved"[\s\S]*@quick-create="openQuickCreateFromComposition"/);
  assert.match(compositionSource, /ProductImagePreview :src="row\.image_url" size="small"/);
  assert.match(compositionSource, /:preview-src-list|ProductImagePreview/);
  assert.match(serviceSource, /p\.image_url,[\s\S]*image_url:\s*compactProductImageUrlForListMysql/);
});

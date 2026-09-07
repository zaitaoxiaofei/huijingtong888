import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/product-barcode-labels.js", import.meta.url), "utf8");

test("barcode labels load Unicode fonts on Windows and Linux", () => {
  assert.match(source, /process\.env\.BARCODE_LABEL_FONT_PATH/);
  assert.match(source, /Windows\\\\Fonts\\\\Deng\.ttf/);
  assert.match(source, /DroidSansFallbackFull\.ttf/);
  assert.match(source, /usr\/local\/share\/fonts\/ozon\/NotoSansCJKsc-Regular\.otf/);
  assert.match(source, /DejaVuSans\.ttf/);
  assert.match(source, /NotoSans-Regular\.ttf/);
  assert.match(source, /LiberationSans-Regular\.ttf/);
});

test("barcode labels prefer the bound Chinese inventory name at barcode text size", () => {
  assert.match(source, /row\.inventory_name\s*\|\|\s*row\.name/);
  assert.match(source, /p\.name AS inventory_name/);
  assert.match(source, /COALESCE\(op\.product_id/);
  assert.match(source, /sm\.online_product_id = op\.id OR sm\.ozon_sku = op\.ozon_sku/);
  assert.match(source, /const titleSize = barcodeTextSize/);
  assert.doesNotMatch(source, /const skuText =/);
  assert.match(source, /ozon_70x30_inventory_name_v8/);
  assert.match(source, /paddingwidth:\s*0/);
  assert.match(source, /y:\s*30\.5/);
  assert.match(source, /lines\.length >= 2/);
  assert.match(source, /lines\.slice\(0, 2\)\.join\("\\n"\)/);
});

test("barcode labels sanitize text before falling back to WinAnsi Helvetica", () => {
  assert.match(source, /renderBarcodeLabelTitleImage\(rawTitle/);
  assert.match(source, /safePdfText\(rawTitle/);
  assert.match(source, /pdf\.embedPng\(titleImage\.buffer\)/);
});

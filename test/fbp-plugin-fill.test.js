import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue"), "utf8");
const pluginDir = path.join(root, "ozon-erp-collector-plugin");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
const backgroundSource = fs.readFileSync(path.join(pluginDir, "background.js"), "utf8");
const sellerBridgeSource = fs.readFileSync(path.join(pluginDir, "seller-bridge-content.js"), "utf8");

test("FBP replenishment page sends approved quantities to the browser plugin", () => {
  assert.match(pageSource, /OZON_ERP_FBP_FILL_REQUEST/);
  assert.match(pageSource, /item\.approved_qty \|\| item\.requested_qty/);
  assert.match(pageSource, />\s*填入 Ozon\s*</);
});

test("collector plugin bridges ERP FBP tasks to an open Ozon supply draft", () => {
  assert.equal(manifest.version, "1.4.21");
  assert.ok(manifest.content_scripts.some((entry) => entry.js?.includes("erp-bridge-content.js")));
  assert.match(backgroundSource, /seller\.ozon\.ru\/app\/fbp-supply\/create-order/);
  assert.match(backgroundSource, /OZON_ERP_FBP_FILL_REQUEST/);
  assert.match(sellerBridgeSource, /OZON_ERP_FBP_FILL/);
  assert.match(sellerBridgeSource, /findFbpSearchInput/);
  assert.match(sellerBridgeSource, /getBoundingClientRect\(\)\.width >= 240/);
  assert.match(sellerBridgeSource, /请人工填写货位数量并检查后继续/);
  assert.doesNotMatch(sellerBridgeSource, /\.click\(\)[\s\S]{0,100}继续/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue"), "utf8");
const pluginDir = path.join(root, "ozon-erp-collector-plugin");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
const backgroundSource = fs.readFileSync(path.join(pluginDir, "background.js"), "utf8");
const erpBridgeSource = fs.readFileSync(path.join(pluginDir, "erp-bridge-content.js"), "utf8");
const sellerBridgeSource = fs.readFileSync(path.join(pluginDir, "seller-bridge-content.js"), "utf8");

test("FBP replenishment page sends approved quantities to the browser plugin", () => {
  assert.match(pageSource, /OZON_ERP_FBP_FILL_REQUEST/);
  assert.match(pageSource, /item\.approved_qty \|\| item\.requested_qty/);
  assert.match(pageSource, />\s*填入 Ozon\s*</);
});

test("collector plugin bridges ERP FBP tasks to an open Ozon supply draft", () => {
  assert.equal(manifest.version, "1.4.31");
  assert.ok(manifest.content_scripts.some((entry) => entry.js?.includes("erp-bridge-content.js")));
  assert.match(backgroundSource, /seller\.ozon\.ru\/app\/fbp-supply\/create-order/);
  assert.match(backgroundSource, /OZON_ERP_FBP_FILL_REQUEST/);
  assert.match(sellerBridgeSource, /OZON_ERP_FBP_FILL/);
  assert.match(sellerBridgeSource, /findFbpSearchInput/);
  assert.match(sellerBridgeSource, /hasExactSku/);
  assert.match(sellerBridgeSource, /\(\^\|\\\\D\).*\(\?=\\\\D\|\$\)/);
  assert.match(sellerBridgeSource, /function isFbpAddButton/);
  assert.match(sellerBridgeSource, /function findFbpClickableElements/);
  assert.match(sellerBridgeSource, /\[tabindex=\"0\"\]/);
  assert.match(sellerBridgeSource, /root\.querySelectorAll\(['"]svg['"]\)/);
  assert.match(sellerBridgeSource, /button\.parentElement \|\| button/);
  assert.match(sellerBridgeSource, /label === ['"]\+['"]/);
  assert.match(sellerBridgeSource, /querySelector\(['"]svg['"]\)/);
  assert.match(sellerBridgeSource, /setNativeInputValue\(currentSearchInput, ''\)/);
  assert.match(pageSource, /offerId: String\(item\.offer_id/);
  assert.match(sellerBridgeSource, /new Set\(\[sku, offerId\]/);
  assert.match(sellerBridgeSource, /已搜索到商品，但未识别到右侧添加按钮/);
  assert.match(sellerBridgeSource, /FBP_COMPANY_MISMATCH/);
  assert.match(backgroundSource, /OZON_ERP_FBP_CONTEXT/);
  assert.match(sellerBridgeSource, /getBoundingClientRect\(\)\.width >= 240/);
  assert.match(sellerBridgeSource, /复制失败清单/);
  assert.match(pageSource, /需要人工补录/);
  assert.match(pageSource, /copyFailedFbpItems/);
  assert.match(sellerBridgeSource, /FBP_SEARCH_RESULT_TIMEOUT_MS = 4000/);
  assert.match(sellerBridgeSource, /verifySettledFbpResults/);
  assert.match(sellerBridgeSource, /await sleep\(120\)/);
  assert.doesNotMatch(sellerBridgeSource, /\.click\(\)[\s\S]{0,100}继续/);
});

test("ERP bridge reports an invalidated extension context instead of hanging", () => {
  const listeners = {};
  const posted = [];
  const window = {
    location: { origin: "https://erp.hjt888.xyz" },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message, origin) { posted.push({ message, origin }); }
  };
  vm.runInNewContext(erpBridgeSource, { window, chrome: {} });

  assert.doesNotThrow(() => listeners.message({
    source: window,
    data: { type: "OZON_ERP_FBP_FILL_REQUEST", requestId: "request-1", payload: {} }
  }));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.type, "OZON_ERP_FBP_FILL_RESPONSE");
  assert.equal(posted[0].message.response.error, "PLUGIN_CONTEXT_INVALIDATED");
  assert.match(posted[0].message.response.message, /刷新当前 ERP 页面/);
});

test("ERP bridge acknowledges a live extension connection before starting the fill", () => {
  const listeners = {};
  const posted = [];
  let sentMessage = null;
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      sentMessage = message;
      callback({ success: true, results: [] });
    }
  };
  const window = {
    location: { origin: "https://erp.hjt888.xyz" },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message, origin) { posted.push({ message, origin }); }
  };
  vm.runInNewContext(erpBridgeSource, { window, chrome: { runtime } });
  listeners.message({
    source: window,
    data: { type: "OZON_ERP_FBP_FILL_REQUEST", requestId: "request-2", payload: { items: [] } }
  });

  assert.equal(sentMessage.requestId, "request-2");
  assert.deepEqual(posted.map((item) => item.message.type), [
    "OZON_ERP_FBP_BRIDGE_ACCEPTED",
    "OZON_ERP_FBP_FILL_RESPONSE"
  ]);
});

test("collector plugin matches numeric Ozon SKUs with prefixes but not longer SKU numbers", () => {
  const start = sellerBridgeSource.indexOf("function hasExactSku");
  const end = sellerBridgeSource.indexOf("function findVisibleSkuElements", start);
  const hasExactSku = vm.runInNewContext(`(${sellerBridgeSource.slice(start, end).trim()})`);
  assert.equal(hasExactSku({ textContent: "OZN4932862363" }, "4932862363"), true);
  assert.equal(hasExactSku({ textContent: "OZON-SKU-4080902861-S7-V002" }, "4080902861"), true);
  assert.equal(hasExactSku({ textContent: "OZN14932862363" }, "4932862363"), false);
});

test("collector plugin distinguishes the primary Ozon SKU from a similar merchant offer id", () => {
  const start = sellerBridgeSource.indexOf("function hasExactFbpSkuIdentity");
  const end = sellerBridgeSource.indexOf("function findVisibleSkuIdentityElements", start);
  const hasExactFbpSkuIdentity = vm.runInNewContext(`(${sellerBridgeSource.slice(start, end).trim()})`, { hasExactSku: () => false });
  assert.equal(hasExactFbpSkuIdentity({ textContent: "4080902861" }, "4080902861"), true);
  assert.equal(hasExactFbpSkuIdentity({ textContent: "4080902861 Чехол для ключа TENET T4" }, "4080902861"), true);
  assert.equal(hasExactFbpSkuIdentity({ textContent: "OZN4080902861 · mz-20260425-SWZL-001" }, "4080902861"), true);
  assert.equal(hasExactFbpSkuIdentity({ textContent: "4932862386 · OZON-SKU-4080902861-S7-V001" }, "4080902861"), false);
});

test("collector plugin recognizes the unlabeled Ozon search-result plus button without mistaking a quantity stepper", () => {
  const start = sellerBridgeSource.indexOf("function isFbpAddButton");
  const end = sellerBridgeSource.indexOf("function findFbpClickableElements", start);
  const isFbpAddButton = vm.runInNewContext(`(${sellerBridgeSource.slice(start, end).trim()})`);
  const rect = (left, width = 32, height = 32) => ({ left, right: left + width, top: 100, width, height });
  const skuElement = { getBoundingClientRect: () => rect(100, 90, 20) };
  const plusButton = {
    textContent: "",
    title: "",
    className: "ui-icon-button",
    getAttribute: () => "",
    getBoundingClientRect: () => rect(500),
    querySelector: (selector) => selector === "svg" ? {} : null
  };
  const resultRow = { querySelectorAll: () => [] };
  const quantityInput = { disabled: false, readOnly: false, getAttribute: () => "text" };
  const quantityRow = { querySelectorAll: () => [quantityInput] };

  assert.equal(isFbpAddButton(plusButton, skuElement, resultRow, null), true);
  assert.equal(isFbpAddButton(plusButton, skuElement, quantityRow, null), false);
});

test("collector plugin only associates a quantity input with the same compact product row", () => {
  const start = sellerBridgeSource.indexOf("function isSameFbpQuantityRow");
  const end = sellerBridgeSource.indexOf("function findQuantityInputForSku", start);
  const isSameFbpQuantityRow = vm.runInNewContext(`(${sellerBridgeSource.slice(start, end).trim()})`);
  const rect = ({ left, top, width, height }) => ({ left, right: left + width, top, width, height });
  const input = { getBoundingClientRect: () => rect({ left: 620, top: 108, width: 120, height: 32 }) };
  const compactRow = {
    parentElement: null,
    contains: (element) => element === input,
    getBoundingClientRect: () => rect({ left: 80, top: 80, width: 900, height: 92 })
  };
  const skuInRow = {
    parentElement: compactRow,
    contains: () => false,
    getBoundingClientRect: () => rect({ left: 120, top: 110, width: 150, height: 24 })
  };
  assert.equal(isSameFbpQuantityRow(skuInRow, input), true);

  const pageContainer = {
    parentElement: null,
    contains: (element) => element === input,
    getBoundingClientRect: () => rect({ left: 0, top: 0, width: 1400, height: 900 })
  };
  const searchResult = {
    parentElement: pageContainer,
    contains: () => false,
    getBoundingClientRect: () => rect({ left: 120, top: 110, width: 150, height: 24 })
  };
  assert.equal(isSameFbpQuantityRow(searchResult, input), false);
});

test("collector plugin final verification rejects missing rows, wrong quantities, and reused inputs", async () => {
  const start = sellerBridgeSource.indexOf("async function verifySettledFbpResults");
  const end = sellerBridgeSource.indexOf("async function runFbpFill", start);
  const sharedInput = { value: "10" };
  const wrongInput = { value: "5" };
  const inputs = new Map([["A", sharedInput], ["B", sharedInput], ["D", wrongInput]]);
  const verifySettledFbpResults = vm.runInNewContext(`(${sellerBridgeSource.slice(start, end).trim()})`, {
    FBP_FINAL_VERIFY_DELAY_MS: 0,
    sleep: async () => {},
    findQuantityInputForSku: (sku) => inputs.get(sku) || null,
    Map,
    Set,
    Math,
    Number
  });
  const results = await verifySettledFbpResults([
    { success: true, sku: "A", quantity: 10 },
    { success: true, sku: "B", quantity: 10 },
    { success: true, sku: "C", quantity: 8 },
    { success: true, sku: "D", quantity: 6 }
  ]);

  assert.deepEqual(results.map((item) => item.success), [false, false, false, false]);
  assert.match(results[0].message, /同一个数量框/);
  assert.match(results[2].message, /未找到该SKU自己的商品数量行/);
  assert.match(results[3].message, /页面数量为5/);
});

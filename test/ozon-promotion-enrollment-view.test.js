import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/marketing/OzonActionsView.vue", import.meta.url), "utf8");
function harness(post) {
  const state = { storeId: 20, mode: "official", selectedActionId: "123", editValues: { "501": { action_price: 88, currency: "CNY" } }, selectedRowKeys: ["501"] };
  const messages = [], calls = [];
  const context = vm.createContext({ state, visibleProducts: { value: [{ id: 501, currency: "CNY" }] }, selectedAction: { value: {} }, getProductKey: row => String(row.id), getProductId: row => row.id, getFirstSku: row => row.sku, localizeActionTitle: () => "活动", ElMessageBox: { confirm: async () => {} }, ElMessage: { success: text => messages.push(["success", text]), warning: text => messages.push(["warning", text]), error: text => messages.push(["error", text]) }, apiClient: { post: async (url, body) => { calls.push({ url, body }); return post(state); } }, loadProducts: async () => {} });
  for (const name of ["buildSubmitProducts", "hasInvalidSubmitProduct", "submitSelected", "submitSingleProduct"]) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    vm.runInContext(match[0], context);
  }
  return { state, context, messages, calls };
}

test("half price always uses the retail baseline, never the shared limit or prior edit", () => {
  const state = { mode: "official", syncPercent: 50, editValues: {} };
  const rows = [
    { id: 1, price: 200, enrollment_base_price: 200, price_money_verified: true, action_price: 100, currency: "CNY" },
    { id: 2, price: 200, enrollment_base_price: null, price_money_verified: false, action_price: 100 },
    { id: 3, action_price: 100 }
  ];
  const messages = [];
  const context = vm.createContext({ state, visibleProducts: { value: rows }, getProductKey: row => String(row.id),
    updateEditValue: (key, patch) => state.editValues[key] = { ...state.editValues[key], ...patch },
    ElMessage: { warning: message => messages.push(message), success: message => messages.push(message) } });
  vm.runInContext(source.match(/function fillPercentPrice\([^]*?\n\}/)[0], context);
  context.fillPercentPrice();
  context.fillPercentPrice();
  assert.equal(state.editValues["1"].action_price, 100);
  assert.equal(state.editValues["2"], undefined);
  assert.equal(state.editValues["3"], undefined);
  assert.match(messages[0], /2 个缺少有效上架价/);
});

test("official stock is omitted from ordinary promotion writes", async () => {
  const h = harness(async () => ({ success: false, count: 0, failures: [], warnings: [] }));
  h.state.editValues["501"].stock = 888;
  await h.context.submitSelected();
  assert.equal(Object.hasOwn(h.calls[0].body.products[0], "stock"), false);
});

test("a late product page cannot cross activity boundaries or launch another page with a new ID", async () => {
  const calls = [];
  const context = vm.createContext({ state: { mode: "official", storeId: "20", selectedActionId: "123" },
    currentApiCacheScope: () => "session-A", PRODUCT_PAGE_SIZE: 100,
    apiClient: { post: async (url, body) => { calls.push(body); context.state.selectedActionId = "456"; return { result: { products: [{id:501}],total:2,last_id:"next" } }; } } });
  for (const name of ["normalizeProducts", "getProductsCursor", "getProductsHasNext", "fetchProductPage"]) vm.runInContext(source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0], context);
  await assert.rejects(context.fetchProductPage("candidates", 2, { pages:{},cursors:{},pageHasNext:{} }), /活动已切换/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionId, "123");
});

test("late A reads stay ignored after switching A to B to A", async () => {
  let resolveFirst;
  let requestNumber = 0;
  const oldPager = { current:1,pages:{1:[{id:501}]} };
  const freshPager = { current:1,pages:{1:[{id:502}]} };
  const context = vm.createContext({ state: { mode:"official",storeId:"20",selectedActionId:"123",productPagers:{},editValues:{} },
    productRequestVersion:0,currentApiCacheScope:()=>"session-A", createEmptyProductPager:()=>({pages:{}}),
    fetchProductPage: async () => ++requestNumber === 1 ? new Promise(resolve=>resolveFirst=resolve) : {pager:freshPager,fetchedRows:[]},
    getPagerRows:pager=>pager.pages?.[1]||[],mergeRowsIntoEditValues:()=>{},ElMessage:{error:()=>{}},resetProducts:()=>{} });
  vm.runInContext(source.match(/async function loadProducts\([^]*?\n\}/)[0], context);
  const first = context.loadProducts();
  context.state.selectedActionId="456";
  const second = context.loadProducts();
  await second;
  context.state.selectedActionId="123";
  const third=context.loadProducts();
  await third;
  resolveFirst({pager:oldPager,fetchedRows:[]});
  await first;
  assert.equal(context.state.productPagers.candidates.pages[1][0].id, 502);
});

test("failed refresh clears loading and stale pages while preserving confirmed operation results", async () => {
  const outcome = {success:false,count:1,failures:[{product_id:502,reason:"rejected"}]};
  const context=vm.createContext({state:{mode:"official",storeId:"20",selectedActionId:"123",productPagers:{},editValues:{},enrollmentResult:outcome},
    productRequestVersion:0,currentApiCacheScope:()=>"session-A",createEmptyProductPager:()=>({pages:{}}),
    fetchProductPage:async()=>{throw Error("refresh unavailable");},ElMessage:{error:()=>{}}});
  for(const name of ["resetProducts","loadProducts"]) vm.runInContext(source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0],context);
  await context.loadProducts({loadBoth:true});
  assert.equal(context.state.productsLoading,false);
  assert.equal(context.state.enrollmentResult,outcome);
  assert.deepEqual(Object.keys(context.state.productPagers.candidates.pages),[]);
});

for (const method of ["submitSelected", "submitSingleProduct"]) {
  test(`${method} submits explicit currency and preserves partial official outcomes`, async () => {
    const outcome = { success: false, count: 0, failures: [{ product_id: 501, reason: "rejected" }], warnings: [] };
    const h = harness(async () => outcome);
    await h.context[method]({ id: 501 });
    assert.equal(h.calls[0].body.products[0].currency, "CNY");
    assert.equal(h.calls[0].body.confirmSharedPrice, true);
    assert.equal(h.state.enrollmentResult, outcome);
    assert.equal(h.messages[0][0], "warning");
  });
  test(`${method} keeps uncertainty visible and ignores a response from another shop`, async () => {
    const h = harness(async () => { throw new Error("timeout"); });
    await h.context[method]({ id: 501 });
    assert.equal(h.state.enrollmentResult.success, false);
    assert.match(h.state.enrollmentResult.failures[0].reason, /timeout/);
    const late = harness(async state => { state.storeId = 30; return { success: true, count: 1 }; });
    await late.context[method]({ id: 501 });
    assert.equal(late.state.enrollmentResult, null);
    assert.equal(late.messages.length, 0);
  });
  test(`${method} cannot submit old product selections after switching shop during confirmation`, async () => {
    const h = harness(async () => ({ success: true, count: 1 }));
    h.context.ElMessageBox.confirm = async () => { h.state.storeId = 30; };
    await h.context[method]({ id: 501 });
    assert.equal(h.calls.length, 0);
  });
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/inventory/OnlineProductsView.vue", import.meta.url), "utf8");
const declaration = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
function fixture(result) {
  const messages = [], posts = [];
  const context = vm.createContext({
    state: { selectedIds: [11, 12] }, stockTargetIds: {value:[11,12]}, stockDialogVersion:0, stockForm: { shop_id: "20", warehouse_id: "3", stock: 888 },
    stockSubmitting: { value: false }, stockUpdateResult: { value: null }, stockDialogVisible: { value: true },
    warehousesLoading: { value: false }, warehousesError: { value: "" }, currentApiCacheScope: () => "tenant-A",
    apiClient: { post: async (url, body) => { posts.push(body); return result; } }, loadPageData: async () => {},
    ElMessage: Object.fromEntries(["success", "warning", "error"].map(type => [type, text => messages.push({ type, text })]))
  });
  vm.runInContext(declaration("submitBatchStock"), context);
  return { context, messages, posts };
}

test("batch stock preserves partial receipts and does not claim every selected product changed", async () => {
  const f = fixture({ results: [{ online_product_id: 11, accepted: true }, { online_product_id: 12, accepted: false, errors: [{ message: "blocked" }] }] });
  await f.context.submitBatchStock();
  assert.equal(f.context.stockUpdateResult.value.accepted, 1);
  assert.equal(f.context.stockUpdateResult.value.failed, 1);
  assert.equal(f.context.stockDialogVisible.value, true);
  assert.equal(f.messages[0].type, "warning");
  assert.match(f.messages[0].text, /实际库存以同步结果为准/);
  assert.deepEqual(Array.from(f.context.stockTargetIds.value), [12]);
  f.context.state.selectedIds = [];
  await f.context.submitBatchStock();
  assert.deepEqual(Array.from(f.posts[1].online_product_ids), [12]);
});

test("missing, duplicate and unrelated receipts cannot imply success", async () => {
  for (const result of [{ target_count: 2 }, { results: [{ online_product_id: 999, accepted: true }] }, { results: [{ online_product_id: 11, accepted: true }, { online_product_id: 11, accepted: true }] }]) {
    const f = fixture(result);
    await f.context.submitBatchStock();
    assert.equal(f.context.stockUpdateResult.value.accepted, 0);
    assert.equal(f.context.stockUpdateResult.value.failed, 2);
    assert.equal(f.messages[0].type, "warning");
  }
});

test("stock updates reject fractional quantities and stale enterprise responses", async () => {
  const f = fixture({});
  f.context.stockForm.stock = 1.2;
  await f.context.submitBatchStock();
  assert.equal(f.posts.length, 0);
  const stale = fixture({ results: [{ online_product_id: 11, accepted: true }] });
  let scope = "tenant-A";
  stale.context.currentApiCacheScope = () => scope;
  stale.context.apiClient.post = async () => { scope = "tenant-B"; return {}; };
  await stale.context.submitBatchStock();
  assert.equal(stale.messages.length, 0);
  assert.equal(stale.context.stockUpdateResult.value, null);
});

test("batch stock opens with every status so zero stock without a SKU remains inspectable", () => {
  const context = vm.createContext({ route: { name: "batch-stock-update" } });
  vm.runInContext(declaration("defaultStatusFilter"), context);
  assert.equal(context.defaultStatusFilter(), "all");
});

test("warehouse cache and late responses stay within the current login scope", async () => {
  let scope = "login-A", resolveOld;
  let calls = 0;
  const context = vm.createContext({
    warehouseRequestVersion:0,currentApiCacheScope:()=>scope,authStore:{user:{tenant:{id:2}}},warehouseCacheByShop:new Map(),
    stockForm:{shop_id:"20",warehouse_id:""},state:{warehouses:[]},warehousesError:{value:""},warehousesLoading:{value:false},
    ElMessage:{error:()=>{}},apiClient:{get:async()=>({warehouses:[{warehouse_id:++calls}]})}
  });
  vm.runInContext(declaration("loadWarehousesForStock"),context);
  await context.loadWarehousesForStock(20);
  scope="login-B";
  await context.loadWarehousesForStock(20);
  assert.equal(calls,2,"new login must fetch its own list even for the same enterprise/shop");
  context.apiClient.get=async()=>new Promise(resolve=>resolveOld=resolve);
  const old=context.loadWarehousesForStock(20,true);
  scope="login-C";
  context.apiClient.get=async()=>({warehouses:[{warehouse_id:3}]});
  await context.loadWarehousesForStock(20);
  resolveOld({warehouses:[{warehouse_id:99}]});
  await old;
  assert.equal(context.stockForm.warehouse_id,"3");
});

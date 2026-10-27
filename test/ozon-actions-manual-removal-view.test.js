import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/marketing/OzonActionsView.vue", import.meta.url), "utf8");
function declaration(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `Missing actual view handler ${name}`);
  return match[0];
}

function fixture({ payload, mode = "official", refreshError } = {}) {
  const rows = [{ product_id: 11, sku: 101, add_mode: "SELLER" }, { product_id: 12, sku: 102, add_mode: "AUTO" }];
  const calls = { posts: [], confirms: [], messages: [], refreshes: [] };
  const context = vm.createContext({
    state: { mode, storeId: "1", selectedActionId: "22", selectedRowKeys: ["11", "12"], productScope: "joined", submitting: false, removalResult: null },
    visibleProducts: { value: rows }, selectedAction: { value: { title: "测试活动" } },
    localizeActionTitle: (row) => row.title,
    apiClient: { post: async (path, body) => { calls.posts.push({ path, body }); if (payload instanceof Error) throw payload; return payload; } },
    ElMessageBox: { confirm: async (text, title, options) => calls.confirms.push({ text, title, options }) },
    ElMessage: Object.fromEntries(["success", "warning", "error"].map((type) => [type, (text) => calls.messages.push({ type, text })])),
    loadProducts: async (options) => { calls.refreshes.push(options); if (refreshError) throw refreshError; context.state.productScope = "candidates"; }
  });
  for (const name of ["getOfferId", "getProductKey", "getProductId", "getFirstSku", "buildManualRemovalResult", "removeSelected"]) vm.runInContext(declaration(name), context);
  return { context, calls, rows };
}

test("manual official removal confirms shared-price impact and allows explicitly selected seller enrollment", async () => {
  const f = fixture({ payload: { success: true, count: 2, removedProductIds: [11, 12], failedProductIds: [], warnings: [], apiVersion: "v1" } });
  await f.context.removeSelected();
  assert.match(f.calls.confirms[0].text, /统一活动限价可能影响.*其他官方活动/);
  assert.match(f.calls.confirms[0].text, /不修改商品零售价/);
  assert.equal(f.calls.posts[0].body.confirmSharedPrice, true);
  assert.deepEqual(Array.from(f.calls.posts[0].body.products, (row) => row.product_id), [11, 12]);
  assert.equal(f.calls.messages[0].type, "success");
  assert.equal(f.context.state.removalResult.confirmedCount, 2);
  assert.equal(f.context.state.removalResult.failedCount, 0);
  assert.equal(f.calls.refreshes[0].requireJoined, true);
  assert.equal(f.context.state.productScope, "joined");
  assert.equal(f.context.state.submitting, false);
});

test("manual official partial response reports verified counts and keeps per-product reasons", async () => {
  const f = fixture({ payload: {
    success: false, count: 1, removedProductIds: [11], failedProductIds: [12], error: "一个商品仍在活动中",
    warnings: ["统一限价已更新，等待官方生效"], result: { rejected: [{ product_id: 12, reason: "官方复查仍存在" }] }
  } });
  await f.context.removeSelected();
  assert.equal(f.calls.messages[0].type, "warning");
  assert.match(f.calls.messages[0].text, /1 个商品，1 个尚未确认退出/);
  assert.equal(f.calls.messages.some((message) => message.type === "success"), false);
  const result = f.context.state.removalResult;
  assert.deepEqual(Array.from(result.failedProductIds), [12]);
  assert.equal(result.rejected[0].reason, "官方复查仍存在");
  assert.equal(result.error, "一个商品仍在活动中");
  assert.equal(result.warnings[0], "统一限价已更新，等待官方生效");
  assert.equal(f.calls.refreshes.length, 1);
});

test("HTTP 200 does not confirm exits without read-back product identities", async () => {
  for (const payload of [
    { success: false, count: 0, removedProductIds: [], failedProductIds: [11, 12] },
    { success: true, count: 2, removedProductIds: [11] },
    { success: true, count: 1, removedProductIds: [999] },
    { success: true, count: 1, removedProductIds: [11], failedProductIds: [11, 12] },
    { result: { product_ids: [11, 12] } }
  ]) {
    const f = fixture({ payload });
    await f.context.removeSelected();
    assert.equal(f.context.state.removalResult.confirmedCount, 0);
    assert.equal(f.context.state.removalResult.failedCount, 2);
    assert.equal(f.calls.messages[0].type, "error");
    assert.equal(f.calls.refreshes.length, 1);
  }
});

test("verified full removal with a warning remains visible without a false clean-success toast", async () => {
  const f = fixture({ payload: { success: true, count: 2, removedProductIds: [11, 12], failedProductIds: [], warnings: ["分页总数与实扫不一致，已核验退出"] } });
  await f.context.removeSelected();
  assert.equal(f.calls.messages[0].type, "warning");
  assert.equal(f.context.state.removalResult.confirmedCount, 2);
  assert.equal(f.context.state.removalResult.warnings.length, 1);
});

test("official HTTP errors still refresh real participation and preserve the original reason", async () => {
  const f = fixture({ payload: new Error("unified price API error") });
  await f.context.removeSelected();
  assert.equal(f.calls.messages[0].type, "error");
  assert.equal(f.calls.refreshes.length, 1);
  assert.equal(f.context.state.removalResult.error, "unified price API error");
  assert.equal(f.context.state.removalResult.failedCount, 2);
  assert.equal(f.context.state.submitting, false);
});

test("a post-removal refresh failure preserves verified outcome and identifies stale displayed data", async () => {
  const f = fixture({ payload: { success: false, count: 1, removedProductIds: [11], failedProductIds: [12] }, refreshError: new Error("official read timed out") });
  await f.context.removeSelected();
  assert.equal(f.context.state.removalResult.confirmedCount, 1);
  assert.match(f.context.state.removalResult.refreshError, /列表刷新失败，当前列表尚未更新/);
  assert.equal(f.context.state.productScope, "joined");
  assert.equal(f.context.state.submitting, false);
});

test("missing official product identity stops before confirmation and external mutation", async () => {
  const f = fixture();
  f.rows[0].product_id = undefined;
  f.context.state.selectedRowKeys = ["unknown", "12"];
  await f.context.removeSelected();
  assert.equal(f.calls.confirms.length, 0);
  assert.equal(f.calls.posts.length, 0);
  assert.equal(f.calls.messages[0].type, "warning");
  assert.match(f.calls.messages[0].text, /商品 ID/);
});

test("seller-created promotion removal retains its existing raw-response flow and needs no shared-price consent", async () => {
  const f = fixture({ mode: "seller", payload: { result: true } });
  f.context.state.selectedRowKeys = ["101", "102"];
  await f.context.removeSelected();
  assert.doesNotMatch(f.calls.confirms[0].text, /统一活动限价/);
  assert.equal(Object.hasOwn(f.calls.posts[0].body, "confirmSharedPrice"), false);
  assert.equal(f.calls.messages[0].type, "success");
  assert.match(f.calls.messages[0].text, /已移除 2 个商品/);
  assert.equal(f.context.state.removalResult, null);
  assert.equal(f.calls.refreshes[0].requireJoined, false);
  assert.equal(f.context.state.productScope, "candidates");
});

test("seller raw HTTP failure preserves its existing no-refresh behavior", async () => {
  const f = fixture({ mode: "seller", payload: new Error("seller error") });
  f.context.state.selectedRowKeys = ["101", "102"];
  await f.context.removeSelected();
  assert.equal(f.calls.messages[0].type, "error");
  assert.equal(f.calls.refreshes.length, 0);
});

test("strict post-removal reads cannot convert a joined-list failure into an empty successful list", async () => {
  const originalPagers = { candidates: { old: true }, joined: { old: true } };
  const calls = { reset: 0 };
  const context = vm.createContext({
    state: { storeId: "1", selectedActionId: "2", productPagers: originalPagers, selectedRowKeys: [] },
    createEmptyProductPager: () => ({}),
    fetchProductPage: async (scope) => { if (scope === "joined") throw new Error("joined list unavailable"); return { pager: {}, fetchedRows: [] }; },
    ElMessage: { error: () => {} }, resetProducts: () => { calls.reset++; }
  });
  vm.runInContext(declaration("loadProducts"), context);
  await assert.rejects(context.loadProducts({ loadBoth: true, requireJoined: true }), /joined list unavailable/);
  assert.equal(context.state.productPagers, originalPagers);
  assert.equal(calls.reset, 0);
  assert.equal(context.state.productsLoading, false);
});

test("fresh participation totals override stale activity summaries without guessing an absent total", async () => {
  for (const [total, expected] of [[1, 1], [0, 0], [null, 23], [undefined, 23]]) {
    const context = vm.createContext({
      PRODUCT_PAGE_SIZE: 100, state: { mode: "official", storeId: "1", selectedActionId: "2" },
      apiClient: { post: async () => ({ result: { products: [], last_id: "", total } }) }
    });
    for (const name of ["normalizeProducts", "getProductsCursor", "getProductsHasNext", "getPagerRows", "fetchProductPage", "getPagerDisplayTotal"]) vm.runInContext(declaration(name), context);
    const result = await context.fetchProductPage("joined", 1, { current: 1, pageSize: 100, pages: {}, cursors: {}, pageHasNext: {} });
    assert.equal(context.getPagerDisplayTotal(result.pager, 23), expected);
  }
});

test("removal result details expose remaining identities and reasons while keeping the existing pagination notice", () => {
  assert.match(source, /state\.removalResult\.failedProductIds\.join/);
  assert.match(source, /item in state\.removalResult\.rejected/);
  assert.match(source, /detail\.paginationWarning/);
  assert.match(source, /key === "MANUAL" \|\| key === "SELLER"/);
});

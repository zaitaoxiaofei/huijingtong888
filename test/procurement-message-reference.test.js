import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
function harness() {
  const requests = [], navigations = []; let scope = "a", watcher;
  const context = vm.createContext({ Number, Date, AbortController, disposed: false, ref: value => ({ value }),
    route: { query: {} }, router: { replace: async target => { navigations.push(target); } }, currentApiCacheScope: () => scope,
    watch: (get, run) => { watcher = { get, run }; },
    apiClient: { get: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) }
  });
  vm.runInContext(page.slice(page.indexOf("const messageRequestVisible"), page.indexOf("const submitting")), context);
  const read = expression => vm.runInContext(expression, context);
  return { requests, navigations, read, watcher: () => watcher, changeScope: () => { scope = "b"; }, run: value => context.openMessageRequest(value), reset: () => context.resetMessageRequest(), close: () => context.closeMessageRequest() };
}

test("procurement message route loads the exact read-only reference instead of relying on pending demand rows", async () => {
  const h = harness();
  const load = h.run("81");
  assert.equal(h.requests[0].url, "/api/enterprise/messages/reference?type=procurement&id=81");
  h.requests[0].resolve({ record: { id: 81, status: "cancelled", product_name: "历史需求" } }); await load;
  assert.equal(h.read("messageRequestRecord.value.id"), 81);
  assert.equal(h.read("messageRequestStatus(messageRequestRecord.value.status)"), "已取消");
  assert.equal(h.read("messageRequestLoading.value"), false);
  assert.ok(h.watcher());
});

test("late reference responses cannot overwrite another record or survive enterprise switching", async () => {
  const h = harness();
  const first = h.run(81), second = h.run(82);
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[1].resolve({ record: { id: 82 } }); await second;
  h.requests[0].resolve({ record: { id: 81 } }); await first;
  assert.equal(h.read("messageRequestRecord.value.id"), 82);
  const switched = h.run(83); h.changeScope(); h.reset();
  h.requests[2].resolve({ record: { id: 83 } }); await switched;
  assert.equal(h.read("messageRequestRecord.value"), null);
  assert.equal(h.read("messageRequestVisible.value"), false);
});

test("invalid and forbidden record IDs expose no business detail", async () => {
  const h = harness();
  await h.run("not-an-id"); assert.equal(h.requests.length, 0);
  const load = h.run(99); h.requests[0].reject(new Error("当前采购需求暂不可访问")); await load;
  assert.equal(h.read("messageRequestRecord.value"), null);
  assert.equal(h.read("messageRequestError.value"), "当前采购需求暂不可访问");
});

test("closing a linked procurement summary removes only its query so the same link can reopen", () => {
  const h = harness();
  h.read("route.query = { message_request_id: '81', review_product_id: '12' }");
  h.close();
  assert.equal(h.read("messageRequestVisible.value"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)), [{ query: { review_product_id: "12" } }]);
});

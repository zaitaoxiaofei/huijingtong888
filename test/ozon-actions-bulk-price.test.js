import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/marketing/OzonActionsView.vue", import.meta.url), "utf8");

test("official Ozon activities can fill a fixed price for only selected products", () => {
  assert.match(source, /bulkActionPrice: undefined/);
  assert.match(source, /function fillSelectedActionPrice\(\)/);
  assert.match(source, /const rows = visibleProducts\.value\.filter\(\(row\) => state\.selectedRowKeys\.includes\(getProductKey\(row\)\)\)/);
  assert.match(source, /action_price: Number\(price\.toFixed\(2\)\)/);
  assert.match(source, /v-if="state\.mode === 'official'"/);
  assert.match(source, /aria-label="批量活动价"/);
  assert.match(source, />批量填活动价<\/el-button>/);
});

test("enterprise activity work uses the scoped cleanup API instead of the platform scheduler", async () => {
  const fn = source.match(/async function runAllCleanupNow\(\) \{[\s\S]*?\n\}/)[0];
  const calls = [];
  const context = vm.createContext({
    state: {},
    ElMessageBox: { confirm: async () => {} },
    ElMessage: { info: () => {}, success: () => {}, error: () => {} },
    apiClient: { post: async (url, body) => { calls.push({ url, body }); return { success: true, configs: [], results: [], failed: 0, count: 0 }; } }
  });
  vm.runInContext(fn, context);
  await context.runAllCleanupNow();
  assert.equal(calls[0].url, "/api/ozon/actions/cleanup-run-all");
  assert.deepEqual(Object.keys(calls[0].body), []);
  assert.doesNotMatch(fn, /scheduled-jobs|canRunGlobalCleanup/);
});

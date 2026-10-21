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

test("ordinary enterprise users keep activity work but cannot invoke the global scheduler action", async () => {
  const fn = source.match(/async function runAllCleanupNow\(\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ canRunGlobalCleanup: { value: false } });
  vm.runInContext(fn, context);
  await context.runAllCleanupNow();
  assert.match(source, /<el-button v-if="canRunGlobalCleanup"[^>]+@click="runAllCleanupNow"/);
});

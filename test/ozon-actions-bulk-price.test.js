import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

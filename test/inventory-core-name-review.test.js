import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/inventory-product-naming.js", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/server/routes/catalog.js", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");

test("pending core-name applications are restricted to the naming maintainer", () => {
  assert.match(service, /status === "pending"/);
  assert.match(service, /仅核动力牛马可以查看待审核核心品名/);
  assert.match(service, /o\.status = 'pending'/);
  assert.match(route, /inventoryProductNamingOptions\([\s\S]*req\._session/);
});

test("inventory product dialog exposes approve and reject actions to the maintainer", () => {
  assert.match(dialog, /v-if="canMaintainNamingOptions" class="core-name-review-panel"/);
  assert.match(dialog, /核心品名审批/);
  assert.match(dialog, /approveCoreName\(item\)/);
  assert.match(dialog, /rejectCoreName\(item\)/);
  assert.match(dialog, /status=pending/);
});

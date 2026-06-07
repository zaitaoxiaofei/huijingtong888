import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storeSource = readFileSync(new URL("../frontend/admin/stores/workspaceTabs.js", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");

test("workspace tabs use workbenchId as the stable key for workbench pages", () => {
  assert.match(storeSource, /function normalizeWorkbenchTabKey\(route\)/);
  assert.match(storeSource, /workbenchId=\$\{encodeURIComponent\(workbenchId\)\}/);
  assert.match(storeSource, /route\.meta\?\.tabKey === "workbench"/);
  assert.match(storeSource, /function dedupeTabsByKey\(tabs\)/);
  assert.match(storeSource, /dedupeTabsByKey\(restoredTabs\)/);
  assert.match(routerSource, /name: "collector-box"[\s\S]*?tabKey: "workbench"/);
  assert.match(routerSource, /name: "listing-automation"[\s\S]*?tabKey: "workbench"/);
  assert.match(routerSource, /name: "selection"[\s\S]*?tabKey: "workbench"/);
});

test("left navigation reuses fixed workbench ids instead of opening random duplicate pages", () => {
  assert.match(layoutSource, /const NAV_WORKBENCH_IDS = new Map/);
  assert.match(layoutSource, /\["\/collector-box", "colwb-main"\]/);
  assert.match(layoutSource, /const navWorkbenchId = NAV_WORKBENCH_IDS\.get\(target\);/);
  assert.match(layoutSource, /workbenchId: navWorkbenchId/);
  assert.doesNotMatch(layoutSource, /function createAiWorkbenchId\(\)/);
});

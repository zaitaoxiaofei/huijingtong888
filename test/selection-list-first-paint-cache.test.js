import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const selectionSource = readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");

test("selection pool restores a fresh page snapshot before background refresh", () => {
  assert.match(selectionSource, /const SELECTION_LIST_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(selectionSource, /const SELECTION_LIST_CACHE_MAX_ENTRIES = 30/);
  assert.match(selectionSource, /const selectionListCache = new Map\(\)/);
  assert.match(selectionSource, /if \(hasFreshCache\) \{/);
  assert.match(selectionSource, /cacheSelectionList\(requestUrl, products\)/);
});

test("listing workbench mounts heavy editors only when opened", () => {
  assert.match(listingSource, /defineAsyncComponent\(\(\) => import\("\.\.\/\.\.\/components\/listing\/OzonRichContentEditor\.vue"\)\)/);
  assert.match(listingSource, /<OzonRichContentEditor\s+v-if="richEditorVisible"/);
  assert.match(listingSource, /<el-dialog v-if="variantVideoEditor\.visible"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");

test("listing workbench avoids deep snapshot tracking during variant edits", () => {
  assert.match(source, /function trackListingWorkbenchEdit\(\)\s*\{\s*scheduleListingWorkbenchDraftSave\(\);/);
  assert.match(source, /<div class="copy-page" @input\.capture="trackListingWorkbenchEdit" @change\.capture="trackListingWorkbenchEdit" @click\.capture="trackListingWorkbenchEdit">/);
  assert.match(source, /\(\) => \[state\.step, state\.selectedCopyJobId, state\.selectedDraftId\],\s*scheduleListingWorkbenchDraftSave/);
  assert.doesNotMatch(source, /createListingWorkbenchDraftDependencies/);
  assert.match(source, /\}, 1500\);/);
});

test("listing workbench renders large variant sets a page at a time", () => {
  assert.match(source, /const VARIANT_TABLE_PAGE_SIZE = 25;/);
  assert.match(source, /const variantPageRows = computed\(\(\) => \{/);
  assert.match(source, /:data="variantPageRows"/);
  assert.match(source, /<el-table-column type="selection" width="46" fixed="left" reserve-selection \/>/);
  assert.match(source, /function variantTableIndex\(index\)/);
  assert.match(source, /@click="removeVariantRow\(row\)"/);
  assert.match(source, /v-model:current-page="variantTablePage"/);
});

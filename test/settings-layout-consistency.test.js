import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("frontend/admin/views/settings/SettingsView.vue"),
  "utf8"
);

test("basic settings sections use the shared system page structure", () => {
  assert.match(source, /class="page-card settings-nav-card"/);
  assert.match(source, /class="settings-tabs"/);
  assert.equal((source.match(/class="page-card settings-list-card"/g) || []).length, 6);
  assert.equal((source.match(/class="filter-panel"/g) || []).length, 5);
  assert.equal((source.match(/class="erp-data-table/g) || []).length >= 6, true);
});

test("basic settings no longer renders its former bespoke workbench layout", () => {
  const template = source.slice(source.indexOf("<template>"), source.indexOf("<style scoped>"));
  assert.doesNotMatch(template, /settings-hero-card/);
  assert.doesNotMatch(template, /settings-section-card/);
  assert.doesNotMatch(template, /shop-config-workbench/);
  assert.doesNotMatch(template, /shop-config-metrics/);
  assert.doesNotMatch(template, /section-head compact/);
});

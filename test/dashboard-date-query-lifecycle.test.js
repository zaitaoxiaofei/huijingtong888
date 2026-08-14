import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");

test("dashboard waits for its date route update before loading the selected day", () => {
  assert.match(source, /await router\.replace[\s\S]*?await loadDashboard\(\{ dateKey: next \}\)/);
  assert.match(source, /const requestSeq = \+\+dashboardRequestSeq/);
  assert.match(source, /requestSeq !== dashboardRequestSeq \|\| dateKey !== selectedDate\.value/);
});

test("dashboard date requests survive internal date query changes", () => {
  assert.match(source, /apiClient\.get\(url, \{[\s\S]*?routeScoped: false/);
  assert.match(source, /online-products\/limits", \{ noCache: true, routeScoped: false \}/);
});

test("dashboard clears the previous day while a new date snapshot is loading", () => {
  assert.match(source, /selectedDate\.value = next;[\s\S]*?dashboard\.value = \{[\s\S]*?summary: \{\}/);
  assert.match(source, /snapshotBuilding\.value = res\?\.snapshot\?\.status === "building"/);
});

test("dashboard uses a compact calendar date control", () => {
  assert.match(source, /class="dashboard-date-control"/);
  assert.match(source, /<el-date-picker[\s\S]*?@change="applyDashboardDate"/);
  assert.doesNotMatch(source, /<ErpPeriodSwitcher/);
});

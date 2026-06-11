import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/advertising/AdvertisingDailyView.vue", import.meta.url), "utf8");

test("advertising daily view keeps first paint list loading lightweight", () => {
  assert.doesNotMatch(source, /pageSize:\s*"1000"/);
  assert.match(source, /pageSize: String\(options\.pageSize \?\? state\.pageSize\)/);
  assert.match(source, /const \[listPayload, summaryPayload\] = await Promise\.all/);
  assert.doesNotMatch(source, /const \[listPayload, summaryPayload, detailsPayload, qualityPayload\] = await Promise\.all/);
  assert.match(source, /void loadQualitySnapshot\(\)/);
  assert.match(source, /if \(activeTab\.value === "insights"\) void loadTrendRows\(\)/);
  assert.match(source, /watch\(activeTab, \(tab\) => \{/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { getAnalyticsPeriodDateRange } from "../frontend/admin/utils/analytics-date-range.js";

test("seller analytics rolling presets display the same completed Beijing days as collection", () => {
  const now = new Date("2026-08-03T16:30:00.000Z");

  assert.deepEqual(getAnalyticsPeriodDateRange("today", now), ["2026-08-04", "2026-08-04"]);
  assert.deepEqual(getAnalyticsPeriodDateRange("yesterday", now), ["2026-08-03", "2026-08-03"]);
  assert.deepEqual(getAnalyticsPeriodDateRange("7d", now), ["2026-07-28", "2026-08-03"]);
  assert.deepEqual(getAnalyticsPeriodDateRange("28d", now), ["2026-07-07", "2026-08-03"]);
  assert.deepEqual(getAnalyticsPeriodDateRange("quarter", now), ["2026-07-01", "2026-08-03"]);
  assert.deepEqual(getAnalyticsPeriodDateRange("year", now), ["2026-01-01", "2026-08-03"]);
});

test("seller analytics custom period keeps the operator-selected range", () => {
  assert.equal(getAnalyticsPeriodDateRange("custom", new Date("2026-08-03T00:00:00.000Z")), null);
});


test('the reported seven-day collection range is not shifted by the UI',()=>{
 assert.deepEqual(getAnalyticsPeriodDateRange('7d',new Date('2026-11-07T08:00:00Z')),['2026-10-31','2026-11-06']);
 assert.deepEqual(getAnalyticsPeriodDateRange('year',new Date('2026-12-31T16:10:00Z')),['2026-01-01','2026-12-31']);
});

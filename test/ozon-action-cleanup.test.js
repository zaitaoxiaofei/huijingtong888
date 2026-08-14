import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOfficialActionCleanupIds,
  extractOfficialActionCleanupProductIds,
  extractOfficialActionSummaries,
  mergeKnownActionCatalog,
  recordKnownActionCheck,
  officialActionCatalogChanged
} from "../src/services/ozon-actions.js";

test("official action cleanup extracts only AUTO product ids", () => {
  const result = extractOfficialActionCleanupProductIds([
    { product_id: 101, add_mode: "AUTO" },
    { product_id: 102, add_mode: "MANUAL" },
    { id: 103, add_mode: "auto" },
    { product_id: 101, add_mode: "AUTO" },
    { product_id: "", add_mode: "AUTO" },
    { product_id: 104 }
  ]);

  assert.deepEqual(result, [101, 103]);
});

test("official action cleanup verifies deactivation instead of counting submitted rows as deleted", () => {
  const source = readFileSync(new URL("../src/services/ozon-actions.js", import.meta.url), "utf8");
  assert.match(source, /ACTION_DELETE_VERIFY_DELAYS_MS/);
  assert.match(source, /删除后复查仍有/);
  assert.match(source, /verified: true/);
  assert.match(source, /newlyDetectedIds = scan\.productIds\.filter/);
  assert.match(source, /remainingIds = scan\.productIds/);
});

test("official action cleanup fails closed when pagination cannot be completed", () => {
  const source = readFileSync(new URL("../src/services/ozon-actions.js", import.meta.url), "utf8");
  assert.match(source, /ACTION_PRODUCTS_MAX_PAGES/);
  assert.match(source, /seenCursors\.has\(nextCursor\)/);
  assert.match(source, /商品分页游标重复/);
  assert.match(source, /商品分页超过/);
});

test("official action cleanup schedules a short follow-up after removals or failures", () => {
  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /retryDelaySeconds: removed > 0 \|\| failed > 0 \? 120 : undefined/);
});

test("official action cleanup syncs current action catalog", () => {
  const summaries = extractOfficialActionSummaries({
    result: [
      { id: 3779044, title: "Current boost", is_participating: true, action_type: "STOCK_DISCOUNT" },
      { action_id: 3702380, name: "Old boost", is_participating: false }
    ]
  });

  assert.deepEqual(summaries.map((item) => item.actionId), [3702380, 3779044]);
  assert.equal(officialActionCatalogChanged([{ actionId: 3702380, title: "Old boost" }], summaries), true);
});

test("official action cleanup keeps known persisted ids when live action ids are available", () => {
  const result = buildOfficialActionCleanupIds([
    { actionId: 3779044, title: "Current boost" }
  ], [
    { actionId: 3684628, title: "Known old boost", firstSeenAt: "2026-07-01T00:00:00.000Z", lastSeenAt: "2026-07-01T00:00:00.000Z" },
    { actionId: 3702380, title: "Known old boost 2", firstSeenAt: "2026-07-01T00:00:00.000Z", lastSeenAt: "2026-07-01T00:00:00.000Z" }
  ]);

  assert.deepEqual(result, [3779044, 3684628, 3702380]);
});

test("official action cleanup persists newly discovered actions", () => {
  const known = mergeKnownActionCatalog([], [
    { id: 3832538, title: "Current boost", is_participating: true }
  ], {
    now: "2026-07-06T00:00:00.000Z",
    seedActionIds: []
  });

  assert.equal(known.length, 1);
  assert.equal(known[0].actionId, 3832538);
  assert.equal(known[0].lastSeenAt, "2026-07-06T00:00:00.000Z");
  assert.equal(known[0].unavailableCount, 0);
});

test("official action cleanup does not seed legacy ids without persisted history", () => {
  const known = mergeKnownActionCatalog([], [], {
    now: "2026-07-06T00:00:00.000Z"
  });

  assert.deepEqual(known, []);
  assert.deepEqual(buildOfficialActionCleanupIds([], known), []);
});

test("official action cleanup expires unavailable historical actions", () => {
  const known = [{
    actionId: 3832538,
    title: "Old boost",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    unavailableSince: "2026-07-01T00:00:00.000Z",
    unavailableCount: 3
  }];

  const result = recordKnownActionCheck(known, 3832538, { unavailable: true }, {
    now: "2026-07-06T00:00:00.000Z",
    unavailableRetentionDays: 3
  });

  assert.deepEqual(result, []);
});

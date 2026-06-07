import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOfficialActionCleanupIds,
  extractOfficialActionCleanupProductIds,
  extractOfficialActionSummaries,
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

test("official action cleanup prefers live action ids over stale configured ids", () => {
  const result = buildOfficialActionCleanupIds([
    { actionId: 3779044, title: "Current boost" }
  ], [3684628, 3702380]);

  assert.deepEqual(result, [3779044]);
});

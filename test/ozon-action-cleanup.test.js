import assert from "node:assert/strict";
import test from "node:test";

import { extractOfficialActionCleanupProductIds } from "../src/services/ozon-actions.js";

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

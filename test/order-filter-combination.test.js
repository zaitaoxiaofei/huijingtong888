import test from "node:test";
import assert from "node:assert/strict";

import { normalizePrintState, togglePrintViewState } from "../frontend/orders/utils/order-print-filters.js";

test("inventory ordering and unprinted filtering can be enabled together", () => {
  const inventory = togglePrintViewState({}, "inventory");
  const combined = togglePrintViewState(inventory, "unprinted");

  assert.equal(combined.sortMode, "inventory");
  assert.equal(combined.printFilter, "unprinted");
  assert.deepEqual(combined.activePrintViews, ["inventory", "unprinted"]);
});

test("print status remains exclusive without clearing inventory ordering", () => {
  const filters = normalizePrintState({ sortMode: "inventory", printFilter: "unprinted" });
  const printed = togglePrintViewState(filters, "printed");

  assert.equal(printed.sortMode, "inventory");
  assert.equal(printed.printFilter, "printed");
  assert.deepEqual(printed.activePrintViews, ["inventory", "printed"]);
});

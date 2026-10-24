import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const legacy = readFileSync(new URL("./fixtures/order-procurement-coverage-calculate-v1.js", import.meta.url), "utf8");
const current = readFileSync(new URL("../src/services/order-procurement-coverage.js", import.meta.url), "utf8");
function calculator(source) {
  let dates = 0;
  class CountedDate extends Date { constructor(...args) { super(...args); dates += 1; } }
  const context = vm.createContext({ Date: CountedDate });
  vm.runInContext(source.replace(/^export /gm, ""), context);
  return { run: input => { const started = performance.now(), result = context.calculateOrderProcurementCoverage(input); return { result, ms: performance.now() - started, dates }; } };
}
function canonical(value) {
  if (Object.prototype.toString.call(value) === "[object Map]") return { entries: [...value].map(([key, item]) => [key, canonical(item)]), properties: canonical({ ...value }) };
  if (Object.prototype.toString.call(value) === "[object Date]") return value.toJSON();
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function inputFor(count, skewed = false) {
  const product = index => 1 + (skewed && index % 10 ? index % 20 : index % 910);
  return {
    demands: Array.from({ length: count }, (_, index) => ({ order_id: 1 + index, order_item_id: 1 + index, product_id: product(index),
      ordered_at: `2026-10-${String(1 + index % 20).padStart(2, "0")} 00:00:00`,
      transport_at: index % 17 ? `2026-10-${String(2 + index % 20).padStart(2, "0")} 12:00:00` : null,
      quantity: 1 + index % 3, needs_fulfillment: index % 20 === 0 ? 1 : 0, entered_transport: index % 20 !== 0 ? 1 : 0,
      stock_location: index % 23 ? "LOCAL" : "FBP", allocation_priority: index % 29 === 0 ? 5 : 0 })),
    stocks: Array.from({ length: 910 }, (_, index) => ({ product_id: index + 1, ledger: index % 7 ? 100 : -1, stocktake_id: index % 41 ? null : index + 1, fbp_reserved: index % 13 ? 0 : 5 })),
    inbounds: Array.from({ length: 1545 }, (_, index) => ({ id: index + 1, product_id: product(index), quantity: 5 + index % 6, amount: index % 7 ? 100 : 0,
      status: index % 5 ? "approved" : "pending_arrival", procurement_request_id: 1 + index % 2245, purchase_order_id: 1 + index % 300,
      purchased_at: `2026-09-${String(1 + index % 20).padStart(2, "0")} 00:00:00`, created_at: "2026-09-01 00:00:00", approved_at: "2026-09-03 00:00:00" })),
    requests: Array.from({ length: 2245 }, (_, index) => ({ id: index + 1, product_id: product(index), quantity: index % 13 ? 2 : 0, status: "purchased", purchase_order_id: 1 + index % 300 })),
    allocations: Array.from({ length: Math.min(3363, count) }, (_, index) => ({ order_item_id: index + 1, product_id: product(index), procurement_request_id: 1 + index % 2245, allocated_quantity: 2 })),
    sources: Array.from({ length: Math.min(257, count) }, (_, index) => ({ order_item_id: 1 + index, product_id: product(index), quantity: 1, inbound_record_id: index + 1 })),
    marks: Array.from({ length: Math.min(1116, count) }, (_, index) => ({ order_item_id: index + 1, product_id: product(index), status: "handled", handling_type: index % 2 ? "stock_available" : "no_procurement_needed" })),
    stockSources: [], includeTrace: true
  };
}

test("request-local batch/date indexes preserve exact FIFO, source corrections, trace order and all public values", () => {
  const input = inputFor(300);
  input.stockSources.push({ id: 1, product_id: 1, quantity: 3, approved_at: "2026-09-01 00:00:00" });
  input.demands[5].ordered_at = new Date("2026-10-01T00:00:00Z");
  input.demands[6].transport_at = "invalid date";
  input.inbounds[7].purchased_at = "invalid date";
  input.inbounds[8].purchased_at = null;
  input.inbounds[8].created_at = null;
  const before = JSON.stringify(canonical(input));
  const old = calculator(legacy).run(input), next = calculator(current).run(input);
  assert.deepEqual(canonical(next.result), canonical(old.result));
  assert.equal(JSON.stringify(canonical(input)), before, "input rows stay immutable");
});

test("35k synthetic demands retain identical full output while avoiding repeated date parsing", { timeout: 120000 }, t => {
  const input = inputFor(35000, true);
  input.includeTrace = false;
  const old = calculator(legacy).run(input), next = calculator(current).run(input);
  assert.deepEqual(canonical(next.result), canonical(old.result));
  assert.ok(next.dates < old.dates / 2, JSON.stringify({ old: old.dates, next: next.dates }));
  t.diagnostic(`Synthetic 35k demands/1545 batches, hot-product skew: baseline ${old.ms.toFixed(1)}ms/${old.dates} Date constructions; indexed ${next.ms.toFixed(1)}ms/${next.dates}. Exact outputs including batch/trace ordering match; no production speed or SLA claim.`);
});

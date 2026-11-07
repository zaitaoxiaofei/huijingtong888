import assert from "node:assert/strict";
import test from "node:test";
import { createSyncRoutes } from "../src/server/routes/sync.js";
import { summarizeOrderSyncResult } from "../frontend/orders/utils/order-sync-result.js";

test("manual sync feedback counts new orders, not item rows, and reports failed shops", () => {
  const summary = summarizeOrderSyncResult({
    inserted: 7,
    shops: [
      { shop_id: 1, inserted: 2, inserted_items: 5 },
      { shop_id: 2, inserted: 0, error: "Ozon 请求限流" }
    ],
    errors: ["店铺 B: Ozon 请求限流"]
  });

  assert.equal(summary.insertedOrders, 2);
  assert.equal(summary.failedShopCount, 1);
  assert.match(summary.failureReason, /Ozon 请求限流/);
});

test("a busy manual sync response does not expose another task's details", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const routes = createSyncRoutes({
    services: {
      syncDemoOrders: () => pending,
      syncOzonIncrementalOrders: () => pending
    },
    readJson: async () => ({}),
    syncExceptionWorkbenchOrders: async () => ({})
  });

  try {
    const started = await routes["POST /api/sync/ozon"]({ _session: { tenantId: 1 } });
    const busy = await routes["POST /api/sync/ozon/incremental"]({ _session: { tenantId: 2 } });
    assert.equal(started.started, true);
    assert.ok(started.task_id);
    assert.deepEqual(busy, { started: false, queued: false, running: true, reason: "already_running" });
  } finally {
    finish({ fetched: 0, inserted: 0, updated: 0, shops: [], errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
  }
});

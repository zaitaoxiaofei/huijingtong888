import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const handlers = server.slice(
  server.indexOf("function throwForPartialOrderSync"),
  server.indexOf("async function runBackgroundPostingDetailDeepSync")
);

function createHandlers(services) {
  return runInNewContext(`
    let backgroundOrderSyncRunning = false;
    let backgroundCancelledOrderSyncRunning = false;
    let backgroundPostingDetailSyncRunning = false;
    const BACKGROUND_ORDER_SYNC_DAYS = 90;
    const BACKGROUND_CANCELLED_ORDER_SYNC_DAYS = 30;
    const BACKGROUND_POSTING_DETAIL_RECONCILIATION_DAYS = 2;
    const BACKGROUND_POSTING_DETAIL_SYNC_DAYS = 30;
    const BACKGROUND_POSTING_DETAIL_SYNC_LIMIT = 200;
    const BACKGROUND_POSTING_DETAIL_SYNC_CONCURRENCY = 2;
    const claimBackgroundModuleLane = () => "";
    const releaseBackgroundModuleLane = () => {};
    const rollingOrderSyncWindow = () => ({ from: "2026-10-18", to: "2026-10-19" });
    ${handlers}
    ({ runBackgroundOrderStatusSync, runBackgroundCancelledOrderSync, runBackgroundPostingDetailSync });
  `, { services, console: { log() {}, error() {} } });
}

test("scheduled new-order sync refreshes dashboard but fails when one shop fails", async () => {
  let refreshCount = 0;
  const { runBackgroundOrderStatusSync } = createHandlers({
    syncOzonIncrementalOrders: async () => ({
      fetched: 3,
      shops: [
        { shop_name: "Healthy Shop", fetched: 3 },
        { shop_name: "RuVibe Mart", error: "Lock wait timeout exceeded" }
      ],
      errors: ["RuVibe Mart: Lock wait timeout exceeded"]
    }),
    refreshDashboardSnapshot: async () => {
      refreshCount += 1;
      return { commerce: { date_key: "2026-10-19" } };
    }
  });

  await assert.rejects(runBackgroundOrderStatusSync(), /Order status sync incomplete: 1 error\(s\); failed shop\(s\): RuVibe Mart/);
  assert.equal(refreshCount, 1);
});

test("scheduled new-order sync still succeeds when every shop succeeds", async () => {
  const { runBackgroundOrderStatusSync } = createHandlers({
    syncOzonIncrementalOrders: async () => ({ fetched: 3, errors: [], shops: [{ shop_name: "Healthy Shop", fetched: 3 }] }),
    refreshDashboardSnapshot: async () => ({ commerce: { date_key: "2026-10-19" }, snapshot: { refreshed_at: "now" } })
  });

  const result = await runBackgroundOrderStatusSync();
  assert.equal(result.fetched, 3);
  assert.equal(result.dashboard_refresh.date_key, "2026-10-19");
});

test("cancelled-order reconciliation reports partial shop failure", async () => {
  const { runBackgroundCancelledOrderSync } = createHandlers({
    syncDemoOrders: async () => ({
      fetched: 1,
      shops: [{ shop_name: "RuVibe Mart", error: "Ozon unavailable" }],
      errors: ["RuVibe Mart: Ozon unavailable"]
    })
  });

  await assert.rejects(runBackgroundCancelledOrderSync(), /Cancelled order sync incomplete: 1 error\(s\); failed shop\(s\): RuVibe Mart/);
});

test("posting-detail reconciliation preserves completed detail work but reports partial shop failure", async () => {
  let detailCount = 0;
  const { runBackgroundPostingDetailSync } = createHandlers({
    syncDemoOrders: async () => ({
      fetched: 1,
      shops: [{ shop_name: "RuVibe Mart", error: "Ozon unavailable" }],
      errors: ["RuVibe Mart: Ozon unavailable"]
    }),
    syncKnownOzonPostingDetails: async () => {
      detailCount += 1;
      return { fetched: 1 };
    }
  });

  await assert.rejects(runBackgroundPostingDetailSync(), /Posting detail reconciliation incomplete: 1 error\(s\); failed shop\(s\): RuVibe Mart/);
  assert.equal(detailCount, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createTenantBackgroundTasks } from "../src/services/tenant-background-tasks.js";
import { createSyncRoutes } from "../src/server/routes/sync.js";
import { summarizeOrderSyncResult, exactPostingNumbers } from "../frontend/orders/utils/order-sync-result.js";

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

test("busy sync stays in its own enterprise and never blocks another enterprise", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const routes = createSyncRoutes({
    services: {
      syncDemoOrders: () => pending,
      syncOzonIncrementalOrders: () => pending
    },
    readJson: async () => ({}),
    syncExceptionWorkbenchOrders: async () => ({}),
    tasks: createTenantBackgroundTasks({ authorize: async session => session })
  });

  try {
    const started = await routes["POST /api/sync/ozon"]({ _session: { personId:1,tenant:{id:1} } });
    const busy = await routes["POST /api/sync/ozon/incremental"]({ _session: { personId:1,tenant:{id:1} } });
    const foreign = await routes["POST /api/sync/ozon/incremental"]({ _session: { personId:2,tenant:{id:2} } });
    assert.equal(foreign.started,true);assert.notEqual(foreign.task_id,started.task_id);
    assert.equal(started.started, true);
    assert.ok(started.task_id);
    assert.equal(busy.started,false);assert.equal(busy.running,true);assert.equal(busy.reason,"already_running");assert.equal(busy.task_id,started.task_id);
  } finally {
    finish({ fetched: 0, inserted: 0, updated: 0, shops: [], errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('complete posting searches select targeted official synchronization without the date window',async()=>{
 assert.deepEqual(exactPostingNumbers('order','37471023-0116-3, 66784792-0251-3'),['37471023-0116-3','66784792-0251-3']);
 assert.deepEqual(exactPostingNumbers('sku','37471023-0116-3'),[]);assert.deepEqual(exactPostingNumbers('order','37471023'),[]);
 const calls=[];const routes=createSyncRoutes({readJson:async()=>({posting_numbers:['37471023-0116-3']}),services:{syncDemoOrders:()=>assert.fail('must not enumerate a date range'),syncOzonPostingsByNumber:(body,options)=>{calls.push([body,options]);return{fetched:1};}},tasks:{start:async(session,kind,run)=>run({session,signal:undefined,onProgress(){}})}});
 const result=await routes['POST /api/sync/ozon']({_session:{personId:2,tenant:{id:2,slug:'a'}}});assert.equal(result.fetched,1);assert.equal(calls[0][1].tenantId,'2');
});

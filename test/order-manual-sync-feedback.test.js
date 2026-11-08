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

test('running snapshots without queued never become a zero-count success', async () => {
  const { waitForOrderSyncTask } = await import('../frontend/orders/utils/order-sync-result.js');
  const progress = [];
  const snapshots = [
    { task_id: 'same', running: true, result: null, progress: { phase: 'saving', message: '正在写入 506 单', fetched: 506 } },
    { task_id: 'same', running: false, result: { fetched: 506, updated: 500, shops: [{ inserted: 6 }] } }
  ];
  let reads = 0;
  const task = await waitForOrderSyncTask({ task_id: 'same', queued: true, running: true }, {
    wait: async () => {}, fetchStatus: async () => snapshots[reads++], onProgress: text => progress.push(text)
  });
  assert.equal(reads, 2);
  assert.equal(task.result.fetched, 506);
  assert.match(progress[1], /已拉取 506 单/);
  assert.match(progress[1], /任务仍在执行/);
});

test('lost tasks, missing final results and failed tasks never report success', async () => {
  const { waitForOrderSyncTask } = await import('../frontend/orders/utils/order-sync-result.js');
  for (const final of [
    { task_id: '', running: false, result: null },
    { task_id: 'same', running: false, result: null },
    { task_id: 'same', running: false, result: null, error: 'Ozon 请求失败' }
  ]) {
    await assert.rejects(waitForOrderSyncTask({ task_id: 'same', running: true }, {
      wait: async () => {}, fetchStatus: async () => final, onProgress: () => {}
    }));
  }
  const zero = { task_id: 'same', running: false, result: { fetched: 0, shops: [] } };
  assert.equal((await waitForOrderSyncTask(zero, { onProgress() {} })).result.fetched, 0);
});

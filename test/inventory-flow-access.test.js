import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { createInventoryFlowRoutes } from '../src/server/routes/inventoryFlow.js';
const session = role => ({ personId: role === 'packing' ? 2 : 1, roles: [role], tenant: { id: 2, slug: 'a', role: 'member' } });
test('new tab read endpoints are explicitly scoped, unknown endpoints remain blocked', () => {
  for (const suffix of ['', '/detail', '/settings', '/tasks', '/events', '/sync-status']) {
    const parts = ('api/inventory-flow' + suffix).split('/');
    assert.equal(tenantIsolationDecision(session('operations'), parts, 'GET').allowed,true);
    assert.equal(authorizeApiRequest({method:'GET',_session:session('operations')},parts).allowed,true);
  }
  assert.equal(tenantIsolationDecision(session('operations'), ['api','inventory-flow','unknown'], 'POST').allowed,false);
  assert.equal(tenantIsolationDecision({roles:['operations']}, ['api','inventory-flow'], 'GET').allowed,false);
});
test('warehouse actions require packing duty even when operations can submit requests', async () => {
  const calls = [];
  const routes = createInventoryFlowRoutes({readJson:async req=>req.body, flow:{mutateTask:async (...args)=>calls.push(args)}});
  const route = routes['POST /api/inventory-flow/task-action'];
  await assert.rejects(route({_session:session('operations'),body:{action:'lock',tenant_id:3}}),{statusCode:403});
  await route({_session:session('packing'),body:{action:'lock',tenant_id:3}});
  assert.equal(calls[0][1],'2'); assert.equal(calls[0][2],2);
  await assert.rejects(route({_session:session('packing'),body:{action:'edit'}}),{statusCode:403});
});

test('FBP sync returns immediately, coalesces per enterprise/product and denies revoked writers', async () => {
  const { createTenantBackgroundTasks } = await import('../src/services/tenant-background-tasks.js');
  let allowed = true;
  const authorize = async value => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode:403 }); return value; };
  const tasks = createTenantBackgroundTasks({ authorize });
  const pending = [], calls = [];
  const routes = createInventoryFlowRoutes({ readJson: async req => req.body, tasks, authorize,
    syncStocks: async (body, options) => { calls.push({ body, options }); return new Promise(resolve => pending.push(resolve)); }
  });
  const writer = { personId: 1, roles: ['inventory'], tenant: { id: 2, slug: 'a', role:'owner' } };
  const req = id => ({ _session:writer, body:{ product_id:id, background:true, tenant_id:999 } });
  const start = routes['POST /api/inventory-flow/sync'];
  const status = (who, id) => routes['GET /api/inventory-flow/sync-status']({ _session:who }, new URL(`http://localhost/api/inventory-flow/sync-status?product_id=${id}`));
  const a = await start(req(10));
  assert.equal(a.running, true);
  assert.equal(a.queued, true);
  const duplicate = await start(req(10));
  assert.equal(duplicate.task_id, a.task_id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { product_id:10 });
  assert.equal(calls[0].options.tenantId, '2');
  assert.equal((await status({ ...writer, tenant:{...writer.tenant,id:3,slug:'b'} }, 10)).task_id, '');
  assert.equal((await status(writer, 11)).task_id, '');
  await assert.rejects(start(req(0)), { statusCode:400 });
  await assert.rejects(start({ _session:session('packing'), body:{product_id:10,background:true} }), { statusCode:403 });
  pending[0]({ ok:false, results:[{ shop_id:20,ok:false,message:'原快照保留' }] });
  await new Promise(resolve => setImmediate(resolve));
  const done = await status(writer, 10);
  assert.equal(done.running, false);
  assert.equal(done.result.ok, false);
  const b = await start(req(10));
  assert.notEqual(b.task_id, a.task_id);
  await new Promise(resolve => setImmediate(resolve));
  pending[1]({ok:true,results:[]});
  allowed = false;
  await assert.rejects(status(writer,10), { statusCode:403 });
});

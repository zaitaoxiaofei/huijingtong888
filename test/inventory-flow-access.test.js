import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { createInventoryFlowRoutes } from '../src/server/routes/inventoryFlow.js';
const session = role => ({ personId: role === 'packing' ? 2 : 1, roles: [role], tenant: { id: 2, slug: 'a', role: 'member' } });
test('new tab read endpoints are explicitly scoped, unknown endpoints remain blocked', () => {
  for (const suffix of ['', '/detail', '/settings', '/tasks', '/events']) {
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

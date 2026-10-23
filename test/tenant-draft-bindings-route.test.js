import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { authorizeApiRequest } from '../src/server/authorization.js';

test('draft binding admission is exactly GET for ordinary default/A/B operations; advanced bindings remain closed', () => {
  for (const tenant of [{ id: 7, slug: 'default' }, { id: 2, slug: 'a' }, { id: 3, slug: 'b' }]) {
    const session = { personId: 9, roles: ['operations'], tenant: { ...tenant, role: 'member' } };
    const parts = ['api', 'listing', 'draft-bindings'];
    assert.equal(tenantIsolationDecision(session, parts, 'GET').allowed, true);
    assert.equal(authorizeApiRequest({ method: 'GET', _session: session }, parts).allowed, true);
    assert.equal(authorizeApiRequest({ method: 'GET', _session: { ...session, roles: ['packing'] } }, parts).allowed, false);
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(tenantIsolationDecision(session, parts, method).code, 'TENANT_ISOLATION_PENDING');
    for (const [path, method] of [['draft-binding-options', 'GET'], ['draft-bindings/extra', 'GET'], ['drafts/bind', 'POST'], ['development-review', 'POST'], ['drafts/batch-update', 'POST']]) {
      assert.equal(tenantIsolationDecision(session, ['api', 'listing', ...path.split('/')], method).code, 'TENANT_ISOLATION_PENDING');
    }
  }
});

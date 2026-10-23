import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';

const routes = [
  ...['analyze', 'analysis/lookup', 'analysis/confirm', 'plan', 'plan/confirm', 'result',
    'review-image', 'compose-text', 'test-image', 'prepare-template'].map(action => ['POST', `ai-variant-lab/optimize/${action}`]),
  ['GET', 'ai-variant-lab/optimize/jobs/job-1'],
  ['POST', 'ai-material-optimization/batches'], ['GET', 'ai-material-optimization/batches'],
  ['GET', 'ai-material-optimization/batches/batch-1'], ['POST', 'ai-material-optimization/items/item-1/retry'],
  ['POST', 'listing/drafts/ai-variant-lightweight'],
  ['GET', 'asset-variant-engine/selection-publish-shops'],
  ...['generate', 'generate-async', 'generate-video', 'register-richtext-image', 'title-preview',
    'import-listing-automation', 'publish-to-ozon', 'publish-selection'].map(action => ['POST', `asset-variant-engine/${action}`]),
  ['GET', 'asset-variant-engine/jobs'], ['GET', 'asset-variant-engine/jobs/12'],
  ['POST', 'asset-variant-engine/jobs/12/cancel'], ['POST', 'asset-variant-engine/jobs/12/retry-failures'],
  ['GET', 'asset-variant-engine/files/group-1/shop/images/main/main-01.jpg']
];
const member = (id, roles = ['operations'], role = 'member') => ({
  person_id: 80 + id, roles, tenant: { id, slug: id === 1 ? 'default' : `customer-${id}`, role }
});
const partsOf = path => ['api', ...path.split('/')];
function decision(session, method, path) {
  const parts = partsOf(path);
  const isolated = tenantIsolationDecision(session, parts, method);
  return isolated.allowed ? authorizeApiRequest({ _session: session, method }, parts) : isolated;
}

test('default and A/B ordinary operators reach only reviewed optimization and matrix actions', () => {
  for (const id of [1, 2, 3]) for (const [method, path] of routes) {
    assert.equal(decision(member(id), method, path).allowed, true, `${id} ${method} ${path}`);
    assert.equal(decision(member(id, [], 'owner'), method, path).allowed, true, `owner ${id} ${path}`);
    for (const roles of [[], ['packing'], ['procurement'], ['technical']]) {
      assert.equal(decision(member(id, roles), method, path).allowed, false, `${id} ${roles} ${path}`);
    }
  }
});

test('reviewed AI execution cannot run with only a platform identity or a client tenant selector', () => {
  for (const session of [null, { roles: ['operations'] }, { platform_role: 'super_admin' }]) {
    for (const [method, path] of routes) {
      const result = decision(session, method, path);
      assert.equal(result.allowed, false, path);
      assert.equal(result.code, 'TENANT_CONTEXT_REQUIRED', path);
    }
  }
});

test('AI admission rejects alternate methods, path suffixes and adjacent unreviewed actions', () => {
  const denied = routes.flatMap(([method, path]) => [
    [method === 'GET' ? 'POST' : 'GET', path], ['PATCH', path], [method, `${path}/extra`]
  ]).filter(([method, path]) => !routes.some(([acceptedMethod, acceptedPath]) => method === acceptedMethod && path === acceptedPath)
    // Files have a deliberately variable relative path; traversal is validated by the file resolver.
    && !path.startsWith('asset-variant-engine/files/')
    && !(method === 'GET' && path === 'ai-material-optimization/batches/extra'));
  denied.push(['POST', 'asset-variant-engine/publish'], ['POST', 'asset-variant-engine/sync-ozon-categories'],
    ['GET', 'asset-variant-engine/jobs/not-numeric'], ['POST', 'listing/publish-tasks/12/retry'],
    ['POST', 'ai-variant-lab/plan-variant'], ['POST', 'asset-variant-engine/files/group-1/image.png']);
  for (const id of [1, 2, 3]) for (const [method, path] of denied) {
    assert.equal(decision(member(id), method, path).allowed, false, `${id} ${method} ${path}`);
  }
});

test('operations execution does not grant matrix configuration writes', () => {
  for (const id of [1, 2, 3]) for (const action of ['rules', 'tail-templates']) {
    assert.equal(decision(member(id), 'POST', `asset-variant-engine/${action}`).allowed, false);
    assert.equal(decision(member(id, [], 'owner'), 'POST', `asset-variant-engine/${action}`).allowed, true);
  }
});

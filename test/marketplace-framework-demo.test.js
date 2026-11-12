import test from 'node:test';
import assert from 'node:assert/strict';
import { marketplaceIdentity } from '../src/shared/marketplace-identity.js';
import { createDemoOrders, demoListings, demoProducts, filterMarketplaceRows, sharedAvailable } from '../frontend/admin/views/marketplace/demo-data.js';
import { canAccessPage } from '../src/shared/permissions.js';

test('explicit unknown platforms are never presented as Ozon', () => {
  assert.equal(marketplaceIdentity('Wildberries').key, 'wb');
  assert.equal(marketplaceIdentity(' OZON ').label, 'OZON');
  assert.equal(marketplaceIdentity('other').key, 'unknown');
  assert.equal(marketplaceIdentity('').key, 'unknown');
});
test('platform, shop and search filters intersect without leaking other platform records', () => {
  const rows = createDemoOrders();
  assert.equal(filterMarketplaceRows(rows, { platform: 'wb' }).length, 2);
  assert.equal(filterMarketplaceRows(rows, { platform: 'ozon', shop: 'wb-demo' }).length, 0);
  assert.equal(filterMarketplaceRows(rows, { platform: 'wb', shop: 'wb-demo', search: 'bp-001' }).length, 1);
  assert.equal(filterMarketplaceRows(rows, { search: 'missing' }).length, 0);
  const listings = filterMarketplaceRows(demoListings, { platform: 'wb' });
  assert.equal(listings.length, 2);
  assert.ok(listings.every(row => row.platform === 'wb'));
});
test('shared products remain one physical record under either platform filter', () => {
  for (const platform of ['ozon', 'wb']) {
    const rows = filterMarketplaceRows(demoProducts, { platform });
    assert.equal(rows.length, demoProducts.length);
    assert.equal(rows[0], demoProducts[0]);
    assert.equal(sharedAvailable(rows[0]), 60);
  }
  assert.equal(sharedAvailable({ ...demoProducts[0], wbWarehouse: 1000, ozonFbp: 2000 }), 60);
  assert.equal(sharedAvailable({ ...demoProducts[0], local: 0 }), 0);
});
test('demo state is fresh per page and cannot contaminate the next preview', () => {
  const first = createDemoOrders();
  first[0].status = '已交接';
  assert.equal(createDemoOrders()[0].status, '待处理');
});
test('preview keeps existing enterprise access and operations permission gates', () => {
  assert.equal(canAccessPage({ role: 'operations', tenant: { id: 1, role: 'member' } }, '/marketplace-demo'), true);
  assert.equal(canAccessPage({ role: 'packing', tenant: { id: 1, role: 'member' } }, '/marketplace-demo'), false);
  assert.equal(canAccessPage({ role: 'operations' }, '/marketplace-demo'), false);
  assert.equal(canAccessPage({ role: 'operations', tenant: { id: 2, access_allowed: false } }, '/marketplace-demo'), false);
});

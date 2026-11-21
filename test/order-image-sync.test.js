import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderImageSyncToRow, applyOrderImageSyncToItems, orderImageDisplayUrl } from '../frontend/orders/utils/order-image-sync.js';

test('manual image results patch only the selected order item and preserve existing failed/unrelated images', () => {
  const row = { id: 1, skus: 'A,B', sku_order_item_ids: 'A:101||B:102', sku_images: 'A:/old-a.png||B:/old-b.png', mark_note: '保留人工备注' };
  const other = { ...row, id: 2 };
  const result = { order_id: 1, items: [{ id: 101, image_url: '/new-a.png', updated: true }, { id: 102, image_url: '', updated: false, error: '暂不可用' }] };
  assert.deepEqual(applyOrderImageSyncToRow(row, result), { ...row, sku_images: 'A:/new-a.png||B:/old-b.png' });
  assert.equal(applyOrderImageSyncToRow(other, result), other);
  const item = { id: 102, image_url: '/old-b.png', quantity: 3 };
  assert.equal(applyOrderImageSyncToItems([item], result)[0], item);
});

test('legacy rows use the returned server-owned SKU mapping, rather than pairing independent CSV positions', () => {
  const row = { id: 1, skus: 'A,B', sku_images: 'B:/b.png' };
  assert.equal(applyOrderImageSyncToRow(row, { order_id: 1, items: [{ id: 101, ozon_sku: 'A', image_url: '/a.png', updated: true }] }).sku_images, 'B:/b.png||A:/a.png');
});

test('only the local order image proxy requires an original response, preserving its other parameters', () => {
  const value = orderImageDisplayUrl('/api/image-proxy?url=https%3A%2F%2Fexample.com%2Fa.png&token=test');
  const parsed = new URL(value, 'http://localhost');
  assert.equal(parsed.searchParams.get('require_original'), '1');
  assert.equal(parsed.searchParams.get('url'), 'https://example.com/a.png');
  assert.equal(parsed.searchParams.get('token'), 'test');
  assert.equal(orderImageDisplayUrl('https://example.com/api/image-proxy?url=a'), 'https://example.com/api/image-proxy?url=a');
});

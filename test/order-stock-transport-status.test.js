import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrderInTransport } from '../src/services/order-query-facts.js';

test('waiting packaging and dispatch remain in the warehouse despite logistics text', () => {
  for (const status of ['awaiting_packaging', 'awaiting_deliver', 'sent_by_seller',
    'posting_ready_for_pickup', 'posting_transferred_to_courier_service', 'posting_in_carriage']) {
    assert.equal(isOrderInTransport({ status, logistics_status: 'shipped to carrier' }), false, status);
  }
  assert.equal(isOrderInTransport({ tracking_stage: 'awaiting_deliver', logistics_status: 'pickup pending' }), false);
});

test('online transport status leaves the warehouse even with stale waiting tracking stage', () => {
  for (const status of ['delivering', 'posting_in_transit', 'delivered']) {
    assert.equal(isOrderInTransport({ status, tracking_stage: 'awaiting_deliver' }), true, status);
  }
  assert.equal(isOrderInTransport({ status: 'cancelled' }), false);
});

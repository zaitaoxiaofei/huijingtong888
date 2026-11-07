import test from 'node:test';
import assert from 'node:assert/strict';
import { oglTransportDeadlineAt, oglTransportDeadlineRule } from '../src/services/ogl-transport-deadline.js';
import { withOglDispatch } from '../src/services/ogl-dispatch-state.js';

const applied = { batch_id: 1, batch_number: 'OGL-1', official_carriage_id: '124237634', official_member: 1, default_shop_id: 4, active_order_id: 6, official_status: 'observed', batch_status: 'preparing', dispatched_at: null };
const order = { id: 6, shop_id: 4, status: 'awaiting_deliver', tracking_stage: 'posting_acceptance_in_progress', logistics_carrier: 'ogl', ordered_at: '2026-10-21 04:48:13', shipment_deadline_at: '2026-10-24T04:48:13Z' };

test('OGL entering-transport rule is preparation plus inbound allowance and validates future configuration', () => {
  assert.deepEqual(oglTransportDeadlineRule({}), { preparation_days: 3, warehouse_inbound_days: 3, total_days: 6 });
  assert.deepEqual(oglTransportDeadlineRule({ OGL_PREPARATION_DAYS: '4', OGL_WAREHOUSE_INBOUND_DAYS: '2' }), { preparation_days: 4, warehouse_inbound_days: 2, total_days: 6 });
  assert.deepEqual(oglTransportDeadlineRule({ OGL_PREPARATION_DAYS: '2', OGL_WAREHOUSE_INBOUND_DAYS: '0' }), { preparation_days: 2, warehouse_inbound_days: 0, total_days: 2 });
  for (const value of ['', ' ', '-1', '0', '1.5', 'NaN', 'Infinity', '366']) assert.equal(oglTransportDeadlineRule({ OGL_PREPARATION_DAYS: value }).preparation_days, 3);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '366']) assert.equal(oglTransportDeadlineRule({ OGL_WAREHOUSE_INBOUND_DAYS: value }).warehouse_inbound_days, 3);
});

test('OGL transport deadline starts at the known ordered instant, handles UTC SQL and offsets, and never uses the preparation deadline', () => {
  const rule = oglTransportDeadlineRule({});
  for (const value of [order.ordered_at, '2026-10-21T04:48:13Z', '2026-10-21T12:48:13+08:00', new Date('2026-10-21T04:48:13Z')]) assert.equal(oglTransportDeadlineAt(value, rule), '2026-10-27T04:48:13.000Z');
  assert.equal(oglTransportDeadlineAt('2026-12-29T16:10:00Z', rule), '2027-01-04T16:10:00.000Z');
  assert.equal(oglTransportDeadlineAt(order.ordered_at, oglTransportDeadlineRule({ OGL_PREPARATION_DAYS: '4', OGL_WAREHOUSE_INBOUND_DAYS: '3' })), '2026-10-28T04:48:13.000Z');
  for (const value of [null, undefined, '', '2026-10-21', 'invalid', new Date('invalid')]) assert.equal(oglTransportDeadlineAt(value, rule), null);
});

test('OGL applications and physical handovers keep counting until actual platform transport; no physical evidence is manufactured', () => {
  const result = withOglDispatch(order, applied);
  assert.equal(result.ogl_dispatch.stage_label, '已申请');
  assert.equal(result.ogl_dispatch.official_carriage_id, '124237634');
  assert.equal(result.ogl_dispatch.dispatched, false);
  assert.equal(result.ogl_dispatch.dispatched_at, null);
  assert.equal(result.ogl_dispatch.transport_deadline_at, '2026-10-27T04:48:13.000Z');
  assert.equal(withOglDispatch(order, { ...applied, dispatched_at: '2026-10-22 06:00:00' }).ogl_dispatch.transport_deadline_at, result.ogl_dispatch.transport_deadline_at);
  for (const status of ['delivering', 'delivered', 'cancelled', 'returned_to_seller', 'arbitration']) assert.equal(withOglDispatch({ ...order, status }, applied).ogl_dispatch.transport_deadline_at, null, status);
  for (const tracking_stage of ['posting_in_transit', 'posting_received_by_buyer', 'posting_in_customs']) assert.equal(withOglDispatch({ ...order, tracking_stage }, applied).ogl_dispatch.transport_deadline_at, null, tracking_stage);
  for (const member of [{ ...applied, active_order_id: 88 }, { ...applied, withdrawn_at: '2026-10-22 06:00:00' }, { ...applied, official_member: 0 }, { ...applied, default_shop_id: 9 }]) assert.equal(withOglDispatch(order, member).ogl_dispatch.transport_deadline_at, null);
  assert.equal(withOglDispatch({ ...order, ordered_at: null }, applied).ogl_dispatch.transport_deadline_at, null);
});

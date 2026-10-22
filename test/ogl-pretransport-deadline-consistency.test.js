import assert from 'node:assert/strict';
import test from 'node:test';
import { withOglDispatch } from '../src/services/ogl-dispatch-state.js';
import * as deadlineView from '../frontend/orders/utils/ogl-transport-deadline.js';

const DAY_MS = 86400000;
const orderedAt = '2026-10-20T00:00:00Z';
const now = Date.parse('2026-10-24T00:00:00Z');
const deadlineAt = '2026-10-26T00:00:00.000Z';
const base = { id: 7, shop_id: 20, logistics_carrier: 'ogl', fulfillment_type_key: 'fbs', ordered_at: orderedAt,
  shipment_deadline_at: '2026-10-23T00:00:00Z', ship_days_remaining: -1, is_overdue: true };
const application = { batch_id: 9, batch_number: 'OGL-fixture', official_carriage_id: '123456', official_member: 1,
  default_shop_id: 20, active_order_id: 7, official_status: 'observed', batch_status: 'preparing', dispatched_at: null };
function withRule(preparationDays, inboundDays, action) {
  const before = [process.env.OGL_PREPARATION_DAYS, process.env.OGL_WAREHOUSE_INBOUND_DAYS];
  process.env.OGL_PREPARATION_DAYS = String(preparationDays); process.env.OGL_WAREHOUSE_INBOUND_DAYS = String(inboundDays);
  try { return action(); }
  finally {
    for (const [index, key] of ['OGL_PREPARATION_DAYS', 'OGL_WAREHOUSE_INBOUND_DAYS'].entries()) {
      if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index];
    }
  }
}

test('all pretransport OGL stages share the ordered-time deadline without manufacturing batch or handover evidence', () => withRule(3, 3, () => {
  const variants = [
    [{ status: 'awaiting_packaging' }, undefined],
    [{ status: 'awaiting_deliver' }, undefined],
    [{ status: 'acceptance_in_progress', tracking_stage: 'posting_acceptance_in_progress' }, undefined],
    [{ status: 'awaiting_deliver', tracking_stage: 'posting_registered' }, undefined],
    [{ status: 'awaiting_deliver', tracking_stage: 'posting_in_carriage' }, application],
    [{ status: 'acceptance_in_progress', tracking_stage: 'posting_acceptance_in_progress' }, { ...application, dispatched_at: '2026-10-24 00:00:00' }]
  ];
  for (const [state, member] of variants) {
    const input = Object.freeze({ ...base, ...state });
    const projected = withOglDispatch(input, member);
    assert.deepEqual(projected.ogl_transport_deadline, { at: deadlineAt, rule: { preparation_days: 3, warehouse_inbound_days: 3, total_days: 6 }, stopped: false }, state.status);
    assert.equal(deadlineView.usesOglTransportDeadline(projected), true);
    assert.equal(deadlineView.oglTransportDeadlineHint(projected, now), '剩余 2 天');
    assert.equal(projected.shipment_deadline_at, input.shipment_deadline_at, 'Preserve the separate platform preparation deadline');
    assert.equal(projected.ship_days_remaining, input.ship_days_remaining); assert.equal(projected.is_overdue, input.is_overdue);
    if (!member) {
      assert.equal(projected.ogl_dispatch, undefined); assert.equal(projected.display_status, input.display_status);
    } else {
      assert.equal(projected.ogl_dispatch.transport_deadline_at, deadlineAt, 'Keep the previous associated-row DTO compatible');
      assert.equal(projected.ogl_dispatch.dispatched_at, member.dispatched_at);
      assert.equal(projected.ogl_dispatch.dispatched, Boolean(member.dispatched_at));
    }
  }
}));

test('raw shipment and application timestamps never restart the configured total OGL allowance', () => withRule(4, 3, () => {
  for (const ordered_at of [orderedAt, '2026-10-20 00:00:00', '2026-10-20T08:00:00+08:00', new Date(orderedAt)]) {
    const projected = withOglDispatch({ ...base, ordered_at, status: 'awaiting_deliver', shipment_deadline_at: '2026-11-30T00:00:00Z',
      created_at: '2026-10-25T00:00:00Z', applied_at: '2026-10-25T12:00:00Z' }, { ...application, created_at: '2026-10-25T00:00:00Z', dispatched_at: '2026-10-25T13:00:00Z' });
    assert.equal(projected.ogl_transport_deadline.at, '2026-10-27T00:00:00.000Z');
    assert.equal(projected.ogl_transport_deadline.rule.total_days, 7);
    assert.equal(deadlineView.oglTransportDeadlineHint(projected, now), '剩余 3 天');
  }
}));

test('actual platform transport and terminal evidence stops every OGL countdown despite old waiting fields', () => withRule(3, 3, () => {
  for (const state of [
    { status: 'delivering' }, { status: 'delivered' }, { status: 'cancelled' }, { status: 'returned_to_seller' }, { status: 'not_accepted' }, { status: 'arbitration' },
    { status: 'awaiting_packaging', tracking_stage: 'posting_in_transit' },
    { status: 'awaiting_deliver', logistics_status: 'posting_in_customs' },
    { status: 'awaiting_deliver', tracking_stage: 'posting_received_by_buyer' },
    { status: 'awaiting_deliver', logistics_status: 'posting_cancelled' }
  ]) for (const member of [undefined, application, { ...application, dispatched_at: '2026-10-23T01:00:00Z' }]) {
    const projected = withOglDispatch({ ...base, tracking_stage: 'posting_acceptance_in_progress', ...state }, member);
    assert.equal(projected.ogl_transport_deadline.at, null, JSON.stringify(state));
    assert.equal(projected.ogl_transport_deadline.stopped, true, JSON.stringify(state));
    assert.equal(deadlineView.oglTransportDeadlineHint(projected, now), '', JSON.stringify(state));
    assert.equal(deadlineView.oglTransportDeadlineUrgent(projected, now), false);
  }
}));

test('carrier, FBP and unavailable ordered instants cannot borrow an unrelated deadline', () => withRule(3, 3, () => {
  for (const logistics_carrier of ['cel', 'guoo', 'postal', 'other', '']) {
    const input = { ...base, logistics_carrier, status: 'awaiting_packaging', product_name: 'OGL', billing_logistics_rule_name: 'OGL' };
    const projected = withOglDispatch(input);
    assert.equal(projected.ogl_transport_deadline, undefined);
    assert.equal(deadlineView.usesOglTransportDeadline(projected), false);
    assert.equal(deadlineView.oglTransportDeadlineHint(projected, now), '');
    assert.equal(projected.shipment_deadline_at, input.shipment_deadline_at);
  }
  for (const fulfillment of [{ fulfillment_type_key: 'fbp' }, { logistics_fulfillment_type: 'fbp' }, { fulfillment_schema: 'FBP' }]) {
    const projected = withOglDispatch({ ...base, ...fulfillment, status: 'awaiting_deliver' });
    assert.equal(projected.ogl_transport_deadline, undefined);
    assert.equal(deadlineView.usesOglTransportDeadline(projected), false);
  }
  for (const ordered_at of [null, undefined, '', '2026-10-20', 'invalid']) {
    const projected = withOglDispatch({ ...base, ordered_at, status: 'awaiting_packaging' });
    assert.equal(projected.ogl_transport_deadline.at, null);
    assert.equal(deadlineView.oglTransportDeadlineHint(projected, now), '截止时间待获取');
    assert.equal(deadlineView.oglTransportDeadlineUrgent(projected, now), false);
  }
  const receiptText = withOglDispatch({ ...base, status: 'awaiting_deliver', tracking_number: 'delivered-cancelled-in_transit' });
  assert.equal(receiptText.ogl_transport_deadline.at, deadlineAt, 'Tracking identifiers are not platform-state evidence');
}));

test('strict less-than-three-day urgency applies only to already-dispatched presentation and uses exact milliseconds', () => {
  assert.equal(typeof deadlineView.oglTransportDeadlineUrgent, 'function');
  const row = milliseconds => ({ ...base, status: 'acceptance_in_progress', display_status: 'ogl_dispatched',
    ogl_dispatch: { tracking: true, applied: true, dispatched: false }, ogl_transport_deadline: { at: new Date(now + milliseconds).toISOString() } });
  for (const milliseconds of [3 * DAY_MS, 3 * DAY_MS + 1]) assert.equal(deadlineView.oglTransportDeadlineUrgent(row(milliseconds), now), false);
  assert.equal(deadlineView.oglTransportDeadlineHint(row(3 * DAY_MS - 1), now), '剩余 3 天');
  for (const milliseconds of [3 * DAY_MS - 1, 1, 0, -1, -DAY_MS - 1]) assert.equal(deadlineView.oglTransportDeadlineUrgent(row(milliseconds), now), true);
  assert.equal(deadlineView.oglTransportDeadlineHint(row(0), now), '剩余 0 天');
  assert.equal(deadlineView.oglTransportDeadlineHint(row(-1), now), '超时 1 天');
  assert.equal(deadlineView.oglTransportDeadlineHint(row(-DAY_MS - 1), now), '超时 2 天');
  assert.equal(deadlineView.oglTransportDeadlineUrgent({ ...row(1), status: 'awaiting_packaging', display_status: '', ogl_dispatch: undefined }, now), false);
  assert.equal(deadlineView.oglTransportDeadlineUrgent({ ...row(1), ogl_transport_deadline: { at: null } }, now), false);
  assert.equal(deadlineView.oglTransportDeadlineUrgent({ ...row(1), status: 'delivering' }, now), false);
});

test('legacy nested tracking rows remain readable while explicit non-OGL or FBP ownership takes priority', () => {
  const legacy = { status: 'awaiting_deliver', display_status: 'ogl_dispatched', ogl_dispatch: { tracking: true, transport_deadline_at: deadlineAt } };
  assert.equal(deadlineView.usesOglTransportDeadline(legacy), true);
  assert.equal(deadlineView.oglTransportDeadlineHint(legacy, now), '剩余 2 天');
  const explicitlyUnknown = { ...legacy, ogl_transport_deadline: { at: null } };
  assert.equal(deadlineView.oglTransportDeadlineHint(explicitlyUnknown, now), '截止时间待获取');
  assert.equal(deadlineView.oglTransportDeadlineUrgent(explicitlyUnknown, now), false);
  for (const overrides of [{ logistics_carrier: 'cel' }, { logistics_carrier: 'other' }, { logistics_carrier: 'ogl', fulfillment_type_key: 'fbp' }]) {
    const row = { ...legacy, ...overrides };
    assert.equal(deadlineView.usesOglTransportDeadline(row), false);
    assert.equal(deadlineView.oglTransportDeadlineHint(row, now), '');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildPromotionEnrollmentSummary } from '../frontend/admin/utils/promotionEnrollmentResult.js';

test('22 identical readback errors become one explanation and one collapsed product group', () => {
  const ids = Array.from({ length: 22 }, (_, i) => i + 1);
  const summary = buildPromotionEnrollmentSummary({ success: false, count: 0,
    result: { active_product_ids: ids }, failures: ids.map(product_id => ({ product_id,
      status: 'pending', code: 'READBACK_RATE_LIMITED', reason: 'You have reached request rate limit per second' })) });
  assert.equal(summary.type, 'info'); assert.match(summary.title, /待核对 22 件，未通过 0 件/);
  assert.match(summary.message, /收到 22 件/); assert.match(summary.message, /不要重复报名/);
  assert.equal(summary.groups.length, 1); assert.equal(summary.groups[0].ids.length, 22);
  assert.doesNotMatch(summary.groups[0].reason, /request rate limit/);
});
test('confirmed, explicitly rejected and legacy uncertain results keep separate counts', () => {
  const summary = buildPromotionEnrollmentSummary({ success: false, count: 1,
    failures: [{ product_id: 2, status: 'rejected', reason: 'price too high' }, { product_id: 3, reason: 'unknown' }] });
  assert.match(summary.title, /已核实 1 件，待核对 1 件，未通过 1 件/);
  assert.equal(summary.type, 'warning'); assert.equal(buildPromotionEnrollmentSummary(null), null);
});
test('official enrollment result is rendered once with closed details and bounded height', () => {
  const source = readFileSync(new URL('../frontend/admin/views/marketing/OzonActionsView.vue', import.meta.url), 'utf8');
  assert.equal((source.match(/<el-alert v-if="enrollmentSummary"/g) || []).length, 1);
  assert.doesNotMatch(source, /<el-alert v-if="state.enrollmentResult"/);
  assert.match(source, /<details[^>]*class="enrollment-details"/);
  assert.doesNotMatch(source, /<details[^>]*class="enrollment-details"[^>]*open/);
  assert.match(source, /max-height: 220px; overflow: auto/);
});


test('a failed enrollment write is never described as an accepted receipt', () => {
  const summary = buildPromotionEnrollmentSummary({ success: false, count: 0,
    failures: [{ product_id: 1, reason: '本次未确认：request rate limit per second；请先刷新核对' }] });
  assert.doesNotMatch(summary.message, /已收到/);
  assert.doesNotMatch(summary.groups[0].reason, /已收到报名回执/);
});

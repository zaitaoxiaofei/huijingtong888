import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedAftersaleReason, reviewedAftersaleReasons } from '../src/services/reviewed-aftersale-reasons.js';
import { translateCancellationReason, cancellationReasonTypes } from '../src/services/order-cancellation-display.js';
import { getProfitFormula } from '../src/services/profit-formulas/registry.js';
import { DatabaseSync } from 'node:sqlite';

test('reviewed codes and equivalent buyer cancellations translate while preserving the platform reason', () => {
  assert.equal(reviewedAftersaleReasons.flatMap(row => row.codes).length, 20);
  for (const reason of reviewedAftersaleReasons) {
    for (const code of reason.codes) {
      const row = { cancel_reason_id: Number(code), cancel_reason: reason.original };
      const translated = translateCancellationReason(row);
      assert.equal(translated.label, reason.label);
      assert.equal(translated.original, reason.original);
      assert.equal(translated.code, code);
      assert.equal(translated.translated, true);
      assert.equal(reviewedAftersaleReason(row).kind, reason.kind);
    }
    assert.equal(translateCancellationReason({ cancel_reason: reason.original }).label, reason.label);
    assert.ok(cancellationReasonTypes().some(type => type.value === reason.reason_code));
  }
});

test('reviewed cancellation overrides stale shipping flags; V1 and V2 remain frozen', () => {
  for (const reason of reviewedAftersaleReasons) {
    for (const code of reason.codes) {
      const row = { status: 'cancelled', cancelled_after_ship: 1, cancel_reason_id: code, cancel_reason: reason.original };
      for (const version of ['V3', 'V4']) {
        const formula = getProfitFormula(version);
        const accounting = formula.outcome.classifyOrderAccounting(row);
        assert.equal(accounting.outcome_type, reason.kind === 'cargo_loss' ? 'cargo_lost' : 'cancelled_pre_fulfillment');
        assert.equal(accounting.aftersale_bucket, reason.kind === 'cargo_loss' ? 'cargo_loss' : 'pre_fulfillment_cancel');
        const loss = formula.outcome.estimateOutcomeReturnLoss({ outcome: accounting.outcome_type,
          lossProfileCode: accounting.loss_profile_code, quantity: 2, purchaseCostPerUnit: 20,
          collectingFeeTotal: 3, internationalShippingPerUnit: 10, domesticShippingPerUnit: 5,
          commissionFeeTotal: 11, packagingCostTotal: 2, serviceFeeTotal: 9 });
        assert.equal(loss, reason.kind === 'cargo_loss' ? 43 : 0);
        assert.equal(formula.estimatedProfitValue({ order: row, returnLossEstimate: loss }), -loss);
      }
      assert.equal(getProfitFormula('V1').outcome.classifyOrderOutcome(row), 'rejected_unclaimed');
      assert.equal(getProfitFormula('V2').outcome.classifyOrderOutcome(row), 'rejected_unclaimed');
    }
  }
});

test('SQL and JavaScript classify the same reviewed and genuine return records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE orders(status, tracking_stage, logistics_status, delivered_at, accrued_at, cancel_reason_id, cancel_reason, cancel_type, cancel_initiator, cancelled_after_ship)');
    const formula = getProfitFormula('V3');
    const expressions = formula.outcome.buildOrderOutcomeSql('o', 'sqlite');
    const select = db.prepare(`SELECT ${expressions.cancelledPreFulfillment} cancelled, ${expressions.cargoLost} cargo, ${expressions.afterDeliveryReturn} returned, ${expressions.rejectedUnclaimed} rejected FROM orders o`);
    for (const reason of reviewedAftersaleReasons) {
      db.exec('DELETE FROM orders');
      const row = { status: 'cancelled', cancel_reason_id: reason.codes[0], cancel_reason: reason.original, cancelled_after_ship: 1 };
      db.prepare('INSERT INTO orders(status,cancel_reason_id,cancel_reason,cancelled_after_ship) VALUES(?,?,?,?)').run(row.status,row.cancel_reason_id,row.cancel_reason,row.cancelled_after_ship);
      const result = select.get();
      assert.equal(result.cancelled, reason.kind === 'cancellation' ? 1 : 0);
      assert.equal(result.cargo, reason.kind === 'cargo_loss' ? 1 : 0);
      assert.equal(result.returned, 0);
      assert.equal(result.rejected, 0);
    }
    const genuine = { status: 'returned', delivered_at: '2026-10-20', cancel_reason: 'Товар не подошел' };
    assert.equal(formula.outcome.classifyOrderAccounting(genuine).outcome_type, 'after_delivery_return');
    assert.equal(formula.outcome.classifyOrderAccounting(genuine).loss_profile_code, 'purchase_collecting_international');
    assert.equal(formula.outcome.classifyOrderOutcome({ status: 'delivered', cancel_reason_id: 686 }), 'delivered_signed');
  } finally { db.close(); }
});

test('unreviewed reasons do not silently acquire a reviewed financial policy', () => {
  assert.equal(reviewedAftersaleReason({ cancel_reason: 'Заказ утерян при доставке — уточняется' }), null);
  assert.equal(reviewedAftersaleReason({ cancel_reason_id: 999999, cancel_reason: 'unknown' }), null);
  assert.equal(translateCancellationReason({ cancel_reason_id: 994 }).label, '缺少商品护照或合规文件');
  assert.equal(translateCancellationReason({ reason_code: 'missing_passport' }).label, '买家未提供护照资料');
});

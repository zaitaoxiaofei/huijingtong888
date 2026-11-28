import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWbOrderProfit, WB_ORDER_ESTIMATE_MODEL_VERSION } from '../src/shared/wb-order-profit.js';
import { estimateWbOrderProfit as frontendEstimate } from '../frontend/orders/utils/wb-order-profit.js';
import { wbTariffVersion } from '../src/shared/wb-logistics-catalog.js';

const hefei = wbTariffVersion('2026-11-11').rows.find(row => row.id === 382855);
const input = { sale: 56.55, purchaseCost: 4.3, domesticCost: 1, weight: 200, length: 15, width: 15, height: 5,
  commissionRate: 20, adRate: 0, otherRate: 0, returnRate: 0 };

test('WB frontend and persisted server estimates use the same versioned model implementation', () => {
  assert.equal(frontendEstimate, estimateWbOrderProfit);
});

test('WB estimate calculates the pictured order using Hefei freight and automatic fee components', () => {
  const result = estimateWbOrderProfit(input, hefei);
  assert.equal(result.delivery, 13.6);
  assert.equal(result.commission, 11.31);
  assert.equal(result.lastMile, 1.41);
  assert.equal(result.withdrawal, 0.36);
  assert.equal(result.singleReturnLoss, 31.62);
  assert.equal(result.returnLoss, 0);
  assert.equal(result.total, 31.98);
  assert.equal(result.profit, 24.57);
  assert.equal(result.modelVersion, WB_ORDER_ESTIMATE_MODEL_VERSION);
  assert.equal(result.modelVersion, 'wb-order-estimate-v2');
  assert.equal(result.shipping.ruleKey, 'wb:2026-11-11:382855');
  assert.deepEqual(result.missingInputs, []);
});

test('WB expected returns include goods, domestic and cross-border freight, commission and delegated delivery', () => {
  const result = estimateWbOrderProfit({ ...input, returnRate: 10 }, hefei);
  assert.equal(result.autoReturnLoss, 31.62);
  assert.equal(result.singleReturnLoss, 31.62);
  assert.equal(result.returnLoss, 3.16);
  assert.equal(result.profit, 21.41);
  assert.equal(result.returnLossOverridden, false);
  assert.equal(estimateWbOrderProfit({ ...input, returnRate: 10, returnLoss: null }, hefei).singleReturnLoss, 31.62);
  assert.equal(estimateWbOrderProfit({ ...input, returnRate: 10, returnLoss: '' }, hefei).singleReturnLoss, 31.62);
  const manual = estimateWbOrderProfit({ ...input, returnRate: 10, returnLoss: 50 }, hefei);
  assert.equal(manual.singleReturnLoss, 50);
  assert.equal(manual.returnLoss, 5);
  assert.equal(manual.returnLossOverridden, true);
  assert.equal(estimateWbOrderProfit({ ...input, returnRate: 10, returnLoss: 0 }, hefei).returnLoss, 0);
});

test('WB payment rate is explicit, with missing configuration treated as a provisional assumption', () => {
  const missing = estimateWbOrderProfit(input, hefei);
  assert.equal(missing.payment, 0);
  assert.equal(missing.paymentConfigured, false);
  assert.equal(missing.provisional, true);
  const confirmed = estimateWbOrderProfit({ ...input, paymentRate: 1 }, hefei);
  assert.equal(confirmed.payment, 0.57);
  assert.equal(confirmed.paymentConfigured, true);
  assert.equal(confirmed.provisional, false);
  assert.equal(confirmed.profit, 24);
  const zero = estimateWbOrderProfit({ ...input, paymentRate: 0 }, hefei);
  assert.equal(zero.payment, 0);
  assert.equal(zero.paymentConfigured, true);
  assert.equal(zero.provisional, false);
});

test('WB missing or invalid required inputs remain unknown instead of becoming zero costs', () => {
  for (const field of ['sale', 'purchaseCost', 'domesticCost', 'commissionRate', 'weight', 'length', 'width', 'height']) {
    for (const value of [null, '', NaN, -1]) {
      const result = estimateWbOrderProfit({ ...input, [field]: value }, hefei);
      assert.equal(result.profit, null, `${field}=${value}`);
      assert.ok(result.missingInputs.some(item => item.field === field));
    }
  }
  const noWarehouse = estimateWbOrderProfit(input, null);
  assert.equal(noWarehouse.delivery, null);
  assert.equal(noWarehouse.withdrawal, null);
  assert.equal(noWarehouse.autoReturnLoss, null);
  assert.equal(noWarehouse.profit, null);
  assert.ok(noWarehouse.missingInputs.some(item => item.field === 'warehouseId'));
  const noCost = estimateWbOrderProfit({ ...input, purchaseCost: null, returnRate: 10 }, hefei);
  assert.equal(noCost.returnLoss, null);
  assert.equal(noCost.profit, null);
  assert.notEqual(estimateWbOrderProfit({ ...input, purchaseCost: 0, domesticCost: 0, commissionRate: 0 }, hefei).profit, null);
});

test('WB changing weight recalculates freight and returns; invalid optional rates block a reliable total', () => {
  const result = estimateWbOrderProfit({ ...input, weight: 301, returnRate: 10 }, hefei);
  assert.equal(result.delivery, 25.2);
  assert.equal(result.singleReturnLoss, 43.22);
  assert.equal(result.returnLoss, 4.32);
  assert.equal(estimateWbOrderProfit({ ...input, length: 116 }, hefei).profit, null);
  assert.match(estimateWbOrderProfit({ ...input, length: 116 }, hefei).shippingError, /单边/);
  for (const field of ['adRate', 'otherRate', 'paymentRate', 'returnRate']) {
    for (const value of [-1, 101, NaN]) {
      const invalid = estimateWbOrderProfit({ ...input, [field]: value }, hefei);
      assert.equal(invalid.profit, null);
      assert.ok(invalid.inputErrors.some(item => item.field === field));
    }
  }
  assert.equal(estimateWbOrderProfit({ ...input, returnLoss: -1 }, hefei).profit, null);
});

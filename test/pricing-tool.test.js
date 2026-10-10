import test from "node:test";
import assert from "node:assert/strict";
import { calculatePricing, calculateProfit } from "../frontend/admin/utils/pricing-tool.js";

const input = {
  purchaseCost: 28, weight: 300, length: 20, width: 20, height: 10,
  commissionRate: 17, freight: 18.67, exchangeRate: 12.7164,
  domesticCost: 0, lastMile: 0, adRate: 0, otherRate: 1,
  targetMargin: 30, discountRate: 50, returnRate: 0, returnLoss: 0
};

test("pricing reaches target margin and derives list price", () => {
  const result = calculatePricing(input);
  assert.equal(result.saleCny, 95.64);
  assert.equal(result.lastMile, 2.39);
  assert.equal(result.withdrawalFee, 0.67);
  const reverse = calculateProfit({ ...input, saleCny: result.saleCny });
  assert.equal(reverse.withdrawalFee, result.withdrawalFee);
  assert.equal(reverse.lastMile, result.lastMile);
  assert.equal(reverse.profit, result.profit);
  assert.equal(result.listRub, Math.round(result.saleRub * 2 * 100) / 100);
  assert.ok(Math.abs(result.margin - 30) < 0.02);
  assert.equal(result.volumeLiters, 4);
});

test("pricing rejects an impossible combined rate", () => {
  assert.throws(() => calculatePricing({ ...input, commissionRate: 70 }), /低于 100%/);
});

test("expected return loss raises the price and remains visible in the breakdown", () => {
  const baseline = calculatePricing(input);
  const result = calculatePricing({ ...input, returnRate: 10, returnLoss: 20 });
  assert.equal(result.expectedReturnLoss, 2);
  assert.ok(result.saleCny > baseline.saleCny);
  assert.ok(Math.abs(result.margin - 30) < 0.02);
  assert.throws(() => calculatePricing({ ...input, returnRate: 101 }), /退货率不能超过/);
});

test("profit calculator deducts expected return loss from an actual selling price", () => {
  const baseline = calculateProfit({ ...input, saleCny: 128, commissionRate: 12 });
  assert.equal(baseline.lastMile, 3.2);
  assert.equal(baseline.withdrawalFee, 0.97);
  const withReturns = calculateProfit({ ...input, saleCny: 128, commissionRate: 12, returnRate: 10, returnLoss: 20 });
  assert.equal(withReturns.expectedReturnLoss, 2);
  assert.equal(withReturns.profit, baseline.profit - 2);
  assert.equal(withReturns.margin, Math.round(withReturns.profit / 128 * 10000) / 100);
});

test("profit calculator exposes losses and rejects invalid return rates", () => {
  assert.ok(calculateProfit({ ...input, saleCny: 20, returnRate: 0, returnLoss: 0 }).profit < 0);
  assert.throws(() => calculateProfit({ ...input, saleCny: 128, returnRate: 101 }), /不能超过 100%/);
});

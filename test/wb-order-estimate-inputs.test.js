import assert from 'node:assert/strict';
import test from 'node:test';
import { createWbPlatform } from '../src/services/wb-platform.js';

const inventory = {
  ordered_at: '2026-11-22T00:00:00Z', quantity: 1, purchase_cost: '4.30', domestic_shipping: '0.80', handling_fee: '0.20',
  package_weight_g: 200, length_cm: 15, width_cm: 15, height_cm: 5, card_json: null
};

async function inputsFor(input) {
  const service = createWbPlatform({
    query: async (sql, params) => {
      if (sql.includes('SELECT o.ordered_at, i.quantity')) {
        assert.deepEqual(params, [50, 2, 20, 17]);
        assert.match(sql, /m\.tenant_id=w\.tenant_id/);
        assert.match(sql, /c\.tenant_id=w\.tenant_id/);
        return input ? [input] : [];
      }
      if (sql.includes('FROM orders o JOIN wb_order_details')) {
        assert.deepEqual(params, [2, 17]);
        return [{ id: 17, shop_id: 20, wb_order_id: 30,
          raw_json: { nmId: 50, convertedCurrencyCode: 156, convertedPrice: 5655 } }];
      }
      if (sql.includes('FROM inventory_movements')) return [{ posted_movements: 0 }];
      if (sql.includes('FROM wb_order_settlement_lines')) return [];
      if (sql.includes('FROM order_profit_calc_state state')) return [];
      assert.fail(`Unexpected query: ${sql}`);
    },
    request: async () => assert.fail('Reading estimate inputs must not make a WB request')
  });
  return (await service.orderFinancialEvidence(2, { order_id: 17 })).estimate_inputs;
}

test('WB estimate hydrates inventory costs and grams/centimetres without remote calls', async () => {
  assert.deepEqual(await inputsFor(inventory), {
    shop_id: 20, subject_id: null, ordered_at: inventory.ordered_at,
    purchaseCost: 4.3, domesticCost: 1, weight: 200, length: 15, width: 15, height: 5
  });
});

test('WB known domestic fees remain usable while procurement cost is missing', async () => {
  const result = await inputsFor({ ...inventory, purchase_cost: null });
  assert.equal(result.purchaseCost, null);
  assert.equal(result.domesticCost, 1);
});

test('WB absent domestic components remain unknown; explicit zeros stay zero', async () => {
  for (const field of ['domestic_shipping', 'handling_fee']) {
    for (const missing of [null, undefined, '', NaN, Infinity, -1]) {
      assert.equal((await inputsFor({ ...inventory, [field]: missing })).domesticCost, null);
    }
  }
  assert.equal((await inputsFor({ ...inventory, domestic_shipping: 0, handling_fee: 0 })).domesticCost, 0);
});

test('WB card kilograms convert to grams and missing dimensions fall back individually', async () => {
  const result = await inputsFor({ ...inventory,
    card_json: JSON.stringify({ subjectID: 123, dimensions: { weightBrutto: 0.301, length: 18, width: null, height: 0 } }) });
  assert.equal(result.subject_id, 123);
  assert.equal(result.weight, 301);
  assert.equal(result.length, 18);
  assert.equal(result.width, 15);
  assert.equal(result.height, 5);
  assert.equal((await inputsFor({ ...inventory, card_json: { dimensions: { weightBrutto: Infinity } } })).weight, 200);
});

test('WB multi-quantity costs scale while parcel dimensions remain explicitly unknown', async () => {
  const result = await inputsFor({ ...inventory, quantity: 2 });
  assert.equal(result.purchaseCost, 8.6);
  assert.equal(result.domesticCost, 2);
  for (const field of ['weight', 'length', 'width', 'height']) assert.equal(result[field], null);
});

test('WB missing inventory or invalid quantity never fabricates a zero order cost', async () => {
  for (const input of [null, { ...inventory, quantity: null }, { ...inventory, quantity: 1.5 }]) {
    const result = await inputsFor(input);
    assert.equal(result.purchaseCost, null);
    assert.equal(result.domesticCost, null);
    assert.equal(result.weight, null);
  }
});

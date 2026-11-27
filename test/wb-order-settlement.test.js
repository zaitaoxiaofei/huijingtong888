import assert from 'node:assert/strict';
import test from 'node:test';
import { createWbClient } from '../src/services/wb-client.js';
import { pullWbSettlementPage, summarizeWbSettlement } from '../src/services/wb-order-settlement.js';

test('WB ledger preserves precise cursors, page source and shop scope, with an empty page ending pagination', async () => {
  const sql = [];
  const wire = [];
  let response = new Response('[{"reportId":123456789012345678,"rrdId":223456789012345678,"orderId":6350,"currency":"CNY","docTypeName":"Продажа","forPay":"10.20"}]');
  let now = 0;
  const request = createWbClient({ now: () => now, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://finance-api.wildberries.cn/api/finance/v1/sales-reports/detailed');
    wire.push(options.body);
    return response;
  }});
  const account = { tenant_id: 2, shop_id: 20, environment: 'production', token: 'test' };
  const body = { date_from: '2026-11-01', date_to: '2026-11-27' };
  const transaction = work => work({ execute: async (...args) => { sql.push(args); } });
  const first = await pullWbSettlementPage({ account, body, request, transaction });
  assert.equal(first.next_cursor, '223456789012345678');
  assert.deepEqual(sql[0][1].slice(0, 5), [2, 20, '123456789012345678', '223456789012345678', '6350']);
  assert.equal(JSON.parse(sql[0][1][5]).forPay, 10.2);
  now = 61000;
  response = new Response(null, { status: 204 });
  const next = await pullWbSettlementPage({ account, body: { ...body, cursor: first.next_cursor }, request, transaction });
  assert.equal(next.next_cursor, null);
  assert.match(wire[1], /"rrdId":223456789012345678[,}]/);
  assert.equal(sql.length, 1);
});

test('WB report net handles returns and already-included payment fees, and waits for cost, FX or ambiguous adjustments', async () => {
  const rows = [
    { payload_json: { currency: 'RUB', date: '2026-11-25', type: 'Продажа', forPay: 600, acquiringFee: 15, ppvzSalesCommission: 25 } },
    { payload_json: { currency: 'RUB', date: '2026-11-25', type: 'Возврат', forPay: 100 } },
    { payload_json: { currency: 'RUB', date: '2026-11-25', type: '', deliveryService: 40 } }
  ];
  const lookup = async day => ({ rate: '10', source_date: day });
  assert.equal((await summarizeWbSettlement(rows, 20)).state, 'needs_fx');
  const result = await summarizeWbSettlement(rows, 20, lookup);
  assert.equal(result.amounts[0].net_settlement, 460);
  assert.equal(result.amounts_cny.deliveryService, 4);
  assert.equal(result.amounts_cny.acquiringFee, 1.5);
  assert.equal(result.amounts_cny.penalty, null);
  assert.equal(result.actual_profit_cny, 26);
  assert.equal((await summarizeWbSettlement(rows, null, lookup)).actual_profit_cny, null);
  rows[2].payload_json.deduction = 50;
  assert.equal((await summarizeWbSettlement(rows, 20, lookup)).state, 'needs_review');
});

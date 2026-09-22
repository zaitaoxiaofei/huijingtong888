import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { orderPurchaseDetails } from '../frontend/orders/utils/order-procurement-detail.js';
import { formatDateTime, formatMoney } from '../frontend/orders/utils/order-format.js';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';

const batch = { id: 5, product_id: 10, purchase_order_item_id: 8, quantity: 20,
  purchase_quantity: 20, purchase_received_quantity: 0, amount: 131.6, purchase_amount: 131.6,
  shipping_amount: 0, status: 'pending_arrival', product_name: '挡风被', stock_unit: '件',
  purchase_order_no: 'PO-20260911-010', person_name: '采购员', purchased_at: '2026-09-11T07:42:34Z',
  purchase_url: 'https://example.com/product', purchase_note: '银色普通款' };

const page = await readFile(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
const context = vm.createContext({ h, orderPurchaseDetails, formatDateTime, formatMoney });
vm.runInContext(page.slice(page.indexOf('function buildProcurementState('), page.indexOf('async function handleViewProcurementDetails(')), context);

function coverage(quantity = 1, inbounds = [batch]) {
  return calculateOrderProcurementCoverage({ demands: [{ order_id: 1, order_item_id: 1, product_id: 10,
    product_name: '挡风被', stock_unit: '件', quantity, needs_fulfillment: 1, stock_location: 'LOCAL' }], inbounds }).get(1);
}

test('20 purchased units stay separate from one unit covering the order, with matching total cost', async () => {
  const row = { procurement_coverage: coverage() };
  row.procurementState = context.buildProcurementState(row);
  assert.equal(row.procurement_coverage.incoming_quantity, 1);
  assert.equal(row.procurementState.inboundDetails.quantity, 20);
  assert.equal(row.procurementState.purchaseSummary, '20 件');
  const html = await renderToString(context.procurementDetailContent(row, '采购详情'));
  assert.match(html, /挡风被/);
  assert.match(html, /采购总量<\/span><strong class="is-primary">20 件/);
  assert.match(html, /本单需求<\/span><strong class="is-muted">本单 1 件，在途覆盖 1 件/);
  assert.match(html, /采购单价<\/span><strong class="">¥6.58 \/ 件/);
  assert.match(html, /2026\/09\/11 15:42:34（北京时间）/);
  assert.doesNotMatch(html, /PO-20260911-010/);
  assert.doesNotMatch(html, /银色普通款/);
  assert.doesNotMatch(html, /https:\/\/example.com\/product/);
});

test('partial receipt uses original purchase totals once, even across two receipt batches', () => {
  const received = { ...batch, id: 6, quantity: 6, amount: 39.48, status: 'approved', purchase_received_quantity: 6 };
  const pending = { ...batch, quantity: 14, amount: 92.12, purchase_received_quantity: 6 };
  const details = orderPurchaseDetails([received, pending, pending]);
  assert.equal(details.length, 1);
  assert.equal(details[0].quantity, 20);
  assert.equal(details[0].received, 6);
  assert.equal(details[0].pending, 14);
  assert.equal(details[0].amount, 131.6);
});

test('multiple purchases show each product, quantity and unit price', async () => {
  const second = { ...batch, id: 7, purchase_order_item_id: 9, purchase_order_no: 'PO-SECOND', quantity: 3,
    purchase_quantity: 3, product_name: '另一批商品', stock_unit: '套', purchase_amount: 30, purchase_shipping_amount: 5 };
  const row = { procurement_coverage: coverage(21, [batch, second]) };
  const html = await renderToString(context.procurementDetailContent(row));
  assert.match(html, /挡风被/);
  assert.match(html, /另一批商品/);
  assert.match(html, /3 套/);
  assert.match(html, /¥10.00 \/ 套/);
});

test('legacy batches retain recorded quantity and zero costs without invented purchase totals', () => {
  const result = orderPurchaseDetails([{ id: 1, quantity: 7, amount: 0, status: 'pending_arrival' }]);
  assert.equal(result[0].quantity, 7);
  assert.equal(result[0].amount, 0);
  assert.equal(result[0].pending, 7);
});

test('received purchases are omitted from the packing-facing view', async () => {
  const row = { procurement_coverage: coverage(1, [{ ...batch, status: 'approved', purchase_received_quantity: 20 }]) };
  const html = await renderToString(context.procurementDetailContent(row));
  assert.equal(html, '<div class="orders-inbound-confirm"></div>');
});

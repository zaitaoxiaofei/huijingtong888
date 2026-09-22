import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../frontend/orders/components/OrdersTable.vue', import.meta.url), 'utf8');
const code = source.match(/function isInboundReceiptPending\([^]*?\n}/)[0];
test('receipt buttons are idle for multiple batches until an actual batch is submitted', () => {
  const props = { confirmingInboundRecordId: 0 };
  const pending = vm.runInNewContext(`${code};isInboundReceiptPending`, { props });
  const multi = { procurementState: { inboundRecordId: null }, procurement_coverage: { batches: [{ id: 41 }, { id: 42 }] } };
  assert.equal(pending(multi), false);
  assert.equal(pending({ procurementState: { inboundRecordId: 41 } }), false);
  props.confirmingInboundRecordId = 42;
  assert.equal(pending(multi), true);
  assert.equal(pending({ procurementState: { inboundRecordId: 41 } }), false);
  assert.equal(pending({ procurementState: { inboundRecordId: 42 } }), true);
  props.confirmingInboundRecordId = 0;
  assert.equal(pending(multi), false);
});

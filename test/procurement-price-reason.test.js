import test from 'node:test';
import assert from 'node:assert/strict';
import {PROCUREMENT_PRICE_REASONS,procurementPriceReason,markProcurementPriceException} from '../src/shared/procurement-price-reason.js';
test('ordinary purchase has no invented price exception and selected reasons are retained',()=>{
 assert.equal(procurementPriceReason(), '');
 for(const reason of PROCUREMENT_PRICE_REASONS.filter(r=>r!=='其他原因'))assert.equal(procurementPriceReason({anomaly_reason:reason}),reason);
});
test('other reason requires a real explanation and serializes it for the existing cost history',()=>{
 for(const note of ['', '  ',null])assert.throws(()=>procurementPriceReason({anomaly_reason:'其他原因',anomaly_note:note}),/具体/);
 assert.equal(procurementPriceReason({anomaly_reason:'其他原因',anomaly_note:'  小批次含定制工艺  '}),'其他原因：小批次含定制工艺');
});

test('server price exception identifies the other product without erasing a reason already entered',()=>{
 const rows=[{product_id:200,anomaly_reason:'供应商涨价'},{product_id:201,historical_unit_cost:30,anomaly_reason:''}];
 const error={payload:{validation:{field:'items.anomaly_reason',product_id:201,reference_unit_cost:10}}};
 assert.equal(markProcurementPriceException(error,rows),1);assert.equal(rows[0].anomaly_reason,'供应商涨价');assert.equal(rows[1].price_confirmation_required,true);assert.equal(rows[1].historical_unit_cost,10);
 assert.equal(markProcurementPriceException({payload:{validation:{field:'other'}}},rows),-1);
});

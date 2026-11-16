import test from 'node:test';
import assert from 'node:assert/strict';
import {officialReturnReportRow} from '../src/services/ozon-return-report.js';
const row=state=>({ozon_sku:'1',quantity:1,official_actual_profit_cny:-20,official_estimated_profit_cny:30,official_actual_inputs_json:{return_evidence:[{return_id:1,sku:'1',state}]},aftersale:{observations:[{return_id:1,state:{state},product:{sku:1}}]}});
test('refund reporting keeps original actual net loss and cannot invent recovered inventory',()=>{
 const result=officialReturnReportRow(row('MoneyReturned'),{});
 assert.equal(result.actual_loss_cny,20);assert.equal(result.aftersale.goods,'unknown');assert.equal(result.quantity,1);
 assert.equal(result.bucket,'official_after_delivery_return');
});
test('partial compensation remains separate; missing actual profit is explicitly provisional',()=>{
 const result=officialReturnReportRow({...row('PartialCompensationReturnedByOzon'),official_actual_profit_cny:null},{});
 assert.equal(result.bucket,'official_partial_compensation');assert.equal(result.actual_loss_cny,null);assert.equal(result.needs_review,1);
 const multiple=officialReturnReportRow({...row('MoneyReturned'),quantity:3},{});assert.equal(multiple.return_quantity_unknown,1);
});
test('an unaffected SKU and a cancelled request keep their existing reporting result',()=>{
 const legacy={outcome_type:'delivered_signed'};
 assert.equal(officialReturnReportRow({...row('MoneyReturned'),ozon_sku:'2'},legacy),legacy);
 for(const code of ['Cancelled','Solved','Rejected','CrmRejected'])assert.equal(officialReturnReportRow(row(code),legacy),legacy);
});

test('an old positive actual and unmatched return SKUs cannot masquerade as settled refund loss',()=>{
 const old=officialReturnReportRow({...row('MoneyReturned'),official_actual_profit_cny:25,official_actual_inputs_json:null},{});
 assert.equal(old.actual_loss_cny,null);assert.equal(old.needs_review,1);
 const unmapped=row('MoneyReturned');unmapped.aftersale.observations[0].product=null;
 assert.equal(officialReturnReportRow(unmapped,{}).bucket,'official_possible_return');
});

test('known platform progress is separate from unidentified return states',()=>{
 const r=officialReturnReportRow(row('CheckingStatus'),{});
 assert.equal(r.bucket,'official_return_processing');assert.equal(r.aftersale.needs_review,false);
 for(const code of ['Utilized','Utilizing','ReceivedBySeller'])assert.equal(officialReturnReportRow(row(code),{}).bucket,'official_after_delivery_return');
});

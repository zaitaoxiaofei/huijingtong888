import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLocalCapitalRows,localCapitalTotals} from '../src/services/inventory-capital-local.js';
test('capital values free quantity supplied by public policy, never raw ledger or physical quantity',()=>{
 const rows=availableLocalCapitalRows([{product_id:1,quantity:13,unit_cost:3.125,cost_missing:0}], [{product_id:1,physical_recorded:20,free:11,order_quantity:4,locked_quantity:3,safety_target:2}]);
 assert.equal(rows[0].quantity,11);assert.equal(rows[0].inventory_value,34.375);assert.equal(rows[0].physical_quantity,20);assert.equal(rows[0].ledger_quantity,13);
 assert.equal(localCapitalTotals(rows).value,34.375);
});
test('fully occupied stock remains visible for reconciliation but has zero capital value',()=>{
 const rows=availableLocalCapitalRows([{product_id:1,quantity:10,unit_cost:7}], [{product_id:1,physical_recorded:10,free:0}]);
 assert.equal(rows.length,1);assert.equal(rows[0].inventory_value,0);assert.equal(localCapitalTotals(rows).quantity,0);
});
test('unknown free quantity never silently becomes zero capital and preserves known subtotals',()=>{
 const rows=availableLocalCapitalRows([{product_id:1,quantity:4,unit_cost:7},{product_id:2,quantity:2,unit_cost:5}], [{product_id:1,physical_recorded:4,free:null},{product_id:2,physical_recorded:2,free:2}]);
 const totals=localCapitalTotals(rows);assert.equal(rows[0].inventory_value,null);assert.equal(totals.value,null);assert.equal(totals.quantity,null);assert.equal(totals.known_value,10);assert.equal(totals.availability_unknown_count,1);
});
test('procurement gaps are based on shipped child quantities, not negative balance or order counts',()=>{
 const rows=[{product_id:1,quantity:0,unit_cost:2},{product_id:2,quantity:-10,unit_cost:1}];
 const states=[{product_id:1,free:0,physical_recorded:0},{product_id:2,free:null,physical_recorded:-10}];
 const coverage=new Map([[1,{entered_transport:true,stock_location:'LOCAL',items:[{product_id:1,quantity:6,missing_purchase_quantity:4,missing_receipt_quantity:2}]}],[2,{entered_transport:false,stock_location:'LOCAL',items:[{product_id:1,quantity:100,missing_purchase_quantity:100}]}],[3,{entered_transport:true,stock_location:'FBP',items:[{product_id:1,quantity:99,missing_purchase_quantity:99}]}]]);
 const result=availableLocalCapitalRows(rows,states,coverage);
 assert.equal(result.length,2);assert.equal(result[0].missing_purchase_quantity,4);assert.equal(result[0].missing_receipt_quantity,2);assert.equal(result[0].shipped_quantity,6);assert.equal(result[1].missing_purchase_quantity,0);assert.equal(localCapitalTotals(result).missing_purchase_count,1);
});

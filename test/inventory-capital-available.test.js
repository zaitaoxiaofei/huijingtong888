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

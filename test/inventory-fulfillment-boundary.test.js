import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLedger,planLedgerAction,ledgerRevision} from '../src/services/procurement-ledger.js';
import {inventoryStocktakeBody} from '../src/services/inventory-ledger-view.js';
import {calculateOrderProcurementCoverage} from '../src/services/order-procurement-coverage.js';

test('FBP order aliases do not consume local stock, safety, purchases or stocktake quantities',()=>{
 const demands=[{order_id:1,order_item_id:1,product_id:10,quantity:4,needs_fulfillment:1,stock_location:'LOCAL'},
  ...['FBP','OGR','FBO'].map((location,i)=>({order_id:i+2,order_item_id:i+2,product_id:10,quantity:50,needs_fulfillment:1,stock_location:location}))];
 const coverage=calculateOrderProcurementCoverage({demands,stocks:[{product_id:10,ledger:10,open_deducted:0,fbp_reserved:2}]});
 for(const row of coverage.values())if(row.stock_location==='FBP')assert.equal(row.items[0].shortage_quantity,0);
 const stock=summarizeLedger({id:10},[{stock_location:'LOCAL',quantity_delta:10},{stock_location:'FBP',quantity_delta:1000},{stock_location:'OGR',quantity_delta:1000}],[],demands,2);
 assert.equal(stock.physical_estimate,10);assert.equal(stock.open_order_demand,4);assert.equal(stock.available_estimate,4);
 assert.deepEqual(stock.fulfillment_summary,{fbs:{order_count:1,quantity:4},fbp:{order_count:3,quantity:150}});
 assert.equal(stock.orders.length,1);
 assert.equal(ledgerRevision(stock),ledgerRevision({...stock,fulfillment_summary:{...stock.fulfillment_summary,fbp:{order_count:9,quantity:500}}}),'FBP display changes do not conflict with a local count');
 assert.equal(inventoryStocktakeBody({action_type:'stocktake',stock_location:'FBP',fbp_inventory:99}).stock_location,undefined);
 const plan=planLedgerAction(stock,{action_type:'stocktake',counted_quantity:20,stocktake_type:'physical',reason_code:'history_error'});assert.equal(plan.available_after,14);
});

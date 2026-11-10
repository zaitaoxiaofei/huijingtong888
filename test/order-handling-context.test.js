import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {withOrderHandlingContext} from '../src/services/order-handling-context.js';
import {orderHandlingContext,orderHandlingRow} from '../frontend/admin/utils/order-handling-context.js';
import {inventoryLedgerView} from '../src/services/inventory-ledger-view.js';
import {summarizeLedger} from '../src/services/procurement-ledger.js';

test('printed, unprinted and unavailable records remain distinct; unknown marks are never called unmarked',()=>{
 assert.equal(orderHandlingContext({}).printLabel,'打印待核');
 assert.equal(orderHandlingContext({printed_at:null,mark_type:''}).printLabel,'未打印');
 assert.equal(orderHandlingContext({printed_at:'2026-11-10 01:00:00',mark_type:''}).printLabel,'已打印');
 assert.equal(orderHandlingContext({mark_type:''}).markLabel,'无标记');
 assert.equal(orderHandlingContext({mark_type:'quality'}).markColor,'red');
 assert.match(orderHandlingContext({mark_type:'legacy_custom'}).markLabel,/legacy_custom/);
 assert.equal(orderHandlingContext({mark_type:'legacy_custom'}).marked,true);
});

test('empty current notes do not resurrect old text; legacy manual notes still display',()=>{
 assert.equal(orderHandlingContext({manual_note:' 核对包装\n不要贴字 '}).note,'核对包装\n不要贴字');
 assert.equal(orderHandlingContext({mark_note:'',manual_note:'旧备注'}).note,'');
});

test('print history and marks enrich each order once, with tenant scope and without modifying demand',async()=>{
 const rows=[{order_id:1,quantity:2,needs_fulfillment:true,stock_location:'LOCAL',stock_quantity:0,shortage_quantity:2},
  {order_id:1,quantity:1,needs_fulfillment:true,stock_location:'LOCAL',stock_quantity:0,shortage_quantity:1},
  {order_id:2,quantity:3,needs_fulfillment:true,stock_location:'LOCAL',stock_quantity:1,shortage_quantity:2}];
 const original=structuredClone(rows),calls=[];
 const enriched=await withOrderHandlingContext(rows,async(sql,params)=>{
  calls.push({sql,params});
  return[{order_id:1,printed_at:'2026-11-10 01:00:00',mark_type:'',mark_note:'包装已核对'},
    {order_id:2,printed_at:null,mark_type:'quality',mark_note:'暂缓，等确认'}];
 },{id:2,isDefault:false});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].params,[1,2]);
 assert.match(calls[0].sql,/JOIN shops s.*s.tenant_id = 2/);
 assert.match(calls[0].sql,/LEFT JOIN order_label_prints printed ON printed.order_id=o.id/);
 assert.doesNotMatch(calls[0].sql,/raw_json|INSERT|UPDATE|DELETE/);
 assert.deepEqual(rows,original);
 assert.equal(enriched[1].printed_at,enriched[0].printed_at);
 assert.equal(enriched[2].mark_type,'quality');
 const before=summarizeLedger({},[],[],rows),after=summarizeLedger({},[],[],enriched);
 for(const key of ['open_order_demand','current_stock_reserved','current_shortage','local_stock','physical_estimate'])assert.equal(after[key],before[key]);
 assert.equal(after.open_order_demand,6,'printed and unmarked cannot imply fulfilled');
 assert.equal(enriched[0].needs_fulfillment,true);
});

test('metadata reads are bounded batches, skip invalid IDs and leave unavailable context unknown',async()=>{
 let queries=0;
 const rows=Array.from({length:1001},(_,i)=>({order_id:i+1}));rows.push({order_id:1},{order_id:NaN});
 const result=await withOrderHandlingContext(rows,async(sql,params)=>{
  queries++;assert.ok(params.length<=500);assert.equal((sql.match(/\?/g)||[]).length,params.length);return[];
 },{id:2,isDefault:false});
 assert.equal(queries,3);assert.equal(result[0],rows[0]);
 assert.equal(orderHandlingContext(result[0]).printLabel,'打印待核');
 await withOrderHandlingContext([],()=>{throw Error('must not query');},{id:2});
 await assert.rejects(withOrderHandlingContext([{order_id:1}],async()=>[],{id:'2 OR 1=1'}),/Invalid inventory tenant/);
});

test('detail lookup cannot confuse identical posting numbers in separate shops',()=>{
 const orders=[{order_id:1,shop_id:10,order_item_id:11,posting_number:'same',mark_type:'quality'},
  {order_id:2,shop_id:20,order_item_id:22,posting_number:'same',mark_type:''}];
 assert.equal(orderHandlingRow(orders,{order_id:2}).mark_type,'');
 assert.equal(orderHandlingRow(orders,{order_item_id:11}).mark_type,'quality');
 const ambiguous={posting_number:'same'};
 assert.equal(orderHandlingRow(orders,ambiguous),ambiguous);
 assert.equal(orderHandlingRow(orders,{posting_number:'same',shop_id:20}).order_id,2);
 const missing={order_id:3,posting_number:'same'};
 assert.equal(orderHandlingRow(orders,missing),missing);
});

test('restricted inventory ledger keeps handling facts while still hiding purchase costs',()=>{
 const row={order_id:1,quantity:2,printed_at:null,mark_type:'urgent',mark_note:'先核对',purchase_cost:1000,amount:9999};
 const result=inventoryLedgerView({orders:[row]});
 assert.equal(result.orders[0].printed_at,null);assert.equal(result.orders[0].mark_note,'先核对');
 assert.equal(result.orders[0].purchase_cost,undefined);assert.equal(result.orders[0].amount,undefined);
});

test('all reviewed procurement and inventory detail entry points use the common summary',async()=>{
 for(const name of ['ProcurementDemandDetails','InventoryNodeRecords','ProcurementOrderNotesDialog','ProcurementDemandCancellationDialog','ProcurementLedgerDialog']){
  const source=await readFile(new URL(`../frontend/admin/components/procurement/${name}.vue`,import.meta.url),'utf8');
  assert.match(source,/<OrderHandlingSummary /,name);
 }
 const inventory=await readFile(new URL('../frontend/admin/views/inventory/InventoryProductsPage.vue',import.meta.url),'utf8');
 assert.equal((inventory.match(/<OrderHandlingSummary /g)||[]).length,2);
 for(const name of ['procurement-demand-details','inventory-node-records']){
  const source=await readFile(new URL(`../src/services/${name}.js`,import.meta.url),'utf8');
  assert.match(source,/LEFT JOIN order_label_prints printed ON printed.order_id=o.id/);
  assert.match(source,/printed\.printed_at/);assert.match(source,/mark_type/);
 }
});

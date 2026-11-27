import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick} from 'vue';
import {component} from './mobile-performance-profile.test.js';
import {inventoryOverview} from '../frontend/orders/utils/inventory-overview.js';
const settle=async()=>{await nextTick();await new Promise(setImmediate);};
const context={product:{id:200,name:'套装'},revision:'v1',finished_physical:0,finished_available:0,finished_reserved:0,assemblable:4,assembly_capacity:4,maximum_available:4,components:[{product_id:210,name:'A',physical_stock:4,per_set_quantity:1,stock_unit:'件'},{product_id:211,name:'B',physical_stock:10,per_set_quantity:1,stock_unit:'件'}],batches:[]};
test('assembly previews two finished kits and the exact remaining loose pieces without writing',async()=>{
 const h=await component('components/inventory/InventoryBundleConversion.vue',{get:async()=>structuredClone(context)}),events=[];
 const sut=h.definition.setup({productId:200,readOnly:false},{expose(){},emit:(event,value)=>events.push({event,value})});await settle();sut.quantity.value=2;await settle();
 assert.deepEqual(JSON.parse(JSON.stringify(sut.previewRows.value.map(r=>[r.before,r.delta,r.after]))),[[0,2,2],[4,-2,2],[10,-2,8]]);assert.equal(h.calls.filter(c=>c.method==='POST').length,0);assert.ok(events.some(e=>e.event==='state'&&e.value.label==='确认组装 2 套'));
});
test('disassembly previews current loose stock instead of the historical batch snapshot',async()=>{
 const data={...structuredClone(context),finished_physical:2,finished_available:2,batches:[{id:9,remaining:2,components:[{...context.components[0],physical_stock:100},{...context.components[1],physical_stock:100}]}],components:context.components.map((p,i)=>({...p,physical_stock:i?8:2}))};
 const h=await component('components/inventory/InventoryBundleConversion.vue',{get:async()=>data}),sut=h.definition.setup({productId:200},{expose(){},emit(){}});await settle();sut.action.value='disassemble';sut.quantity.value=1;
 assert.deepEqual(JSON.parse(JSON.stringify(sut.previewRows.value.map(r=>[r.before,r.delta,r.after]))),[[2,-1,1],[2,1,3],[8,1,9]]);
});
test('unknown submission results retain their request identity and readonly details cannot convert',async()=>{
 const writes=[];let fail=true;const h=await component('components/inventory/InventoryBundleConversion.vue',{get:async()=>structuredClone(context),post:async(_url,body)=>{writes.push(body);if(fail){fail=false;throw Object.assign(new Error('network'),{status:500});}return{ok:true,action:'assemble'};}}),sut=h.definition.setup({productId:200,readOnly:false},{expose(){},emit(){}});await settle();sut.quantity.value=2;await sut.save();assert.ok(sut.submission.value);await sut.save();assert.equal(writes.length,2);assert.equal(writes[0].request_key,writes[1].request_key);assert.equal(writes[1].quantity,2);
 const reader=await component('components/inventory/InventoryBundleConversion.vue',{get:async()=>structuredClone(context)}),readonly=reader.definition.setup({productId:200,readOnly:true},{expose(){},emit(){}});await settle();await readonly.save();assert.equal(readonly.canWrite.value,false);assert.equal(reader.calls.filter(c=>c.method==='POST').length,0);
});
test('orders show authoritative finished and total quantities independently of mixed picking allocation',()=>{
 const row={inventorySummaries:[{productId:200,componentCount:2,quantity:4,pickingItems:[{product_id:200,required_quantity:2},{product_id:210,required_quantity:2},{product_id:211,required_quantity:2}]}]};
 const quantities=new Map([[200,{finished_available:2,maximum_available:4}]]),parent=inventoryOverview(row,quantities).parents[0];assert.equal(parent.finishedAvailable,2);assert.equal(parent.maximumAvailable,4);
 assert.equal(inventoryOverview(row).parents[0].finishedAvailable,undefined,'unloaded quantities are unknown, not zero');
 assert.equal(inventoryOverview({...row,inventory_refresh_pending:true},quantities).parents[0].maximumAvailable,undefined,'pending inventory must not show stale totals');
});

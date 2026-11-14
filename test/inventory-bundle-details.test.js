import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick,reactive} from 'vue';
import {component} from './mobile-performance-profile.test.js';
const settle=async()=>{await nextTick();await new Promise(setImmediate);};
const context={product:{id:200,name:'套装',inventory_number:'2-200'},revision:'bom1',components:[{product_id:210,name:'A',inventory_number:'2-210',physical_stock:10,revision:'a1',per_set_quantity:2},{product_id:211,name:'B',inventory_number:'2-211',physical_stock:20,revision:'b1',per_set_quantity:1}],structure:[]};
test('bundle form submits exact physical children once and retains the same request after unknown results',async()=>{
 const events=[],payloads=[];let reject=true;
 const h=await component('components/inventory/InventoryBundleDetails.vue',{get:async()=>structuredClone(context),post:async(_url,body)=>{payloads.push(body);if(reject){reject=false;throw Object.assign(new Error('网络中断'),{status:500});}return{ok:true};}}),sut=h.definition.setup({productId:200,editable:true},{expose(){},emit:(event,value)=>events.push({event,value})});
 await settle();assert.equal(sut.physicalSets.value,5);sut.items.value[0].counted_quantity=12;sut.items.value[1].counted_quantity=0;sut.reason.value='history_error';
 await sut.save();assert.ok(sut.submission.value);assert.equal(events.some(e=>e.event==='saved'),false);
 await sut.save();assert.equal(payloads.length,2);assert.equal(payloads[0].request_key,payloads[1].request_key);assert.deepEqual(payloads[1].items.map(i=>[i.product_id,i.counted_quantity]),[[210,12],[211,0]]);assert.equal(events.filter(e=>e.event==='saved').length,1);
});
test('bundle conflicts refresh revisions while preserving typed zero quantities and never emit saved',async()=>{
 let revision='a1';const events=[];
 const h=await component('components/inventory/InventoryBundleDetails.vue',{get:async()=>({...structuredClone(context),components:context.components.map(c=>({...c,revision}))}),post:async()=>{revision='a2';throw Object.assign(new Error('库存已变化'),{status:409});}}),sut=h.definition.setup({productId:200,editable:true},{expose(){},emit:event=>events.push(event)});
 await settle();sut.items.value.forEach(row=>row.counted_quantity=0);sut.reason.value='history_error';await sut.save();
 assert.equal(sut.items.value[0].revision,'a2');assert.equal(sut.items.value[0].counted_quantity,0);assert.equal(sut.submission.value,null);assert.match(sut.error.value,/整批未保存/);assert.equal(sut.busy.value,false);assert.equal(events.includes('saved'),false);
});
test('bundle readonly and changed enterprise responses cannot write or restore prior inventory',async()=>{
 let resolve;const h=await component('components/inventory/InventoryBundleDetails.vue',{get:async()=>new Promise(r=>resolve=r)}),props=reactive({productId:200,editable:false}),sut=h.definition.setup(props,{expose(){},emit(){}});
 h.scope='B';sut.clear();resolve(structuredClone(context));await settle();assert.equal(sut.data.value,null);await sut.save();assert.equal(h.calls.some(c=>c.method==='POST'),false);
});
test('mobile scanned bundles expand children automatically and route updates to bundle-only dialog',async()=>{
 const h=await component('views/mobile/MobileInventoryView.vue',{get:async()=>({rows:[{id:200,component_count:2}],total:1})}),sut=h.definition.setup({},{expose(){}});
 await sut.scanned('2-200');assert.equal(sut.scannedBundleId.value,200);sut.openInventory(sut.rows.value[0],false);assert.equal(sut.bundleDialog.visible,true);assert.equal(sut.bundleDialog.id,200);assert.equal(sut.dialog.visible,false);sut.clearScope();assert.equal(sut.bundleDialog.visible,false);assert.equal(sut.scannedBundleId.value,0);
});

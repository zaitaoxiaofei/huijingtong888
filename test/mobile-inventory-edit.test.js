import test from 'node:test';
import assert from 'node:assert/strict';
import {reactive,nextTick} from 'vue';
import {component} from './mobile-performance-profile.test.js';

test('inventory edit action uses inventory.write and a stable product ID, with scope and target-change guards',async()=>{
 const packing=await component('components/inventory/InventoryProductEditAction.vue',{auth:{user:{id:7,roles:['packing'],tenant:{id:2,role:'member'}}}}),readonly=packing.definition.setup({productId:101,mobile:true},{expose(){},emit(){}});await readonly.open();assert.equal(packing.calls.length,0);assert.equal(readonly.canEdit.value,false);
 let release;const events=[],h=await component('components/inventory/InventoryProductEditAction.vue',{get:async url=>{if(url==='/api/products/101')return new Promise(resolve=>release=resolve);if(url.startsWith('/api/products/'))return{id:102,name:'新目标库存'};if(url.startsWith('/api/suppliers'))return{rows:[]};return[];}}),props=reactive({productId:101,mobile:true}),sut=h.definition.setup(props,{expose(){},emit:(event,value)=>events.push({event,value})});
 const old=sut.open();props.productId=102;await nextTick();release({id:101,name:'旧目标库存'});await old;assert.equal(sut.visible.value,false);assert.equal(sut.product.value,null);
 await sut.open();assert.equal(sut.visible.value,true);assert.equal(sut.product.value.id,102);assert.ok(h.calls.some(call=>call.path==='/api/products/102'));h.scope='other-enterprise';sut.saved({product:{id:102}});assert.equal(events.length,0);sut.reset();
});

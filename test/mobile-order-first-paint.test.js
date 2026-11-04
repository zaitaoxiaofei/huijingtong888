import test from 'node:test';
import assert from 'node:assert/strict';
import {component} from './mobile-performance-profile.test.js';
test('failed page read preserves the last successful rows without starting range-wide counts',async()=>{
 let fail;const h=await component('views/mobile/MobileOrdersView.vue',{get:async url=>{const q=new URL(url,'http://local').searchParams;if(q.get('page')==='2')return new Promise((resolve,reject)=>{fail=reject;});return{page:1,total:40,rows:[{id:1}]};}});
 const sut=h.definition.setup({}, {expose(){}});
 await sut.loadOrders();const pending=sut.loadOrders({nextPage:2});assert.equal(sut.rows.value[0].id,1);fail(Error('page unavailable'));await pending;
 assert.equal(sut.rows.value[0].id,1);assert.equal(sut.loading.value,false);assert.ok(h.calls.every(c=>c.path.includes('includeCounts=0')));assert.equal(h.timers.size,0);
});

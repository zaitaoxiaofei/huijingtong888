import test from 'node:test';
import assert from 'node:assert/strict';
import {component} from './mobile-performance-profile.test.js';
test('metadata failure preserves mobile rows and paging while explicit counts are pending',async()=>{
 let fail;const h=await component('views/mobile/MobileOrdersView.vue',{get:async url=>{const q=new URL(url,'http://local').searchParams;if(q.get('includeRows')==='0')return new Promise((resolve,reject)=>{fail=reject;});return{page:Number(q.get('page')),total:40,rows:[{id:Number(q.get('page'))}]};}});
 const sut=h.definition.setup({}, {expose(){}});
 await sut.loadOrders();assert.equal(h.calls.length,1);assert.equal(sut.loading.value,false);
 const pending=sut.loadCounts();await sut.loadOrders({nextPage:2});assert.equal(sut.rows.value[0].id,2);assert.equal(sut.countsLoading.value,true);
 fail(Error('metadata unavailable'));await pending;assert.equal(sut.rows.value[0].id,2);assert.equal(sut.countsLoading.value,false);assert.ok(sut.countsError.value);assert.equal(h.timers.size,0);
});

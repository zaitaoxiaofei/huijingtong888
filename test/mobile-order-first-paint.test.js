import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../frontend/admin/views/mobile/MobileOrdersView.vue',import.meta.url),'utf8');
function harness(get){
 const context=vm.createContext({URLSearchParams,Number,String,Array,apiClient:{get},orderSearchMatchForInput:()=> 'contains',filters:{status:'all',searchType:'order',searchQuery:'',dateFrom:'2026-10-01',dateTo:'2026-11-01'},pageSize:20,
 loading:{value:false},loadingMore:{value:false},rows:{value:[]},page:{value:1},total:{value:0},counts:{value:{}},orderLoadGeneration:0,countLoadGeneration:0,ElMessage:{error:message=>{throw Error(message);}}});
 for(const name of ['buildParams','loadOrderCounts','loadOrders']){const match=source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n}'));assert.ok(match);vm.runInContext(match[0],context);}
 return context;
}
test('mobile rows render before counts; pagination does not cancel in-flight count metadata',async()=>{
 let finish;const gate=new Promise(resolve=>{finish=resolve;});const requests=[];
 const c=harness(async url=>{const q=new URL(url,'http://local').searchParams;requests.push(q);if(q.get('includeRows')==='0')return gate;return {page:Number(q.get('page')),total:4,rows:[{id:Number(q.get('page'))}]};});
 await c.loadOrders();assert.equal(c.rows.value.length,1);assert.equal(c.loading.value,false);assert.equal(c.counts.value.all,undefined);
 assert.equal(requests[0].get('includeCounts'),'0');assert.equal(requests[1].get('includeRows'),'0');assert.equal(requests[1].get('includeCounts'),'1');
 await c.loadOrders({append:true});finish({counts:{all:4}});await new Promise(setImmediate);
 assert.equal(c.rows.value.length,2);assert.equal(c.counts.value.all,4);
});
test('late counts cannot overwrite a newer filter and metadata failure keeps usable rows',async()=>{
 const pending=[];let rowId=0;
 const c=harness(async url=>{const q=new URL(url,'http://local').searchParams;if(q.get('includeRows')==='0')return new Promise((resolve,reject)=>pending.push({resolve,reject}));return {rows:[{id:++rowId}],total:1};});
 await c.loadOrders();c.filters.status='awaiting_deliver';await c.loadOrders();pending[1].resolve({counts:{all:2}});await new Promise(setImmediate);pending[0].resolve({counts:{all:1}});await new Promise(setImmediate);assert.equal(c.counts.value.all,2);
 await c.loadOrders();pending[2].reject(Error('metadata unavailable'));await new Promise(setImmediate);assert.equal(c.rows.value[0].id,3);assert.equal(c.counts.value.all,2);assert.equal(c.loading.value,false);
});

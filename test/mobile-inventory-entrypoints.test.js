import test from 'node:test';
import assert from 'node:assert/strict';
import {reactive,nextTick} from 'vue';
import {component} from './mobile-performance-profile.test.js';

const settle=async()=>{await nextTick();await new Promise(setImmediate);};
const ledger={revision:'current',physical_estimate:7,open_order_demand:2,fbp_reserved:0,flow_summary:{safety:0}};

test('saving inventory identity keeps current search and page and refreshes only current-page local quantities',async()=>{
 const h=await component('views/mobile/MobileInventoryView.vue',{get:async()=>({rows:[{id:101,name:'新名称',inventory_number:'1-3-201'}],total:80})});
 const sut=h.definition.setup({}, {expose(){}}),refreshes=[];sut.local.refresh=async force=>refreshes.push(force);
 sut.page.value=2;sut.pageSize.value=50;sut.filters.query='1-3-101';Object.assign(sut.dialog,{visible:true,readOnly:true,product:{id:101,name:'旧名称'}});
 await sut.metadataSaved({product:{id:101,name:'新名称',inventory_number:'1-3-201'}});
 const request=new URL(h.calls.at(-1).path,'http://localhost:8788');
 assert.equal(request.pathname,'/api/products');assert.equal(request.searchParams.get('page'),'2');assert.equal(request.searchParams.get('pageSize'),'50');assert.equal(request.searchParams.get('query'),'1-3-101');
 assert.equal(sut.dialog.product.id,101);assert.equal(sut.dialog.product.name,'新名称');assert.equal(sut.dialog.product.inventory_number,'1-3-201');assert.deepEqual(refreshes,[true]);assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('readonly inventory metadata updates its own title and ledger and emits a separate metadata event',async()=>{
 const events=[],h=await component('components/mobile/MobileStocktakeDialog.vue',{get:async()=>ledger}),props=reactive({modelValue:true,readOnly:true,product:{id:101,name:'旧名称',inventory_number:'1-3-101'}});
 const sut=h.definition.setup(props,{expose(){},emit:(event,value)=>events.push({event,value})});await settle();const reads=h.calls.length;
 await sut.metadataSaved({product:{id:101,name:'新名称',inventory_number:'1-3-201'}});
 assert.equal(sut.detailProduct.value.name,'新名称');assert.equal(sut.detailProduct.value.inventory_number,'1-3-201');assert.equal(sut.data.value.physical_estimate,7);assert.equal(sut.availableBefore.value,5);assert.equal(h.calls.length,reads+1);assert.match(h.calls.at(-1).path,/product_id=101&include_flow=local/);
 assert.equal(events.filter(item=>item.event==='metadata-saved').length,1);assert.equal(events.some(item=>item.event==='saved'),false);assert.equal(h.calls.some(call=>call.method==='POST'),false);
 props.product={...props.product,name:'新名称',inventory_number:'1-3-201'};await settle();assert.equal(h.calls.length,reads+1,'refreshing the same product object does not fetch the ledger twice');
 await sut.metadataSaved({product:{id:501,name:'批次不是商品'}});assert.equal(h.calls.length,reads+1);
});

test('identity saves cannot change a pending stocktake form or apply stale inventory/scope responses',async()=>{
 const editing=await component('components/mobile/MobileStocktakeDialog.vue',{get:async()=>ledger}),counting=editing.definition.setup({modelValue:true,readOnly:false,product:{id:101}},{expose(){},emit(){}});await settle();counting.form.counted_quantity=9;const reads=editing.calls.length;await counting.metadataSaved({product:{id:101,name:'忽略'}});assert.equal(editing.calls.length,reads);assert.equal(counting.form.counted_quantity,9);
 let release,hold=false;const events=[],h=await component('components/mobile/MobileStocktakeDialog.vue',{get:async()=>hold?new Promise(resolve=>release=resolve):ledger}),props=reactive({modelValue:true,readOnly:true,product:{id:101,name:'旧目标'}}),sut=h.definition.setup(props,{expose(){},emit:(event,value)=>events.push({event,value})});await settle();
 h.calls.length=0;
 // Hold only the refresh following a completed metadata save.
 hold=true;const saved=sut.metadataSaved({product:{id:101,name:'已保存'}});const releaseOld=release;hold=false;props.product={id:102,name:'新目标'};await settle();releaseOld(ledger);await saved;
 assert.equal(sut.detailProduct.value.id,102);assert.equal(sut.detailProduct.value.name,'新目标');assert.equal(events.some(item=>item.event==='metadata-saved'),false);
 hold=true;const pending=sut.metadataSaved({product:{id:102,name:'另一次保存'}});h.scope='other';sut.clear();release(ledger);await pending;assert.equal(sut.editedProduct.value,null);assert.equal(events.some(item=>item.event==='metadata-saved'),false);
});

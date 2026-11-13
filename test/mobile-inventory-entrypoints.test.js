import test from 'node:test';
import assert from 'node:assert/strict';
import {reactive,nextTick} from 'vue';
import {component} from './mobile-performance-profile.test.js';

const settle=async()=>{await nextTick();await new Promise(setImmediate);};
const ledger={revision:'current',physical_estimate:7,open_order_demand:2,fbp_reserved:0,flow_summary:{safety:0}};

test('scanned inventory resets unrelated filters and page, uses exact search, and clears scanner on scope change',async()=>{
 const h=await component('views/mobile/MobileInventoryView.vue',{get:async()=>({rows:[{id:7,inventory_number:'1-7'}],total:1})}),sut=h.definition.setup({}, {expose(){}});
 sut.page.value=3;sut.filters.inventoryType='combo';sut.filters.searchMode='name';sut.filters.inventoryCategory='门槛条';sut.scannerVisible.value=true;
 sut.scanned('1-7');await settle();
 const query=new URL(h.calls.at(-1).path,'http://localhost:8788').searchParams;
 assert.equal(query.get('query'),'1-7');assert.equal(query.get('searchMode'),'inventory_id');assert.equal(query.get('page'),'1');assert.equal(query.get('inventoryType'),'all');assert.equal(query.has('inventoryCategory'),false);
 assert.equal(sut.rows.value[0].id,7);assert.equal(sut.scannerVisible.value,false);assert.equal(h.calls.some(call=>call.method==='POST'),false);
 sut.scannerVisible.value=true;sut.clearScope();assert.equal(sut.scannerVisible.value,false);assert.equal(sut.rows.value.length,0);
});

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

test('mobile alert actions accept only canonical positive product IDs and never mapping, SKU or online IDs',async()=>{
 const h=await component('views/mobile/MobileStockAlertsView.vue'),sut=h.definition.setup({}, {expose(){}});
 assert.equal(sut.productId({product_id:101,mapping_id:501}),101);assert.equal(sut.productId({product_id:'102'}),102);
 for(const row of [{id:501,mapping_id:501,ozon_product_id:101},{product_id:null,id:101},{product_id:-1},{product_id:1.5},{product_id:'invalid'}])assert.equal(sut.productId(row),0);
});

test('alert identity refresh rereads the loaded page range and retains its query and backend metrics',async()=>{
 let renamed=false;const h=await component('views/mobile/MobileStockAlertsView.vue',{get:async url=>{const p=new URL(url,'http://localhost:8788').searchParams;return{rows:[{product_id:101,ozon_sku:`S-${p.get('page')}`,product_name:renamed?'新名称':'旧名称',fbp_available:5,suggested_qty:12}],page:Number(p.get('page')),total:60};}}),sut=h.definition.setup({}, {expose(){}});
 sut.query.value='1-3-101';await sut.loadAlerts();await sut.loadAlerts({append:true});await sut.loadAlerts({append:true});assert.equal(sut.page.value,3);assert.equal(sut.rows.value.length,3);const start=h.calls.length;renamed=true;await sut.loadAlerts({refreshLoaded:true});
 const requests=h.calls.slice(start).map(call=>new URL(call.path,'http://localhost:8788').searchParams);assert.deepEqual(requests.map(p=>p.get('page')),['1','2','3']);assert.equal(requests[0].get('refresh'),'1');assert.equal(requests[1].has('refresh'),false);assert.ok(requests.every(p=>p.get('query')==='1-3-101'&&p.get('mode')==='fbp-alerts'&&p.get('pageSize')==='20'));
 assert.equal(sut.page.value,3);assert.equal(sut.rows.value.length,3);assert.equal(sut.total.value,60);assert.ok(sut.rows.value.every(row=>row.product_name==='新名称'&&row.fbp_available===5&&row.suggested_qty===12));assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('late alert queries and prior-enterprise responses cannot replace current rows or loading state',async()=>{
 let release;const h=await component('views/mobile/MobileStockAlertsView.vue',{get:async url=>url.includes('query=old')?new Promise(resolve=>release=resolve):{rows:[{product_id:102}],page:1,total:1}}),sut=h.definition.setup({}, {expose(){}});
 sut.query.value='old';const old=sut.loadAlerts();sut.query.value='new';await sut.loadAlerts();release({rows:[{product_id:101}],page:1,total:1});await old;assert.equal(sut.rows.value[0].product_id,102);assert.equal(sut.loading.value,false);
 sut.query.value='old';const pending=sut.loadAlerts();h.scope='B';sut.clearScope();release({rows:[{product_id:101}],page:4,total:99});await pending;assert.equal(sut.rows.value.length,0);assert.equal(sut.total.value,0);assert.equal(sut.page.value,1);assert.equal(sut.loading.value,false);
});

test('an unsubmitted alert search stays a draft while append and identity refresh retain the applied keyword',async()=>{
 const h=await component('views/mobile/MobileStockAlertsView.vue',{get:async url=>{const p=new URL(url,'http://localhost:8788').searchParams;return{rows:[{product_id:101,ozon_sku:`SKU-${p.get('page')}`}],page:Number(p.get('page')),total:60};}}),sut=h.definition.setup({}, {expose(){}});
 sut.query.value='applied';await sut.loadAlerts();sut.query.value='draft';await sut.loadAlerts({append:true});await sut.loadAlerts({refreshLoaded:true});
 assert.equal(sut.query.value,'draft');assert.equal(sut.appliedQuery.value,'applied');assert.equal(sut.rows.value.length,2);assert.equal(sut.page.value,2);assert.ok(h.calls.every(call=>new URL(call.path,'http://localhost:8788').searchParams.get('query')==='applied'));
});

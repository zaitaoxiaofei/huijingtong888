import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick,reactive} from 'vue';
import {component} from './mobile-performance-profile.test.js';

const row=(id,quantity=600,extra={})=>({id,product_id:id,product_name:`物料 ${id}`,quantity,updated_at:'2026-11-06 01:00:00',...extra});
const settle=async()=>{await nextTick();await new Promise(setImmediate);};

test('mobile shared warehouse queue shows unmarked purchases, retains old dates and clears selections on filter changes',async()=>{
 const h=await component('components/mobile/MobileWorkQueue.vue',{auth:{user:{id:3,roles:['packing'],tenant:{id:2,role:'member'}}},get:async url=>{const p=new URL(url,'http://localhost').searchParams;return{rows:[row(1),row(2,20,{review_required:true})],days:[{date:'2026-01-02',pending:1,open:1,arrived:0},{date:'2026-11-06',pending:2,open:0,arrived:2}],selected_day:p.get('status')==='arrived'?'2026-11-06':'2026-01-02',page:1,total:2};}}),sut=h.definition.setup({warehouse:true},{expose(){},emit(){}});
 await sut.load();assert.equal(sut.tab.value,'pending');assert.equal(new URL(h.calls.at(-1).path,'http://localhost').searchParams.get('status'),'pending');assert.equal(sut.selectedDay.value,'2026-01-02');assert.deepEqual([...sut.dateTabs.value.map(day=>day.date)],['2026-01-02','2026-11-06']);assert.equal(sut.dateGroups.value[0].monthLabel,'2026年1月');
 sut.selectPage(true);assert.deepEqual([...sut.selected.value],[1]);await sut.load();assert.equal(sut.selected.value.length,0);assert.match(h.calls.at(-1).path,/purchase_day=2026-01-02/);
 sut.openReceive(row(4));assert.equal(sut.receive.visible,true,'warehouse can receive without purchaser marking arrival');sut.receive.visible=false;
 sut.queueStatus.value='arrived';await settle();const p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;assert.equal(p.get('status'),'arrived');assert.equal(p.get('day_mode'),'pending');assert.equal(p.has('purchase_day'),false);
 assert.equal(sut.dateTabs.value.length,1);assert.equal(sut.dateTabs.value[0].dayLabel,'6号');sut.reset();
});

test('late mobile queue searches and previous-enterprise responses cannot replace current dates or rows',async()=>{
 let release;
 const h=await component('components/mobile/MobileWorkQueue.vue',{get:async url=>{const p=new URL(url,'http://localhost').searchParams;if(p.get('query')==='old')return new Promise(resolve=>release=resolve);return{rows:[row(8)],days:[{date:'2026-11-06',pending:1,open:1}],selected_day:'2026-11-06',page:1,total:1};}}),sut=h.definition.setup({warehouse:false},{expose(){},emit(){}});
 sut.tab.value='pending';await settle();sut.filters.query='old';const previous=sut.load(true);sut.filters.query='new';await sut.load(true);release({rows:[row(99)],days:[{date:'2020-01-01',pending:1,open:1}],selected_day:'2020-01-01'});await previous;assert.equal(sut.rows.value[0].id,8);assert.equal(sut.selectedDay.value,'2026-11-06');
 sut.filters.query='old';const foreign=sut.load(true);h.scope='B';sut.reset();release({rows:[row(100)],days:[{date:'2020-01-01',open:1}],selected_day:'2020-01-01'});await foreign;assert.equal(sut.rows.value.length,0);assert.equal(sut.purchaseDays.value.length,0);assert.equal(sut.loading.value,false);
});

test('mobile receipt filters use pending for all states, preserve purchase dates and reset every filter',async()=>{
 const h=await component('components/mobile/MobileWorkQueue.vue'),sut=h.definition.setup({warehouse:true},{expose(){},emit(){}});
 assert.equal(sut.canStocktake({product_id:1,is_bundle:false}),true);assert.equal(sut.canStocktake({product_id:1,is_bundle:true,review_required:false}),false,'reviewed bundles still require stocktake of physical components');
 sut.purchaseRange.start='2026-10-01';sut.purchaseRange.end='2026-10-31';sut.filters.query='1-3-1';await sut.load(true);let p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;
 assert.equal(p.get('status'),'pending');assert.equal(p.get('start_date'),'2026-10-01');assert.equal(p.get('end_date'),'2026-10-31');assert.equal(p.get('query'),'1-3-1');assert.equal(sut.queueFilters[0][1],'全部状态');
 sut.queueStatus.value='arrived';await settle();sut.resetFilters();await settle();p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;
 assert.equal(p.get('status'),'pending');assert.equal(p.has('start_date'),false);assert.equal(p.has('end_date'),false);assert.equal(p.get('query'),'');assert.equal(sut.purchaseRange.start,'');assert.equal(sut.purchaseRange.end,'');assert.equal(sut.selected.value.length,0);
 const count=h.calls.length;sut.purchaseRange.start='2026-11-10';sut.purchaseRange.end='2026-11-01';await sut.load(true);assert.equal(h.calls.length,count);assert.match(sut.error.value,/开始日期不能晚于结束日期/);assert.equal(sut.loading.value,false);sut.reset();
});

test('mobile warehouse completed receipts use received-only history without a recent purchase cutoff',async()=>{
 const h=await component('components/mobile/MobileWorkQueue.vue',{auth:{user:{id:3,roles:['packing'],tenant:{id:2,role:'member'}}}}),sut=h.definition.setup({warehouse:false},{expose(){},emit(){}});
 sut.queueMore('received');await settle();let p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;
 assert.equal(sut.tab.value,'received');assert.equal(p.get('status'),'received');assert.equal(p.has('recent'),false);assert.equal(p.has('day_mode'),false);assert.equal(sut.canBatch.value,false);assert.equal(sut.canPurchase.value,false);assert.equal(h.calls.some(call=>call.path.includes('status=all')),false);
 sut.queueMore('pending');await settle();p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;assert.equal(p.get('status'),'pending');assert.equal(sut.tab.value,'pending');sut.reset();
});

test('mobile arrival supports 80 of 600 with optional notes and retries only failed batches using unchanged keys',async()=>{
 let failed=false;const events=[];
 const h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:async(_url,body)=>{if(body.id===2&&!failed){failed=true;throw Error('响应暂不可用');}return{quantity:body.quantity,remaining_quantity:body.expected_quantity-body.quantity};}}),props=reactive({modelValue:true,status:'open',rows:[row(1),row(2,3)]}),sut=h.definition.setup(props,{expose(){},emit:(event,value)=>events.push({event,value})});
 sut.entries.value[0].actual=80;await sut.submit();assert.equal(sut.done.value,1);assert.equal(h.calls.length,2);const first=h.calls.find(call=>call.body.id===1).body,second=h.calls.find(call=>call.body.id===2).body;
 assert.equal(first.quantity,80);assert.equal(first.expected_quantity,600);assert.match(first.note,/剩余 520 件/);assert.equal(sut.remaining(sut.groups.value[0]),520);await sut.submit();assert.equal(sut.finished.value,true);assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.request_key,second.request_key);assert.equal(h.calls.filter(call=>call.body.id===1).length,1);await sut.submit();assert.equal(h.calls.length,3);assert.ok(events.some(event=>event.event==='changed'));
});

test('mobile receipt groups by product, requires partial reasons and ready photos, then freezes preview revision',async()=>{
 const h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:async url=>url.endsWith('/preview')?{revision:'checked',quantity:82,physical_before:10,physical_after:92}:{ok:true}}),sut=h.definition.setup({modelValue:true,status:'arrived',rows:[row(1,100,{received_at:'2026-11-06 02:00:00'}),row(2,2,{product_id:1,received_at:'2026-11-06 02:00:00'})]},{expose(){},emit(){}});
 assert.equal(sut.groups.value.length,1);sut.entries.value[0].actual=80;await sut.preview();assert.match(sut.error.value,/请选择保留余量/);assert.equal(h.calls.length,0);
 sut.entries.value[0].difference_kind='partial';await sut.preview();assert.match(sut.error.value,/原因/);sut.entries.value[0].reason='剩余20件尚未到仓';sut.entries.value[0].photoState.ready=false;await sut.preview();assert.equal(h.calls.length,0);
 sut.entries.value[0].photoState.ready=true;sut.entries.value[0].photos=['/uploads/team-attachments/photo.jpg'];await sut.preview();assert.equal(sut.previewed.value,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.records.length,2);assert.equal(h.calls[0].body.records[0].receipt_images_json[0],'/uploads/team-attachments/photo.jpg');assert.equal(h.calls[0].body.records[1].receipt_images_json,undefined);
 await sut.submit();assert.equal(h.calls[1].body.expected_revision,'checked');assert.equal(h.calls[1].body.request_key,h.calls[0].body.request_key);assert.equal(h.calls[1].body.receipt_mode,'new_arrival');await sut.submit();assert.equal(h.calls.length,2);
});

test('mobile role and composition guards prevent writes and stale scopes cannot apply arrival results',async()=>{
 const packing={user:{id:3,roles:['packing'],tenant:{id:2,role:'member'}}};
 const denied=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:packing}),a=denied.definition.setup({modelValue:true,status:'remind',rows:[row(1)]},{expose(){},emit(){}});await a.submit();assert.equal(denied.calls.length,0);assert.equal(a.allowed.value,false);
 const purchaser=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:{user:{id:4,roles:['procurement'],tenant:{id:2,role:'member'}}}}),p=purchaser.definition.setup({modelValue:true,status:'arrived',rows:[row(1)]},{expose(){},emit(){}});await p.preview();await p.submit();assert.equal(purchaser.calls.length,0);assert.equal(p.allowed.value,false);
 const warehouse=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:packing}),w=warehouse.definition.setup({modelValue:true,status:'open',rows:[row(1)]},{expose(){},emit(){}});assert.equal(w.allowed.value,true,'warehouse may confirm physical arrival');
 const blocked=await component('components/mobile/MobilePurchaseBatchDialog.vue'),b=blocked.definition.setup({modelValue:true,status:'arrived',rows:[row(1,3,{review_required:true,received_at:'2026-11-06 02:00:00'})]},{expose(){},emit(){}});await b.preview();await b.submit();assert.equal(blocked.calls.length,0);
 let resolve;const events=[],h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:()=>new Promise(done=>resolve=done)}),sut=h.definition.setup({modelValue:true,status:'open',rows:[row(1)]},{expose(){},emit:(event,value)=>events.push({event,value})});const pending=sut.submit();await sut.submit();assert.equal(h.calls.length,1);h.scope='B';sut.scopeChanged();resolve({quantity:600,remaining_quantity:0});await pending;assert.equal(sut.done.value,0);assert.equal(events.some(event=>event.event==='changed'),false);
});

test('mobile arrival reminder retries the same observed batch without claiming a physical quantity',async()=>{
 let first=true;const original=row(1,600),h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:{user:{id:4,roles:['procurement'],tenant:{id:2,role:'member'}}},post:async()=>{if(first){first=false;throw Error('提醒响应丢失');}return{ok:true};}}),sut=h.definition.setup({modelValue:true,status:'remind',rows:[original]},{expose(){},emit(){}});
 sut.note.value='物流显示门卫处，请查收';await sut.submit();assert.equal(sut.done.value,0);const body=h.calls[0].body;assert.equal(body.operation,'remind');assert.equal(body.expected_quantity,600);assert.equal(body.expected_updated_at,original.updated_at);assert.equal(Object.hasOwn(body,'quantity'),false);assert.equal(body.note,'物流显示门卫处，请查收');
 sut.note.value='响应丢失后的新输入不会覆盖原请求';await sut.submit();assert.equal(sut.finished.value,true);assert.equal(h.calls[1].body.request_key,body.request_key);assert.equal(h.calls[1].body.note,body.note);assert.equal(original.quantity,600);assert.equal(original.received_at,undefined);
});

test('mobile warehouse previews and receives an unmarked batch directly, preserving the remainder',async()=>{
 const h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:{user:{id:3,roles:['packing'],tenant:{id:2,role:'member'}}},post:async url=>url.endsWith('/preview')?{revision:'unmarked-revision',quantity:80,physical_before:0,physical_after:80}:{ok:true,quantity:80,remaining_quantity:520}}),sut=h.definition.setup({modelValue:true,status:'arrived',rows:[row(1,600)]},{expose(){},emit(){}});
 assert.equal(sut.groups.value.length,1);sut.entries.value[0].actual=80;sut.entries.value[0].difference_kind='partial';sut.entries.value[0].reason='本次仅收到80件';await sut.preview();assert.equal(sut.previewed.value,true);assert.equal(h.calls[0].body.records[0].quantity,80);await sut.submit();assert.equal(sut.finished.value,true);assert.equal(h.calls[1].body.expected_revision,'unmarked-revision');assert.equal(sut.remaining(sut.groups.value[0]),520);
});

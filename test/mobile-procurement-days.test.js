import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick,reactive} from 'vue';
import {component} from './mobile-performance-profile.test.js';

const row=(id,quantity=600,extra={})=>({id,product_id:id,product_name:`物料 ${id}`,quantity,updated_at:'2026-11-06 01:00:00',...extra});
const settle=async()=>{await nextTick();await new Promise(setImmediate);};

test('mobile pending queues retain old dates, use exact arrived status, and clear page selections on reads',async()=>{
 const h=await component('components/mobile/MobileWorkQueue.vue',{get:async url=>{const p=new URL(url,'http://localhost').searchParams;return{rows:[row(1),row(2,20,{review_required:true})],days:[{date:'2026-01-02',open:1,arrived:0},{date:'2026-11-06',open:0,arrived:2}],selected_day:p.get('status')==='open'?'2026-01-02':'2026-11-06',page:1,total:2};}}),sut=h.definition.setup({warehouse:false},{expose(){},emit(){}});
 sut.tab.value='open';await settle();assert.equal(sut.selectedDay.value,'2026-01-02');assert.deepEqual([...sut.dateTabs.value.map(day=>day.date)],['2026-01-02']);assert.equal(sut.dateGroups.value[0].monthLabel,'2026年1月');
 sut.selectPage(true);assert.deepEqual([...sut.selected.value],[1]);await sut.load();assert.equal(sut.selected.value.length,0);assert.match(h.calls.at(-1).path,/purchase_day=2026-01-02/);
 sut.tab.value='arrived';await settle();const p=new URL(h.calls.at(-1).path,'http://localhost').searchParams;assert.equal(p.get('status'),'arrived');assert.equal(p.get('day_mode'),'pending');assert.equal(p.has('purchase_day'),false);
 assert.equal(sut.dateTabs.value.length,1);assert.equal(sut.dateTabs.value[0].dayLabel,'6号');sut.openReceive(row(4));assert.equal(sut.receive.visible,false);sut.reset();
});

test('late mobile queue searches and previous-enterprise responses cannot replace current dates or rows',async()=>{
 let release;
 const h=await component('components/mobile/MobileWorkQueue.vue',{get:async url=>{const p=new URL(url,'http://localhost').searchParams;if(p.get('query')==='old')return new Promise(resolve=>release=resolve);return{rows:[row(8)],days:[{date:'2026-11-06',open:1}],selected_day:'2026-11-06',page:1,total:1};}}),sut=h.definition.setup({warehouse:false},{expose(){},emit(){}});
 sut.tab.value='open';await settle();sut.filters.query='old';const previous=sut.load(true);sut.filters.query='new';await sut.load(true);release({rows:[row(99)],days:[{date:'2020-01-01',open:1}],selected_day:'2020-01-01'});await previous;assert.equal(sut.rows.value[0].id,8);assert.equal(sut.selectedDay.value,'2026-11-06');
 sut.filters.query='old';const foreign=sut.load(true);h.scope='B';sut.reset();release({rows:[row(100)],days:[{date:'2020-01-01',open:1}],selected_day:'2020-01-01'});await foreign;assert.equal(sut.rows.value.length,0);assert.equal(sut.purchaseDays.value.length,0);assert.equal(sut.loading.value,false);
});

test('mobile arrival supports 80 of 600 with optional notes and retries only failed batches using unchanged keys',async()=>{
 let failed=false;const events=[];
 const h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:async(_url,body)=>{if(body.id===2&&!failed){failed=true;throw Error('响应暂不可用');}return{quantity:body.quantity,remaining_quantity:body.expected_quantity-body.quantity};}}),props=reactive({modelValue:true,status:'open',rows:[row(1),row(2,3)]}),sut=h.definition.setup(props,{expose(){},emit:(event,value)=>events.push({event,value})});
 sut.entries.value[0].actual=80;await sut.submit();assert.equal(sut.done.value,1);assert.equal(h.calls.length,2);const first=h.calls.find(call=>call.body.id===1).body,second=h.calls.find(call=>call.body.id===2).body;
 assert.equal(first.quantity,80);assert.equal(first.expected_quantity,600);assert.match(first.note,/剩余 520 件/);assert.equal(sut.remaining(sut.groups.value[0]),520);await sut.submit();assert.equal(sut.finished.value,true);assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.request_key,second.request_key);assert.equal(h.calls.filter(call=>call.body.id===1).length,1);await sut.submit();assert.equal(h.calls.length,3);assert.ok(events.some(event=>event.event==='changed'));
});

test('mobile receipt groups by product, requires partial reasons and ready photos, then freezes preview revision',async()=>{
 const h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:async url=>url.endsWith('/preview')?{revision:'checked',quantity:82,physical_before:10,physical_after:92}:{ok:true}}),sut=h.definition.setup({modelValue:true,status:'arrived',rows:[row(1,100,{received_at:'2026-11-06 02:00:00'}),row(2,2,{product_id:1,received_at:'2026-11-06 02:00:00'})]},{expose(){},emit(){}});
 assert.equal(sut.groups.value.length,1);sut.entries.value[0].actual=80;await sut.preview();assert.match(sut.error.value,/请选择分批到货/);assert.equal(h.calls.length,0);
 sut.entries.value[0].difference_kind='partial';await sut.preview();assert.match(sut.error.value,/原因/);sut.entries.value[0].reason='剩余20件尚未到仓';sut.entries.value[0].photoState.ready=false;await sut.preview();assert.equal(h.calls.length,0);
 sut.entries.value[0].photoState.ready=true;sut.entries.value[0].photos=['/uploads/team-attachments/photo.jpg'];await sut.preview();assert.equal(sut.previewed.value,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.records.length,2);assert.equal(h.calls[0].body.records[0].receipt_images_json[0],'/uploads/team-attachments/photo.jpg');assert.equal(h.calls[0].body.records[1].receipt_images_json,undefined);
 await sut.submit();assert.equal(h.calls[1].body.expected_revision,'checked');assert.equal(h.calls[1].body.request_key,h.calls[0].body.request_key);assert.equal(h.calls[1].body.receipt_mode,'new_arrival');await sut.submit();assert.equal(h.calls.length,2);
});

test('mobile role and composition guards prevent writes and stale scopes cannot apply arrival results',async()=>{
 const packing={user:{id:3,roles:['packing'],tenant:{id:2,role:'member'}}};
 const denied=await component('components/mobile/MobilePurchaseBatchDialog.vue',{auth:packing}),a=denied.definition.setup({modelValue:true,status:'open',rows:[row(1)]},{expose(){},emit(){}});await a.submit();assert.equal(denied.calls.length,0);assert.equal(a.allowed.value,false);
 const blocked=await component('components/mobile/MobilePurchaseBatchDialog.vue'),b=blocked.definition.setup({modelValue:true,status:'arrived',rows:[row(1,3,{review_required:true,received_at:'2026-11-06 02:00:00'})]},{expose(){},emit(){}});await b.preview();await b.submit();assert.equal(blocked.calls.length,0);
 let resolve;const events=[],h=await component('components/mobile/MobilePurchaseBatchDialog.vue',{post:()=>new Promise(done=>resolve=done)}),sut=h.definition.setup({modelValue:true,status:'open',rows:[row(1)]},{expose(){},emit:(event,value)=>events.push({event,value})});const pending=sut.submit();await sut.submit();assert.equal(h.calls.length,1);h.scope='B';sut.scopeChanged();resolve({quantity:600,remaining_quantity:0});await pending;assert.equal(sut.done.value,0);assert.equal(events.some(event=>event.event==='changed'),false);
});

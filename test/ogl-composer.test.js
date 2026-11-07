import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {computed,reactive,ref,watch,nextTick} from 'vue';
const source=readFileSync(new URL('../frontend/orders/components/OglDispatchComposer.vue',import.meta.url),'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'');
function fixture(manualShip=false,quickBind=false){
 const auth=reactive({user:{id:7,tenant:{id:2}}}),mounts=[],events=[],calls=[];let signature='v1',resolvePreview=null,delay=false;
 const rows=()=>quickBind?Array.from({length:26},(_,i)=>({id:101+i,posting_number:'TODAY-'+i,needs_review:false})): [{id:1,posting_number:'OWN',needs_review:false},{id:2,posting_number:'OTHER',needs_review:true,review_signature:signature,mark_note:signature}];
 const candidateQueries=[];
 const service={bootstrap:async()=>({settings:{dispatch_shop_id:1},shops:[]}),candidates:async(query)=>{candidateQueries.push(query);return{rows:rows().slice(0,20),eligible:rows(),rejected:[],total:rows().length,...(quickBind?{selection_rows:rows(),selection_date:'2026-10-31'}:{})};},officialSnapshot:async()=>({rows:[]}),preview:async()=>{if(delay)await new Promise(resolve=>resolvePreview=resolve);return{eligible:rows(),rejected:[]};},action:async(...args)=>{calls.push(args);return{batch:{id:10},members:[]};}};
 const context=vm.createContext({computed,reactive,ref,watch,service,ElMessage:{success(){}},useAuthStore:()=>auth,currentApiCacheScope:()=>String(auth.user.tenant.id),shanghaiDateKey:()=> '2026-10-31',shanghaiDateDaysAgo:()=> '2026-10-25',shanghaiDateTimeText:value=>value,normalizeOglOrderIds:ids=>[...new Set(ids.map(Number))],defineProps:()=>({manualShip,quickBind,orderIds:[1,2],batchId:0}),defineEmits:()=> (...args)=>events.push(args),onMounted:fn=>mounts.push(fn),onBeforeUnmount(){},crypto:{randomUUID:()=> 'stable-request-key'}});
 vm.runInContext(source,context);
 const get=code=>vm.runInContext(code,context);
 return {mount:()=>mounts[0](),get,calls,events,auth,candidateQueries,changeNote:()=>signature='v2',delayPreview:()=>delay=true,release:()=>resolvePreview()};
}
test('composer rechecks current notes before binding, keeps both page selections and requires renewed review after note changes',async()=>{
 const f=fixture();await f.mount();f.get("target.value={batch:{id:10}};review(selectedRows.value[1],true);reviewNote.value='checked'");
 assert.equal(f.get('canSave.value'),true);f.changeNote();await f.get('save()');assert.equal(f.calls.length,0);assert.equal(f.get('canSave.value'),false);
 f.get('review(selectedRows.value[1],true)');await f.get('save()');assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'bind-orders');assert.deepEqual(Array.from(f.calls[0][2].order_ids),[1,2]);assert.equal(f.calls[0][2].review_signatures[2],'v2');assert.ok(f.events.some(([name])=>name==='created'));
});
test('enterprise rotation closes the composer and a late preview cannot replace or expose previous-enterprise rows',async()=>{
 const f=fixture();await f.mount();f.delayPreview();const pending=f.get('recheck()');f.auth.user.tenant.id=3;await nextTick();f.release();await pending;
 assert.equal(f.get('visible.value'),false);assert.ok(f.events.some(([name])=>name==='close'));await f.get('save()');assert.equal(f.calls.length,0);
});
test('changing to API-create clears the old target and review proof rather than reusing a manifest binding',async()=>{
 const f=fixture();await f.mount();f.get("target.value={batch:{id:10}};review(selectedRows.value[1],true);mode.value='create'");await nextTick();assert.equal(f.get('target.value'),null);assert.equal(f.get('reviewed.value.size'),0);
});

test('fresh preview keeps full order display fields and clears stale blocked/unknown flags',async()=>{
 const f=fixture();await f.mount();f.get("selected.value.set(1,{...selected.value.get(1),blocked:true,unknown:true,sku_names:'SKU:Main page product',productDisplayRows:[{sku:'SKU',name:'Main page product'}]})");await f.get('recheck()');assert.equal(f.get('selected.value.get(1).blocked'),false);assert.equal(f.get('selected.value.get(1).unknown'),false);assert.equal(f.get('selected.value.get(1).productDisplayRows[0].name'),'Main page product');
});

test('historical binding requires explicit acknowledgment and explanation and forwards both without dispatch',async()=>{
 const f=fixture();await f.mount();f.get("target.value={batch:{id:10,status:'closed',official_result:{info:{status:'closed'}}}};review(selectedRows.value[1],true);reviewNote.value='checked'");
 assert.equal(f.get('historicalTarget.value'),true);assert.equal(f.get('canSave.value'),false);
 f.get("historicalConfirmed.value=true");assert.equal(f.get('canSave.value'),false);
 f.get("historicalNote.value='已核实同批发出'");assert.equal(f.get('canSave.value'),true);await f.get('save()');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'bind-orders');assert.equal(f.calls[0][2].confirm_historical_binding,true);assert.equal(f.calls[0][2].historical_binding_note,'已核实同批发出');
});

test('manual shipping uses the main-page selection and sends one explicit dispatch action for historical batches',async()=>{
 const f=fixture(true);await f.mount();f.get("target.value={batch:{id:10,status:'closed'}};review(selectedRows.value[1],true);reviewNote.value='已核实'");
 assert.equal(f.get('canSave.value'),false);
 f.get('dispatchConfirmed.value=true');assert.equal(f.get('canSave.value'),true);
 await f.get('save()');assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'manual-ship-orders');
 assert.equal(f.calls[0][2].confirm_dispatched,true);assert.deepEqual(Array.from(f.calls[0][2].order_ids),[1,2]);
});

test('quick binding ignores main-page selection, includes every eligible page and sends the captured Beijing print date',async()=>{
 const f=fixture(false,true);await f.mount();assert.equal(f.get('selected.value.size'),26);
 assert.equal(f.get('selected.value.has(1)'),false);assert.equal(f.candidateQueries.length,1);assert.equal(f.candidateQueries[0].selection,'today-clear');
 assert.equal(f.get('quickRows.value.length'),20);f.get('quickPage.value=2');assert.equal(f.get('quickRows.value.length'),6);
 f.get('toggle(selectedRows.value[0],false);target.value={batch:{id:10}}');await f.get('save()');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'quick-bind-orders');assert.equal(f.calls[0][2].printed_date,'2026-10-31');assert.equal(f.calls[0][2].order_ids.length,25);assert.ok(!Array.from(f.calls[0][2].order_ids).includes(101));assert.equal(f.calls[0][2].confirm_dispatched,undefined);
});
test('quick binding keeps a historical target disabled without claiming dispatch',async()=>{
 const f=fixture(false,true);await f.mount();f.get("target.value={batch:{id:10,status:'closed'}}");assert.equal(f.get('canSave.value'),false);await f.get('save()');assert.equal(f.calls.length,0);
});

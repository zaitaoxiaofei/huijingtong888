import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {computed,reactive,ref,watch,nextTick} from 'vue';
const source=readFileSync(new URL('../frontend/orders/components/OglDispatchComposer.vue',import.meta.url),'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'');
function fixture(){
 const auth=reactive({user:{id:7,tenant:{id:2}}}),mounts=[],events=[],calls=[];let signature='v1',resolvePreview=null,delay=false;
 const rows=()=>[{id:1,posting_number:'OWN',needs_review:false},{id:2,posting_number:'OTHER',needs_review:true,review_signature:signature,mark_note:signature}];
 const service={bootstrap:async()=>({settings:{dispatch_shop_id:1},shops:[]}),candidates:async()=>({eligible:rows(),rejected:[],total:2}),officialSnapshot:async()=>({rows:[]}),preview:async()=>{if(delay)await new Promise(resolve=>resolvePreview=resolve);return{eligible:rows(),rejected:[]};},action:async(...args)=>{calls.push(args);return{batch:{id:10},members:[]};}};
 const context=vm.createContext({computed,reactive,ref,watch,service,ElMessage:{success(){}},useAuthStore:()=>auth,currentApiCacheScope:()=>String(auth.user.tenant.id),shanghaiDateKey:()=> '2026-10-31',shanghaiDateDaysAgo:()=> '2026-10-25',shanghaiDateTimeText:value=>value,normalizeOglOrderIds:ids=>[...new Set(ids.map(Number))],defineProps:()=>({orderIds:[1,2],batchId:0}),defineEmits:()=> (...args)=>events.push(args),onMounted:fn=>mounts.push(fn),onBeforeUnmount(){},crypto:{randomUUID:()=> 'stable-request-key'}});
 vm.runInContext(source,context);
 const get=code=>vm.runInContext(code,context);
 return {mount:()=>mounts[0](),get,calls,events,auth,changeNote:()=>signature='v2',delayPreview:()=>delay=true,release:()=>resolvePreview()};
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

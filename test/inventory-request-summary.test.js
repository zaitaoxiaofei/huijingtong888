import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {computed,reactive,ref,watch,nextTick} from 'vue';
import {hasPermission} from '../src/shared/permissions.js';
const settle=async()=>{await nextTick();await new Promise(setImmediate);};
const source=readFileSync(new URL('../frontend/admin/composables/useInventoryRequestSummary.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace('export function','function');
function fixture(tenant=true){
 const scope=ref('a'),auth=reactive({user:{role:'manager',tenant:tenant?{id:2,role:'member',access_allowed:true}:null}}),mounts=[],unmounts=[],requests=[],listeners=new Map(),tasks=new Map();let taskId=0;
 const window={addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k),setTimeout:fn=>{tasks.set(++taskId,fn);return taskId;},clearTimeout:id=>tasks.delete(id),setInterval:()=>++taskId,clearInterval(){}};
 const context=vm.createContext({computed,ref,watch,hasPermission,useAuthStore:()=>auth,currentApiCacheScope:()=>scope.value,apiClient:{get:()=>new Promise(resolve=>requests.push(resolve))},onMounted:fn=>mounts.push(fn),onActivated(){},onDeactivated(){},onBeforeUnmount:fn=>unmounts.push(fn),window,document:{visibilityState:'visible'}});
 vm.runInContext(source+'\nvar summary=useInventoryRequestSummary();',context);
 return{summary:context.summary,requests,scope,mount:()=>mounts.forEach(f=>f()),unmount:()=>unmounts.forEach(f=>f()),event:()=>{listeners.get('erp:inventory-product-requests-changed')();for(const fn of tasks.values())fn();tasks.clear();}};
}
test('badge refreshes application counts after an approval event and ignores old-enterprise replies',async()=>{
 const f=fixture();f.mount();f.requests[0]({pending_count:2});await settle();assert.equal(f.summary.pending.value,2);
 f.event();f.requests[1]({pending_count:1});await settle();assert.equal(f.summary.pending.value,1);
 f.event();f.scope.value='b';await settle();assert.equal(f.summary.pending.value,0);f.requests[2]({pending_count:99});await settle();assert.equal(f.summary.pending.value,0);f.requests[3]({pending_count:3});await settle();assert.equal(f.summary.pending.value,3);f.unmount();
});
test('platform-only sessions do not read enterprise application counts',()=>{const f=fixture(false);f.mount();assert.equal(f.requests.length,0);assert.equal(f.summary.pending.value,0);f.unmount();});

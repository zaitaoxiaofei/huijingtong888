import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {reactive,ref,computed,watch,effectScope} from 'vue';
const source=readFileSync(new URL('../frontend/admin/components/MembershipPlanCatalog.vue',import.meta.url),'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm,'');
test('catalog clears selected-plan contact and ignores replies from the previous enterprise',async t=>{
 const auth=reactive({user:{id:1,tenant:{id:42,plan_code:'monthly',subscription_status:'active'}}});const calls=[],listeners=new Map();let cleanup;
 const context=vm.createContext({ref,computed,watch,defineAsyncComponent:()=>({}),useAuthStore:()=>auth,currentApiCacheScope:()=>`tenant-${auth.user.tenant.id}`,AbortController,
 apiClient:{get:()=>new Promise(resolve=>calls.push(resolve))},onBeforeUnmount:fn=>{cleanup=fn;},window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}});
 const effects=effectScope();effects.run(()=>vm.runInContext(source,context));t.after(()=>{cleanup();effects.stop();});
 const get=code=>vm.runInContext(code,context);const flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
 calls[0]({tenant_id:42,plans:[{code:'yearly',eligible:true,name:'Annual',price_fen:899900,duration_days:365,account_limit:3,shop_limit:10}]});await flush();
 get('contact(plans.value[0])');assert.equal(get('contactVisible.value'),true);
 get('load()');auth.user.tenant.id=43;assert.equal(get('contactVisible.value'),false);assert.equal(get('plans.value.length'),0);
 calls[1]({tenant_id:42,plans:[{code:'trial_1d',eligible:true}]});await flush();assert.equal(get('plans.value.length'),0);
 calls[2]({tenant_id:43,plans:[{code:'monthly',eligible:false}]});await flush();assert.equal(get('plans.value[0].code'),'monthly');
 get('contact(plans.value[0])');assert.equal(get('contactVisible.value'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import * as permissions from '../src/shared/permissions.js';
const source = readFileSync(new URL('../frontend/admin/components/TenantPluginBindingPanel.vue',import.meta.url),'utf8');
const flush = async () => { await nextTick(); await new Promise(resolve=>setImmediate(resolve)); };
const ready = { configured:true,encryption_configured:true,can_reveal:true };
const token = 'ozp_'+'x'.repeat(43);
function fixture(t, role='owner', enabled=true) {
 const auth=reactive({user:{id:7,roles:['operations'],tenant:{id:42,slug:'customer-a',role,name:'A'}}});
 const props=reactive({enabled});
 const calls=[],confirms=[],listeners=new Map(),unmount=[],deactivate=[];
 const request=(method,url,body)=>new Promise((resolve,reject)=>calls.push({method,url,body,resolve,reject}));
 const context=vm.createContext({computed,ref,watch,...permissions,defineProps:()=>props,useAuthStore:()=>auth,useRouter:()=>({push(){}}),
  currentApiCacheScope:()=>'current-session',AbortController,
  apiClient:{get:(url,body)=>request('GET',url,body),post:(url,body)=>request('POST',url,body)},
  ElMessage:{error(){},success(){}},ElMessageBox:{confirm:()=>new Promise(resolve=>confirms.push(resolve))},
  onActivated(){},onDeactivated:fn=>deactivate.push(fn),onBeforeUnmount:fn=>unmount.push(fn),
  shanghaiDateTimeText:x=>x,navigator:{clipboard:{writeText:async()=>{}}},
  window:{location:{origin:'https://erp.invalid'},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
 });
 const effects=effectScope();effects.run(()=>vm.runInContext(source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm,''),context));
 t.after(()=>{unmount.forEach(fn=>fn());effects.stop();});
 return {auth,props,calls,confirms,get:code=>vm.runInContext(code,context),deactivate:()=>deactivate.forEach(fn=>fn())};
}

test('late plaintext from a prior enterprise is discarded after switching space',async t=>{
 const f=fixture(t);assert.match(f.calls[0].url,/tenant_id=42/);f.calls[0].resolve(ready);await flush();
 const pending=f.get("requestToken('reveal')");assert.equal(f.calls[1].body.tenant_id,42);
 f.auth.user.tenant={id:43,slug:'customer-b',role:'owner',name:'B'};
 f.calls[1].resolve({tenant_id:42,token});await pending;
 assert.equal(f.get('token.value'),'');assert.equal(f.get('tokenVisible.value'),false);
 assert.match(f.calls[2].url,/tenant_id=43/);
});

test('confirming reset after a tenant switch cannot rotate the new enterprise key',async t=>{
 const f=fixture(t);f.calls[0].resolve(ready);await flush();
 const pending=f.get("requestToken('issue')");assert.equal(f.confirms.length,1);
 f.auth.user.tenant={id:43,slug:'customer-b',role:'owner',name:'B'};f.confirms[0]();await pending;
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

test('ordinary members cannot read or create keys; deactivating the owner page clears plaintext',async t=>{
 const member=fixture(t,'member');assert.equal(member.calls.length,0);await member.get("requestToken('issue')");assert.equal(member.calls.length,0);
 const f=fixture(t);f.calls[0].resolve(ready);await flush();
 const pending=f.get("requestToken('reveal')");f.calls[1].resolve({tenant_id:42,token});await flush();f.calls[2].resolve(ready);await pending;
 assert.equal(f.get('token.value'),token);f.deactivate();assert.equal(f.get('token.value'),'');assert.equal(f.get('tokenVisible.value'),false);
 assert.doesNotMatch(source,/localStorage|sessionStorage/);
});

test('membership exposes the binding panel and explains enterprise collection ownership',()=>{
 const membership=readFileSync(new URL('../frontend/admin/views/MembershipView.vue',import.meta.url),'utf8');
 assert.match(membership,/<TenantPluginBindingPanel v-if="tenant" :enabled="status.active"/);
 for(const text of ['企业专属密钥','保存密钥','本企业的“采集箱”','本企业的“草稿箱”','切换 ERP 空间不会自动更换插件密钥'])assert.ok(source.includes(text),text);
});


test('new enterprises see the entry before activation but cannot request keys until membership is active',async t=>{
 const f=fixture(t,'owner',false);assert.equal(f.calls.length,0);await f.get("requestToken('issue')");assert.equal(f.calls.length,0);
 f.props.enabled=true;await flush();assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/tenant_id=42/);
});

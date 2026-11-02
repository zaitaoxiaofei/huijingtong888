import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {renderToString} from '@vue/server-renderer';
import * as permissions from '../src/shared/permissions.js';
import * as search from '../src/shared/inventory-search-fields.js';
import * as orderSearch from '../src/shared/order-search.js';
import * as orderUtils from '../frontend/admin/views/mobile/mobile-orders-utils.js';
import * as shanghai from '../frontend/admin/utils/shanghai-date.js';
const owner={id:1,personId:1,name:'Fixture member',username:'fixture',roles:['admin'],tenant:{id:2,role:'owner'}};
export async function component(file,{inlineTemplate=false,get=async()=>({}),post=async()=>({}),route={query:{},params:{}},auth={user:owner},router={replace(){},push(){},back(){}}}={}){
 const {descriptor}=parse(fs.readFileSync(new URL('../frontend/admin/'+file,import.meta.url),'utf8'));
 const script=compileScript(descriptor,{id:'mobile-regression',inlineTemplate});
 const code=script.content.replace(/^import\s+['"][^'"]+['"];?$/gm,'').replace(/import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2;?/g,(_whole,bindings,_quote,id)=>{
  if(bindings.trim().startsWith('{'))return `const ${bindings.replace(/\bas\b/g,':')}=require(${JSON.stringify(id)});`;
  return `const ${bindings.trim()}=require(${JSON.stringify(id)});`;
 }).replace(/export\s+default/,'module.exports.default =');
 const h={scope:'A',calls:[],timers:new Set(),mounted:[],auth,history:{state:{},replaceState(){}}};
 const api={get:async(path,options)=>{h.calls.push({path,options});return get(path,options);},post:async(path,body)=>{h.calls.push({path,body,method:'POST'});return post(path,body);}};
 const deps={...vue,onMounted:fn=>h.mounted.push(fn),onBeforeUnmount:()=>{}};
 function require(id){
  if(id==='vue')return deps;
  if(id==='vue-router')return{useRoute:()=>route,useRouter:()=>router};
  if(id==='element-plus')return{ElMessage:{warning(){},error(){},success(){},info(){}},ElMessageBox:{}};
  if(id==='@element-plus/icons-vue')return{Search:{}};
  if(id.endsWith('/stores/auth.js')||id.endsWith('/stores/auth'))return{useAuthStore:()=>auth};
  if(id.endsWith('/utils/api')||id.endsWith('/utils/api.js'))return{apiClient:api,currentApiCacheScope:()=>h.scope};
  if(id.endsWith('permissions.js'))return permissions;
  if(id.endsWith('inventory-search-fields.js'))return search;
  if(id.endsWith('order-search.js'))return orderSearch;
  if(id.endsWith('mobile-orders-utils.js'))return orderUtils;
  if(id.endsWith('shanghai-date.js'))return shanghai;
  if(id.endsWith('imageCropper.js'))return{withImageToken:x=>x};
  if(id.endsWith('mobile-evidence.js'))return{};
  if(id.endsWith('use-inventory-local-quantities.js'))return{useInventoryLocalQuantities:()=>({rows:vue.ref(new Map()),error:vue.ref('')})};
  if(id.endsWith('MobileDialog.vue'))return{props:['modelValue'],setup(props,{slots}){return()=>props.modelValue?vue.h('section',[slots.default?.(),slots.footer?.()]):null;}};
  if(id.endsWith('.vue')||id.endsWith('.css'))return{};
  throw Error('Unexpected component dependency '+id);
 }
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require,AbortController,DOMException,URLSearchParams,Date,console,
 window:{history:h.history,addEventListener(){},removeEventListener(){},setTimeout(fn,ms){const id=setTimeout(fn,ms);h.timers.add(id);return id;},clearTimeout(id){h.timers.delete(id);clearTimeout(id);}},
 clearTimeout(id){h.timers.delete(id);clearTimeout(id);},document:{querySelector(){return{scrollTo(){},scrollTop:0};}}});
 h.definition=module.exports.default;return h;
}
test('mobile orders return rows without counts, can paginate while counts are pending, and discard old-scope results',async()=>{
 let resolveCounts;
 const h=await component('views/mobile/MobileOrdersView.vue',{get:async path=>{const p=new URL(path,'http://fixture').searchParams;if(p.get('includeRows')==='0')return new Promise(resolve=>resolveCounts=resolve);return{rows:[{id:Number(p.get('page'))}],page:Number(p.get('page')),total:100};}});
 const sut=h.definition.setup({}, {expose(){}});
 await sut.loadOrders();assert.equal(sut.rows.value[0].id,1);assert.equal(h.calls.length,1);assert.match(h.calls[0].path,/includeCounts=0/);
 const counts=sut.loadCounts();await sut.loadOrders({nextPage:2});assert.equal(sut.rows.value[0].id,2);assert.equal(sut.countsLoading.value,true);assert.equal(h.calls.filter(c=>c.path.includes('includeRows=0')).length,1);
 h.scope='B';sut.clearScope();resolveCounts({counts:{unbound:99}});await counts;
 assert.equal(sut.rows.value.length,0);assert.equal(Object.keys(sut.counts.value).length,0);assert.equal(h.timers.size,0);
});
test('procurement opens a lightweight product page, keeps structured filters, and never starts a demand polling loop',async()=>{
 const h=await component('components/mobile/MobileWorkQueue.vue',{get:async path=>path.includes('/alerts')?{rows:[],total:null,snapshot:{refreshing:true}}:{rows:[{id:7,name:'Fixture inventory'}],total:1}});
 const sut=h.definition.setup({warehouse:false},{expose(){}});
 await sut.load();assert.equal(sut.tab.value,'register');assert.equal(h.calls.length,1);assert.match(h.calls[0].path,/includeStock=0/);assert.ok(!h.calls[0].path.includes('/alerts'));
 sut.filters.searchMode='inventory_id';sut.filters.query='1-14';sut.filters.inventoryCategory='钥匙壳';sut.filters.vehicleModel=['J6'];sut.pageSize.value=50;
 const p=sut.filtersUrl();assert.equal(p.get('pageSize'),'50');assert.equal(p.get('searchMode'),'inventory_id');assert.equal(p.get('inventoryCategory'),'钥匙壳');assert.equal(p.get('vehicleModel'),'J6');
 sut.tab.value='required';await vue.nextTick();await new Promise(setImmediate);
 assert.equal(h.calls.filter(c=>c.path.includes('/alerts')).length,1);assert.match(h.calls.at(-1).path,/snapshot_only=1/);assert.equal(h.timers.size,0);sut.reset();
});
test('my account starts with an account overview and opens separate profile/password editors',async()=>{
 const h=await component('views/mobile/MobileAccountView.vue',{inlineTemplate:true});
 const app=vue.createSSRApp(h.definition);for(const name of ['el-avatar','el-button','el-alert'])app.component(name,{setup(_,{slots}){return()=>vue.h('div',slots.default?.());}});
 const html=await renderToString(app);for(const text of ['个人资料','账号安全','岗位与权限','添加到手机桌面'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/type="password"/g)||[]).length,0,'password form stays out of the account overview');
 const state=await component('views/mobile/MobileAccountView.vue');const sut=state.definition.setup({}, {expose(){}});
 sut.openPanel('password');assert.equal(sut.panel.value,'password');sut.password.old_password='private';sut.password.new_password='new';sut.closePanel();assert.equal(sut.password.old_password,'');assert.equal(sut.panel.value,'');
 sut.openPanel('profile');sut.profile.name='Draft';sut.profileError.value='Retry';sut.closePanel();sut.openPanel('profile');assert.equal(sut.profile.name,owner.name);assert.equal(sut.profileError.value,'');
});
test('binding paginates candidates, retains selected inventory, and rejects stale or other-scope search results',async()=>{
 let resolveOld;
 const h=await component('views/mobile/MobileOrderDetailView.vue',{get:async path=>{const p=new URL(path,'http://fixture').searchParams;if(p.get('query')==='old')return new Promise(r=>resolveOld=r);return{rows:[{id:Number(p.get('page')),name:'Candidate'}],total:100};}});
 const sut=h.definition.setup({}, {expose(){}});sut.bindingVisible.value=true;sut.bindingFilters.searchMode='inventory_id';
 const old=sut.loadProductOptions('old');await sut.loadProductOptions('1-14',2);assert.equal(sut.productOptions.value[0].id,2);assert.equal(sut.bindingPage.value,2);assert.match(h.calls.at(-1).path,/includeStock=0/);assert.match(h.calls.at(-1).path,/searchMode=inventory_id/);assert.match(h.calls.at(-1).path,/pageSize=20/);
 sut.selectBindingProduct(sut.productOptions.value[0]);await sut.loadProductOptions('',3);assert.equal(sut.selectedProduct.value.id,2);assert.equal(sut.bindingForm.product_id,'2');resolveOld({rows:[{id:99}],total:1});await old;assert.equal(sut.productOptions.value[0].id,3);
 const late=sut.loadProductOptions('old');h.scope='B';sut.resetBindingScope();resolveOld({rows:[{id:100}],total:1});await late;assert.equal(sut.productOptions.value.length,0);assert.equal(sut.selectedProduct.value,null);assert.equal(sut.bindingItem.value,null);
});

test('mobile header back returns only within mobile history and otherwise falls back to home',async()=>{
 const moves=[];const h=await component('layouts/MobileLayout.vue',{route:{name:'mobile-inventory'},router:{back(){moves.push('back');},replace(path){moves.push(path);}}});
 const sut=h.definition.setup({}, {expose(){}});assert.equal(sut.canGoBack.value,true);
 h.history.state.back='/mobile/orders?page=2';sut.goBack();h.history.state.back='/orders';sut.goBack();h.history.state.back=null;sut.goBack();
 assert.deepEqual(moves,['back','/mobile','/mobile']);
});

test('failed binding preserves selection and concurrent confirmation sends one request',async()=>{
 let reject;const h=await component('views/mobile/MobileOrderDetailView.vue',{post:()=>new Promise((_,r)=>reject=r)});const sut=h.definition.setup({}, {expose(){}});
 sut.bindingVisible.value=true;sut.bindingItem.value={online_product_id:7};sut.selectBindingProduct({id:3,name:'Chosen inventory'});const saving=sut.submitMobileBind();await sut.submitMobileBind();assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.product_id,3);reject(new Error('Fixture unavailable'));await saving;assert.equal(sut.bindingVisible.value,true);assert.equal(sut.selectedProduct.value.id,3);assert.equal(sut.bindingSubmitting.value,false);
});

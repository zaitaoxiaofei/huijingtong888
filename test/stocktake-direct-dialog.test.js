import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parse as parseVue} from '@vue/compiler-sfc';
import {parse} from 'acorn';
import {planLedgerAction} from '../src/services/procurement-ledger.js';
const source=readFileSync(new URL('../frontend/admin/components/procurement/ProcurementLedgerDialog.vue',import.meta.url),'utf8');
const script=parseVue(source).descriptor.scriptSetup.content;
const nodes=parse(script,{ecmaVersion:'latest',sourceType:'module'}).body;
function fixture(get){
 const calls=[], events=[];
 const ref=value=>({value});
 const context=vm.createContext({Number,Object,Math,clearTimeout,
  fbpLoading:ref(false),fbpSyncing:ref(false),fbpError:ref(''),
  props:{modelValue:true,initialAction:'stocktake',inventoryMode:true,stocktakeEnabled:true},directStocktake:ref(true),visible:ref(true),
  loading:ref(false),saving:ref(false),data:ref(null),productId:ref(10),preview:ref(null),submission:ref(null),
  formVisible:ref(false),form:{},target:ref(null),managementVisible:ref(false),loadError:ref(''),ledgerBase:ref('/api/inventory/ledger'),
  shanghaiDateKey:()=> '2026-10-28',
  apiClient:{get:async url=>{calls.push(['get',url]);return get?get(url):{product:{id:10},revision:'v',physical_estimate:-5}},
    post:async(url,body)=>{calls.push(['post',url,body]);return {ok:true}}},
  emit:(...args)=>events.push(args),ElMessage:{error(){},success(){}},ElMessageBox:{confirm:async()=>calls.push(['confirm'])}
 });
 vm.runInContext("let fbpVersion=0,pollTimer,finishPoll;let loadVersion=0;let pendingInitialAction='stocktake';",context);
 for(const name of ['stopFbpPoll','load','edit','discardForm','cancelForm','closeForm','save']){const node=nodes.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);vm.runInContext(script.slice(node.start,node.end),context);}
 return {context,calls,events};
}
test('direct update loads only its inventory then defaults to the actual physical count',async()=>{
 const f=fixture();await f.context.load();assert.equal(f.context.form.action_type,'stocktake');assert.equal(f.context.form.stocktake_type,'physical');
 assert.equal(f.context.form.counted_quantity,undefined);assert.equal(f.context.formVisible.value,true);assert.equal(f.calls.length,1);
});
test('a failed load can be retried into the same small form with no stale product',async()=>{
 let failed=true;const f=fixture(async()=>{if(failed)throw new Error('offline');return {product:{id:10},revision:'v'}});
 await f.context.load();assert.equal(f.context.data.value,null);assert.equal(f.context.loadError.value,'offline');
 failed=false;await f.context.load();assert.equal(f.context.form.stocktake_type,'physical');assert.equal(f.context.formVisible.value,true);
});
test('saving a direct count closes the controller and refreshes the caller once without reopening detail',async()=>{
 const f=fixture();await f.context.load();f.context.submission.value={action_type:'stocktake',counted_quantity:20};
 await f.context.save();assert.equal(f.context.visible.value,false);assert.equal(f.context.formVisible.value,false);
 assert.equal(f.calls.filter(c=>c[0]==='get').length,1);assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
 assert.deepEqual(f.events,[['saved']]);
});
test('cancelling an untouched form closes immediately; cancelling discard preserves entered stock',async()=>{
 const f=fixture();await f.context.load();await f.context.cancelForm();assert.equal(f.context.visible.value,false);assert.equal(f.calls.some(c=>c[0]==='confirm'),false);
 f.context.visible.value=true;f.context.edit('stocktake');f.context.form.counted_quantity=20;
 f.context.ElMessageBox.confirm=async()=>{throw new Error('continue editing')};await f.context.cancelForm();
 assert.equal(f.context.visible.value,true);assert.equal(f.context.formVisible.value,true);assert.equal(f.context.form.counted_quantity,20);
});
test('read-only callers cannot create a stocktake form',()=>{
 const f=fixture();f.context.props.stocktakeEnabled=false;f.context.edit('stocktake');assert.equal(f.context.formVisible.value,false);
});
test('physical 20 means 20 actual goods even with historical negative balances',()=>{
 for(const [physical,demand] of [[-5,0],[-1,1]]){
  const snapshot={product:{id:10},revision:'v',local_stock:physical,physical_estimate:physical,open_order_demand:demand,fbp_reserved:0};
  const body={action_type:'stocktake',revision:'v',stocktake_type:'physical',counted_quantity:20,reason_code:'history_error'};
  const plan=planLedgerAction(snapshot,body);assert.equal(plan.counted_quantity,20);assert.equal(plan.available_after,20-demand);assert.equal(plan.local_delta,20-physical);
  assert.throws(()=>planLedgerAction(snapshot,{...body,stocktake_type:'available',available_quantity:20}),/家里还有 20 件就填 20/);
 }
});

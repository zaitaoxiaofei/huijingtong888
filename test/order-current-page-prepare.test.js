import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {currentPagePreparePlan} from '../frontend/orders/utils/order-print-selection.js';
const source=fs.readFileSync(new URL('../frontend/orders/OrdersPage.vue',import.meta.url),'utf8');
const eligible=id=>({id,availableActions:{prepare:true}});
test('current page plan excludes unavailable and split-confirmation orders and never uses off-page selection',()=>{
 assert.deepEqual(currentPagePreparePlan([eligible(21),{id:22,availableActions:{prepare:false}},{id:23,availableActions:{prepare:true,showSplitPrepare:true}},{id:24}]),{ids:[21],skipped:3});
 assert.deepEqual(currentPagePreparePlan([eligible(2),eligible('2'),eligible(0),eligible(-1),eligible('bad')]).ids,[2]);
});
function fixture(){
 const calls=[],warnings=[],pagePreparePlan={value:currentPagePreparePlan([eligible(21)])},canPreparePage={value:true},preparingCurrentPage={value:false};let confirm=async()=>{},scope='a';
 const run=vm.runInNewContext(source.match(/async function bulkPrepareCurrentPage\([^]*?\n}/)[0]+';bulkPrepareCurrentPage',{pagePreparePlan,canPreparePage,preparingCurrentPage,currentApiCacheScope:()=>scope,ElMessageBox:{confirm:(...args)=>confirm(...args)},ElMessage:{warning:m=>warnings.push(m),error:m=>warnings.push(m)},bulkPrepare:async ids=>calls.push([...ids])});
 return{run,calls,warnings,pagePreparePlan,canPreparePage,preparingCurrentPage,setConfirm:fn=>confirm=fn,setScope:value=>scope=value};
}
test('prepare confirms page IDs and blocks duplicate requests while awaiting confirmation',async()=>{
 const f=fixture();let accept;f.setConfirm(()=>new Promise(resolve=>accept=resolve));const pending=f.run();assert.equal(f.preparingCurrentPage.value,true);await f.run();assert.equal(f.calls.length,0);accept();await pending;assert.deepEqual(f.calls,[[21]]);assert.equal(f.preparingCurrentPage.value,false);
});
test('cancel, permission changes, enterprise switches and stale page IDs never prepare orders',async()=>{
 for(const mutation of [()=>{throw 'cancel';},f=>f.canPreparePage.value=false,f=>f.setScope('b'),f=>f.pagePreparePlan.value={ids:[41],skipped:0}]){
  const f=fixture();f.setConfirm(async()=>mutation(f));await f.run();assert.deepEqual(f.calls,[]);assert.equal(f.preparingCurrentPage.value,false);
 }
});

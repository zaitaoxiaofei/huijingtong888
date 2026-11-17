import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {computed,reactive,ref,watch,nextTick} from 'vue';
import * as periods from '../frontend/admin/utils/billing-period.js';
import * as profit from '../src/shared/billing-profit.js';
import * as groups from '../frontend/admin/views/profit/billing-groups.js';
import * as metrics from '../frontend/admin/views/profit/billing-metrics.js';
import * as categories from '../frontend/admin/views/profit/billing-expense-categories.js';
import * as format from '../frontend/admin/views/profit/profit-utils.js';
function mount(get){
 const source=fs.readFileSync(new URL('../frontend/admin/views/profit/MonthlyBillingDetailsView.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm,'');
 const errors=[],route={path:'/profit/monthly-billing',query:{from:'2026-10-01',to:'2026-10-31'}};
 const context=vm.createContext({...periods,...profit,...groups,...metrics,...categories,...format,computed,reactive,ref,watch,defineAsyncComponent:()=>({}),onMounted:()=>{},onBeforeUnmount:()=>{},useRoute:()=>route,useRouter:()=>({replace:()=>{},push:()=>{}}),shanghaiDateKey:()=> '2026-11-17',shanghaiDateText:x=>x,currentApiCacheScope:()=> 'tenant:1',apiClient:{get},ElMessage:{error:e=>errors.push(e)},ElMessageBox:{},AbortController,URLSearchParams,console,window:{addEventListener(){},removeEventListener(){}}});
 vm.runInContext(source+';this.view={state,loadData,loadAppendices,capitalDrawer,aiOpen,appendixLoading,appendixError};',context);return {...context.view,errors};
}
test('main bill omits appendices; capital and AI share one lazy read, and failed reads retry',async()=>{
 const reads=[];let fail=false;
 const view=mount(async(path)=>{reads.push(path);if(path.includes('appendicesOnly')){if(fail)throw Error('appendix unavailable');return {procurement_inventory:{purchase_amount:123},ai_usage:{cost:7}};}if(path.includes('payroll-ledger'))return {rows:[]};if(path.includes('/companies'))return {companies:[],assignments:[]};return {selected:{summary:{revenue:100},expenses:[]}};});
 await view.loadData();assert.equal(reads.filter(p=>p.includes('appendicesOnly')).length,0);assert.equal(new URL(reads.find(p=>p.startsWith('/api/monthly-billing-details')),'http://test').searchParams.get('includeAppendices'),'0');
 view.capitalDrawer.value=true;await nextTick();await new Promise(setImmediate);assert.equal(view.state.month.procurement_inventory.purchase_amount,123);
 view.aiOpen.value=true;await nextTick();assert.equal(reads.filter(p=>p.includes('appendicesOnly')).length,1);
 fail=true;await view.loadData();await new Promise(setImmediate);assert.equal(view.appendixError.value,'appendix unavailable');fail=false;await view.loadAppendices();assert.equal(view.appendixError.value,'');assert.equal(view.state.month.ai_usage.cost,7);assert.deepEqual(view.errors,[]);
});
test('a late appendix cannot overwrite a newer date range or keep loading blocked',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);let reads=0;
 const view=mount(async(path)=>{if(path.includes('appendicesOnly')){reads++;if(reads===1){await gate;return {procurement_inventory:{purchase_amount:999},ai_usage:{}};}return {procurement_inventory:{purchase_amount:200},ai_usage:{}};}if(path.includes('payroll-ledger'))return {rows:[]};if(path.includes('/companies'))return {companies:[]};return {selected:{summary:{},expenses:[]}};});
 await view.loadData();view.capitalDrawer.value=true;await nextTick();view.state.dateRange=['2026-11-01','2026-11-30'];await view.loadData();await new Promise(setImmediate);release();await new Promise(setImmediate);assert.equal(view.state.month.procurement_inventory.purchase_amount,200);assert.equal(view.appendixLoading.value,false);
});

test('company month/quarter/year display reuses the same confirmed annual lines without refetching',async()=>{
 const defs=await import('../src/shared/company-finance-report.js'),files=await import('../src/shared/finance-document-categories.js');const reads=[];
 const source=fs.readFileSync(new URL('../frontend/admin/views/finance/CompanyStatementsView.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm,'');
 const context=vm.createContext({...defs,...files,computed,reactive,ref,watch,defineAsyncComponent:()=>({}),onBeforeUnmount:()=>{},useRoute:()=>({query:{}}),useRouter:()=>({push(){}}),useAuthStore:()=>({user:{id:7,tenant:{id:1}}}),canAccessPage:()=>true,currentApiCacheScope:()=> 'tenant:1',shanghaiDateKey:()=> '2026-11-17',AbortController,URLSearchParams,console,apiClient:{get:async path=>{reads.push(path);if(path.includes('/companies'))return {companies:[{id:1,name:'测试公司'}],assignments:[],shops:[]};return {coverage:{},documents:[],lines:[{month:'2026-10',metric:'工资',amount:100,currency:'CNY'}]};}}});
 vm.runInContext(source+';this.view={period,matrix,month,report};',context);await new Promise(setImmediate);await nextTick();await new Promise(setImmediate);const count=reads.length;assert.ok(count>0);
 context.view.period.value='quarter';await nextTick();assert.equal(reads.length,count);assert.equal(context.view.matrix.value.periods.length,4);assert.equal(context.view.matrix.value.rows.find(r=>r.id==='labor').cells['2026-Q4'],100);
 context.view.period.value='year';await nextTick();assert.equal(reads.length,count);assert.equal(context.view.matrix.value.periods.length,1);
 context.view.month.value='2026-12';await nextTick();assert.equal(reads.length,count);
 context.view.month.value='2025-12';await nextTick();await new Promise(setImmediate);assert.equal(reads.length,count+1);
});

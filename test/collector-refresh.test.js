import test from 'node:test';import assert from 'node:assert/strict';
import {collectorCategoryPending,createCollectorRefresh} from '../frontend/admin/utils/collector-refresh.js';
test('category pending is bounded, and real incomplete rows stay incomplete',()=>{
 const now=Date.parse('2026-10-29T12:00:00Z');
 assert.equal(collectorCategoryPending({collected_at:'2026-10-29T11:59:00Z',quality_issues:['Ozon 类目未识别']},now),true);
 for(const row of [{collected_at:'2026-10-29T11:00:00Z',quality_issues:['类目未识别']},{collected_at:'invalid',quality_issues:['类目未识别']},{collected_at:'2026-10-29T11:59:00Z',quality_issues:['图片缺失']},{collected_at:'2026-10-30T12:00:00Z',quality_issues:['类目未识别']}])assert.equal(collectorCategoryPending(row,now),false);
});
test('background refresh resolves pending rows without polling forever, overlapping, or polling hidden tabs',async()=>{
 let callback,visible=true,pending=true,calls=0,release,cancelled=0;
 const refresh=createCollectorRefresh({schedule:fn=>(callback=fn,1),cancel:()=>cancelled++,visible:()=>visible,pending:()=>pending,refresh:async()=>{calls++;await new Promise(r=>release=r)}});
 const first=callback();await refresh.focus();assert.equal(calls,1);release();await first;
 visible=false;await callback();assert.equal(calls,1);
 visible=true;pending=false;await callback();assert.equal(calls,1);
 const focus=refresh.focus();assert.equal(calls,2);release();await focus;
 refresh.stop();assert.equal(cancelled,1);await callback();assert.equal(calls,2);
});
test('pending refresh retries are capped until a new foreground visit',async()=>{
 let callback,calls=0;const refresh=createCollectorRefresh({schedule:fn=>(callback=fn,1),cancel:()=>{},visible:()=>true,pending:()=>true,refresh:async()=>calls++});
 for(let i=0;i<40;i++)await callback();assert.equal(calls,24);
 await refresh.focus();assert.equal(calls,25);refresh.stop();
});

test('collector list ignores stale filter responses and invalidated enterprise responses',async()=>{
 const {readFileSync}=await import('node:fs'),{parse}=await import('acorn'),vm=await import('node:vm');
 const source=readFileSync(new URL('../frontend/admin/views/listing/CollectorBoxView.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0];
 const n=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='loadRows');
 const pending=[];const c=vm.createContext({Set,String,JSON,collectorLoadGeneration:0,collectorTable:{value:null},loading:{value:false},state:{filters:{query:'old'},selectedRows:[],rows:[]},buildQuery:()=>new URLSearchParams(),prepareCollectorRows:rows=>rows,apiClient:{get:()=>new Promise(resolve=>pending.push(resolve))},ElMessage:{error:()=>{}}});
 vm.runInContext(source.slice(n.start,n.end),c);
 const first=c.loadRows();c.state.filters.query='new';const second=c.loadRows();pending[1]({rows:[{sku:'new'}],total:1});await second;pending[0]({rows:[{sku:'old'}],total:9});await first;assert.equal(c.state.rows[0].sku,'new');assert.equal(c.state.total,1);
 const oldTenant=c.loadRows();c.collectorLoadGeneration++;c.state.rows=[];pending[2]({rows:[{sku:'private-old-tenant'}]});await oldTenant;assert.equal(c.state.rows.length,0);
 c.state.selectedRows=[{sku:'selected'}];const refresh=c.loadRows({quiet:true});pending[3]({rows:[{sku:'selected'},{sku:'other'}]});await refresh;assert.equal(c.state.selectedRows.length,1);assert.equal(c.state.selectedRows[0].sku,'selected');
});

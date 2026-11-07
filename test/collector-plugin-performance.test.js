import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {parse} from 'acorn';import vm from 'node:vm';
function extract(path,name){const s=readFileSync(new URL(path,import.meta.url),'utf8'),stack=[parse(s,{ecmaVersion:'latest',sourceType:'script'})];while(stack.length){const n=stack.pop();if(!n||typeof n!=='object')continue;if(n.type==='FunctionDeclaration'&&n.id.name===name)return s.slice(n.start,n.end);for(const value of Object.values(n))if(Array.isArray(value))stack.push(...value);else if(value&&typeof value==='object')stack.push(value)}throw Error(name)}
test('seller variant reads have a three-request cap and preserve root SKU despite out-of-order completion',async()=>{
 let active=0,peak=0;const visited=[];
 const c=vm.createContext({Promise,Object,Array,Date,String,Math,console,
 collectDetailSkuCandidates:()=>['root','b','c','d','e','f'],
 collector:{fetchSellerFallbackData:async sku=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,sku==='root'?25:2));active--;visited.push(sku);return{fields:{marker:sku}}}},
 buildSellerCategoryPatch:r=>({category_ids:[300,400],marker:r.fields.marker}),removeVariantOnlySellerFields:r=>r,
 applySellerPatchBySku:()=>{},applyCollectedFieldPatch:()=>{}});
 vm.runInContext(extract('../ozon-erp-collector-plugin/content.js','enrichDetailWithSellerFallback'),c);
 const result=await c.enrichDetailWithSellerFallback({});assert.equal(peak,3);assert.equal(visited.length,6);assert.notEqual(visited[0],'root');assert.equal(result.marker,'root');assert.equal(Object.keys(result.sellerVariantBySku).length,6);
});
test('independent seller base lookup overlaps sales; one failed base request is not duplicated',async()=>{
 const calls=[],releases={};const c=vm.createContext({String,Array,Object,Promise,
 requestSellerBridgeData:(sku,type)=>{calls.push(type);return new Promise((resolve,reject)=>releases[type]={resolve,reject})},
 hasFilledValue:v=>v!==undefined&&v!==null&&v!=='',buildSellerSalesFields:()=>({}),buildSellerBaseInfoFields:()=>({}),buildSellerVariantFields:()=>({}),
 });
 vm.runInContext(extract('../ozon-erp-collector-plugin/collector.js','fetchSellerFallbackData'),c);
 const pending=c.fetchSellerFallbackData('root');assert.deepEqual(calls,['search-sku-base','sales']);
 releases['search-sku-base'].reject(Error('base unavailable'));releases.sales.resolve({items:[]});
 await new Promise(r=>setImmediate(r));assert.equal(calls.filter(x=>x==='search-sku-base').length,1);assert.ok(releases.variant);
 releases.variant.resolve({items:[]});const result=await pending;assert.ok(result.warnings.includes('base unavailable'));
});

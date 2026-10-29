import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {resolveCollectedCategoryFromCache} from '../src/services/listing-automation.js';
const category=(description_category_id,type_id)=>({description_category_id,type_id,name_zh:'测试类目',path_zh:'汽车用品 / 测试类目',status:'active'});
const lookup=rows=>async(sql,params)=>rows.filter(row=>sql.includes('description_category_id = ?')?Number(row.description_category_id)===params[0]&&Number(row.type_id)===params[1]:Number(row.type_id)===params[0]);
test('single official type and single leaf id resolve a unique cached category without guessing a parent',async()=>{
 for(const raw of [{type_id:400},{category_ids:[400]},{categoryIds:['400']},{description_type_dict_value:400}]){
  const result=await resolveCollectedCategoryFromCache(raw,{}, {},null,lookup([category(300,400)]));
  assert.equal(result.status,'resolved');assert.equal(Number(result.category.description_category_id),300);assert.equal(Number(result.category.type_id),400);
 }
});
test('a valid complete pair wins after an earlier candidate cache miss, and before old category2/3 heuristics',async()=>{
 const result=await resolveCollectedCategoryFromCache({category2Id:100,category3Id:200,description_category_id:300,type_id:400,category_ids:[1,300,400]}, {},{},null,lookup([category(300,400),category(100,200)]));
 assert.equal(result.status,'resolved');assert.equal(Number(result.category.description_category_id),300);
});
test('ambiguous leaf ids stay unresolved and explain where the operator can select a complete category',async()=>{
 const result=await resolveCollectedCategoryFromCache({type_id:400},{},{},null,lookup([category(300,400),category(500,400)]));
 assert.equal(result.status,'ambiguous');assert.equal(result.category,undefined);assert.match(result.message,/多个上级类目/);
});
test('uncached official pairs and missing identifiers remain distinct; invalid ids never query a category',async()=>{
 const uncached=await resolveCollectedCategoryFromCache({description_category_id:300,type_id:400},{},{},null,lookup([]));
 assert.equal(uncached.status,'uncached');assert.equal(uncached.candidate.typeId,400);
 let calls=0;const invalid=await resolveCollectedCategoryFromCache({type_id:-1,category_ids:[0]},{},{},null,async()=>{calls++;return[]});
 assert.equal(invalid.status,'missing');assert.equal(calls,0);
});

const content=readFileSync(new URL('../ozon-erp-collector-plugin/content.js',import.meta.url),'utf8');
const nodes=new Map(),stack=[parse(content,{ecmaVersion:'latest',sourceType:'script'})];
while(stack.length){const n=stack.pop();if(!n||typeof n!=='object')continue;if(n.type==='FunctionDeclaration')nodes.set(n.id.name,n);for(const value of Object.values(n))if(Array.isArray(value))stack.push(...value);else if(value&&typeof value==='object')stack.push(value)}
function pluginFixture(){
 let release,requests=0;const writes=[],result={sku:'fixture',category_ids:[]};
 const context=vm.createContext({Promise,console,window:{},collector:{runDetailAutoFeature:async()=>result},
  enrichDetailWithSellerFallback:async value=>{requests++;await new Promise(resolve=>release=resolve);return Object.assign(value,{category_ids:[300,400],description_category_id:300,type_id:400})},
  persistCollectedResultUpdate:async(value,context)=>{writes.push({pair:[value.description_category_id,value.type_id],context})},
  buildCollectedProductListPayload:value=>({sku:value.sku,category_ids:value.category_ids,description_category_id:value.description_category_id,type_id:value.type_id})});
 for(const name of ['scheduleSellerFallbackBackfill','collectFullDetailPayloadForCollectorBox']){const node=nodes.get(name);vm.runInContext(content.slice(node.start,node.end),context)}
 return{context,result,writes,release:()=>release(),requests:()=>requests};
}
for(const timing of ['after initial save','before initial save'])test(`seller category arriving ${timing} is persisted once to its original enterprise without refetching`,async()=>{
 const f=pluginFixture(),first=await f.context.collectFullDetailPayloadForCollectorBox('fixture');assert.equal(first.payload.category_ids.length,0);assert.equal(f.writes.length,0);
 if(timing==='before initial save'){f.release();await f.result.sellerFallbackBackfillTask}
 f.result.savedCollectionId='fixture';const original={tenantId:'a',erpBaseUrl:'https://example.test'};
 const task=f.context.scheduleSellerFallbackBackfill(f.result,{persist:true,requestContext:original});
 if(timing==='after initial save')f.release();await task;
 assert.equal(f.requests(),1);assert.equal(f.writes.length,1);assert.deepEqual([...f.writes[0].pair],[300,400]);assert.equal(f.writes[0].context,original);
});

test('a manual category choice is retained when its cache is cold instead of reverting to old collected ids',async()=>{
 const result=await resolveCollectedCategoryFromCache({description_category_id:300,type_id:400},{},{description_category_id:500,type_id:600},null,lookup([category(300,400)]));
 assert.equal(result.status,'uncached');assert.equal(result.candidate.descriptionCategoryId,500);assert.equal(result.candidate.typeId,600);
});

test('an uncached explicit pair is never replaced by a cached weak breadcrumb heuristic',async()=>{
 const result=await resolveCollectedCategoryFromCache({description_category_id:300,type_id:400,category2Id:100,category3Id:200},{},{},null,lookup([category(100,200)]));
 assert.equal(result.status,'uncached');assert.equal(result.candidate.descriptionCategoryId,300);assert.equal(result.candidate.typeId,400);
});

test('legacy combined keys and Ozon-prefixed direct IDs retain their exact cached category',async()=>{
 for(const raw of [{ozon_category_id:'300:400'},{category_id:'300:400'},{ozon_description_category_id:300,ozon_type_id:400},{description_category_id:300,description_type_dict_value:400}]){
  const result=await resolveCollectedCategoryFromCache(raw,{},{},null,lookup([category(300,400)]));
  assert.equal(result.status,'resolved');assert.equal(Number(result.category.type_id),400);
 }
});
test('a failed seller persistence is marked, and a successful retry clears the failure without a second seller fetch',async()=>{
 const f=pluginFixture();await f.context.collectFullDetailPayloadForCollectorBox('fixture');f.release();await f.result.sellerFallbackBackfillTask;
 f.context.persistCollectedResultUpdate=async()=>{throw Error('offline')};
 await f.context.scheduleSellerFallbackBackfill(f.result,{persist:true});assert.equal(f.result.sellerFallbackPersistError,true);
 f.context.persistCollectedResultUpdate=async()=>{};
 await f.context.scheduleSellerFallbackBackfill(f.result,{persist:true});assert.equal(f.result.sellerFallbackPersistError,undefined);assert.equal(f.requests(),1);
});

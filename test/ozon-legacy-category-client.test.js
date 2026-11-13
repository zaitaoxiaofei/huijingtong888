import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonCategoryAttributes, fetchOzonCategoryAttributeValues, searchOzonCategoryAttributeValues } from '../src/ozonClient.js';
import { readOzonCategoryIdentity } from '../src/services/ozon-category-identity.js';
const shop={id:20,ozon_client_id:'tenant-a',ozon_api_key:'fixture-key'};
const product={id:101,offer_id:'offer-a',sku:'202',description_category_id:300,type_id:400};
const attrs=[{id:85,name:'Brand',dictionary_id:1,is_required:true}];
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','retry-after':'0'}});
function mock(t,reply){const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async(url,options)=>{const call={path:new URL(url).pathname,body:JSON.parse(options.body),client:options.headers['Client-Id']};calls.push(call);return reply(call,calls.length);};return calls;}
function provider(call){return response(call.path==='/v4/product/info/attributes'?{result:[product],total:'1',last_id:''}:{result:attrs});}

for(const options of [{descriptionCategoryId:0,description_category_id:300,typeId:0,type_id:400},{ozon_category_id:'',category_id:'300:400'},{categoryId:'300:400'},{ozon_category_id:'300:400'},{category_id:'300:400'},{description_category_id:300,type_id:400},{descriptionCategoryId:300,typeId:400},{ozon_description_category_id:300,ozon_type_id:400}])test(`precise category identity uses current endpoint: ${JSON.stringify(options)}`,async t=>{
 const calls=mock(t,provider);assert.deepEqual(await fetchOzonCategoryAttributes(shop,options),attrs);assert.equal(calls.length,1);assert.equal(calls[0].path,'/v1/description-category/attribute');assert.deepEqual(calls[0].body,{description_category_id:300,type_id:400,language:'DEFAULT'});
});
test('complete current/manual choice wins over an older stored composite key',async t=>{const calls=mock(t,provider);await fetchOzonCategoryAttributes(shop,{descriptionCategoryId:300,typeId:400,categoryId:'500:600'});assert.equal(calls[0].body.type_id,400);});
for(const [reference,filter] of [[{productId:101,offer_id:'offer-a',sku:'202'},{product_id:[101]}],[{productId:101},{product_id:[101]}],[{offerId:'offer-a'},{offer_id:['offer-a']}],[{sku:'202'},{sku:['202']}]])test(`single old category recovers only from exact original product: ${JSON.stringify(reference)}`,async t=>{
 const calls=mock(t,provider);assert.deepEqual(await fetchOzonCategoryAttributes(shop,{categoryId:999,...reference}),attrs);assert.equal(calls.length,2);assert.deepEqual(calls[0].body.filter,filter);assert.equal(calls[1].body.description_category_id,300);assert.ok(calls.every(c=>c.client==='tenant-a'));assert.ok(calls.every(c=>c.path!=='/v3/category/attribute'));
});
for(const options of [{categoryId:999},{typeId:400},{descriptionCategoryId:300},{categoryId:'300:bad'},{categoryId:'300:400:500'},{categoryId:'0:400'},{descriptionCategoryId:-1,typeId:400},{descriptionCategoryId:true,typeId:400},{descriptionCategoryId:'300.5',typeId:400},{descriptionCategoryId:301,categoryId:'300:400'}])test(`incomplete/invalid legacy input gives an actionable blocker: ${JSON.stringify(options)}`,async t=>{
 const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributes(shop,options),e=>e.statusCode===409&&/description_category_id/.test(e.message)&&/模板编辑/.test(e.message));assert.equal(calls.length,0);
});
for(const [name,rows] of [['foreign product',[{...product,id:102,offer_id:'other',sku:'203'}]],['ambiguous original product',[product,{...product,id:102}]],['missing modern pair',[{id:101,offer_id:'offer-a',sku:'202',category_id:999}]]])test(`${name} never becomes a new category guess`,async t=>{
 const calls=mock(t,()=>response({result:rows,total:String(rows.length),last_id:''}));await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:999,offerId:'offer-a'}),/原商品|完整/);assert.equal(calls.length,1);
});
test('partial stored identity cannot be mixed with a conflicting live pair',async t=>{const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributes(shop,{descriptionCategoryId:301,categoryId:999,productId:101}),/不一致/);assert.equal(calls.length,1);});
test('all provided original-product references must agree',async t=>{const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:999,productId:101,offerId:'wrong-offer',sku:'202'}),/编号一致/);assert.equal(calls.length,1);});
test('missing credentials cannot fabricate category recovery',async t=>{const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributes({id:20},{categoryId:999,productId:101}),/Client ID/);assert.equal(calls.length,0);});
test('legacy dictionary and search requests use the exact modern pair',async t=>{
 const calls=mock(t,()=>response({result:[{id:1,value:'brand'}]}));await fetchOzonCategoryAttributeValues(shop,{category_id:'300:400',attributeId:85,limit:1});await searchOzonCategoryAttributeValues(shop,{ozon_category_id:'300:400',attributeId:85,value:'brand'});assert.equal(calls.length,2);assert.ok(calls.every(c=>c.body.description_category_id===300&&c.body.type_id===400));
});
test('a lone legacy category does not masquerade as an empty dictionary',async t=>{
 const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributeValues(shop,{categoryId:999,attributeId:85}),/旧 category_id/);await assert.rejects(searchOzonCategoryAttributeValues(shop,{categoryId:999,attributeId:85,value:'brand'}),/旧 category_id/);assert.equal(calls.length,0);
});
for(const status of [403,404,429])test(`provider ${status} remains visible without old-category fallback`,async t=>{
 const calls=mock(t,()=>response({message:'provider rejected'},status));await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:999,productId:101}),e=>e.statusCode===status);assert.ok(calls.length<=3);assert.ok(calls.every(c=>c.path==='/v4/product/info/attributes'));
});
test('scope checks run around both recovery and schema reads',async t=>{mock(t,provider);let before=0,after=0;await fetchOzonCategoryAttributes(shop,{categoryId:999,productId:101,beforeRequest:async()=>{before++;return shop;},afterRequest:async()=>{after++;}});assert.equal(before,2);assert.equal(after,2);});
test('revocation after recovery prevents the schema request and result',async t=>{const calls=mock(t,provider);await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:999,productId:101,afterRequest:async()=>{throw Error('revoked');}}),/revoked/);assert.equal(calls.length,1);});
test('cancelled direct schema read never makes a request',async t=>{const calls=mock(t,provider),abort=new AbortController();abort.abort(Error('cancelled'));await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:'300:400',signal:abort.signal}),/cancelled/);assert.equal(calls.length,0);});
test('malformed schema response is not reported as an empty attribute list',async t=>{mock(t,()=>response({message:'unexpected response'}));await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:'300:400'}),/响应格式/);});
test('empty official attribute array is a legitimate empty result',async t=>{mock(t,()=>response({result:[]}));assert.deepEqual(await fetchOzonCategoryAttributes(shop,{categoryId:'300:400'}),[]);});
test('partial explicit identity can only be completed by a matching composite key',()=>{assert.deepEqual(readOzonCategoryIdentity({descriptionCategoryId:300,category_id:'300:400'}),{descriptionCategoryId:300,typeId:400});assert.throws(()=>readOzonCategoryIdentity({typeId:401,category_id:'300:400'}),/不一致/);});

for(const bad of [null,{name:'missing attribute ID'}])test(`incomplete schema rows are rejected before cache consumers: ${JSON.stringify(bad)}`,async t=>{mock(t,()=>response({result:[attrs[0],bad]}));await assert.rejects(fetchOzonCategoryAttributes(shop,{categoryId:'300:400'}),/响应格式/);});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computed} from 'vue';
import {wbNativeSize} from '../src/shared/wb-native-fields.js';

const source=readFileSync(new URL('../frontend/admin/components/listing/WbListingEditor.vue',import.meta.url),'utf8');
const brandSource=readFileSync(new URL('../frontend/admin/components/listing/WbBrandInput.vue',import.meta.url),'utf8');
const attributeSource=readFileSync(new URL('../frontend/admin/components/listing/WbAttributeInput.vue',import.meta.url),'utf8');
const clone=value=>structuredClone(value);

test('WB draft saving refuses absent category or template before attempting a request',async()=>{
 const selection=source.match(/const categorySelected=computed\([^\n]+/)?.[0];
 const guard=source.match(/function requireCategory\(\)\{[^\n]+/)?.[0];
 const save=source.match(/async function save\(\)\{[^\n]+/)?.[0];
 assert.ok(selection&&guard&&save);
 for(const schema of [{subject_id:null,template_id:null},{subject_id:0,template_id:1},{subject_id:1,template_id:0},{subject_id:-1,template_id:1},{subject_id:1.5,template_id:1}]){
  const fn=new Function('computed','props','currentApiCacheScope',`${selection};const categoryRequired='产品类目：请在顶部选择 WB 产品类目';${guard};${save};return save;`)(computed,{schema},()=>{throw Error('must not reach API setup');});
  await assert.rejects(fn(),/产品类目：请在顶部选择 WB 产品类目/);
 }
});

test('WB generic preview keeps missing identities null and retains current row content',()=>{
 const fn=source.match(/function payload\(\)\{[^\n]+/)?.[0];assert.ok(fn);
 const rows={value:[{card:{title:'Generic',vendorCode:'A',dimensions:{length:8},sizes:[{techSize:'M',price:225,skus:['12345678']}]},images:['https://example.test/current.jpg'],video_url:'https://example.test/current.mp4'}]};
 const payload=new Function('flush','rows','clone','initial','strategy','pricing','props','wbNativeSize',`${fn};return payload;`)(()=>{},rows,clone,{}, {value:'independent'}, {multiplier:1}, {schema:{subject_id:null,template_id:null}},wbNativeSize)();
 assert.equal(payload.subject_id,null);assert.equal(payload.template_id,null);
 assert.deepEqual(payload.card,rows.value[0].card);assert.deepEqual(payload.images,rows.value[0].images);assert.equal(payload.video_url,rows.value[0].video_url);
 assert.deepEqual(payload.variants,rows.value);assert.equal(payload.currency,'CNY');
});

test('WB brands never request an unselected category and still load the valid selected category',async()=>{
 const fn=brandSource.match(/async function load\(\)\{[^\n]+/)?.[0];assert.ok(fn);
 for(const subjectId of [null,undefined,0,-1,1.5]){
  const load=new Function('props',`${fn};return load;`)({subjectId});
  await assert.doesNotReject(load());
 }
 const calls=[],options={value:[]},loaded={value:false},loading={value:false};
 const load=new Function('props','loading','loaded','currentApiCacheScope','apiClient','options','ElMessage',`let sequence=0;${fn};return load;`)({subjectId:101,shopId:13,modelValue:'Typed brand'},loading,loaded,()=>1,{get:async path=>{calls.push(path);return {data:['Known brand']};}},options,{error:()=>{}});
 await load();assert.equal(calls.length,1);assert.match(calls[0],/subject_id=101&shop_id=13/);assert.deepEqual(options.value,['Typed brand','Known brand']);assert.equal(loaded.value,true);assert.equal(loading.value,false);
});

test('WB attribute options never request an unselected category',async()=>{
 const fn=attributeSource.match(/async function load\(open,refresh=false\)\{[^\n]+/)?.[0];assert.ok(fn);
 for(const subjectId of [null,undefined,0,-1,1.5]){
  const load=new Function('props',`${fn};return load;`)({subjectId});
  await assert.doesNotReject(load(true));
 }
});

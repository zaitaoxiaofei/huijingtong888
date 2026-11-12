import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {WB_SCHEMA} from '../src/services/wb-schema.js';
import {createWbPlatform} from '../src/services/wb-platform.js';
test('WB templates and CNY draft review preserve tenant isolation and never publish',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async t=>{
 const f=await createTenantMysqlFixture('wb_templates');try{
  const {query,connection}=f;for(const sql of WB_SCHEMA)await query(sql);
  await query("INSERT INTO tenants(id,slug,name,status,shop_limit) VALUES(2,'a','A','active',10),(3,'b','B','active',10)");
  await query("INSERT INTO people(id,name,active) VALUES(2,'A owner',1),(3,'B owner',1)");await query("INSERT INTO tenant_members(tenant_id,person_id,role,active) VALUES(2,2,'owner',1),(3,3,'owner',1)");
  const calls=[];const request=async(a,service,path,options={})=>{calls.push({service,path,method:options.method||'GET'});if(path==='/api/v1/seller-info')return {sid:`seller-${a.shop_id}`};if(path.includes('/object/charcs/'))return {data:[{charcID:7,subjectName:'Key covers',charcType:4,required:false,name:'Weight'}]};return {};};
  const service=createWbPlatform({query,request,transaction:async work=>{await connection.beginTransaction();try{const r=await work(connection);await connection.commit();return r;}catch(e){await connection.rollback();throw e;}}});
  const a=await service.saveShop(2,{name:'WB A',user_id:2,wb_token:'test-only'}),b=await service.saveShop(3,{name:'WB B',user_id:3,wb_token:'test-only'});await service.check(2,{shop_id:a.id});await service.check(3,{shop_id:b.id});
  const template=(await service.saveListingTemplate(2,{shop_id:a.id,name:'Key cover',subject_id:3373,defaults:{currency:'CNY',characteristics:[{id:7,value:0}]}})).template;
  await t.test('schema and numeric defaults belong only to this enterprise',async()=>{assert.equal(template.attributes[0].charcID,7);assert.equal(template.defaults.characteristics[0].value,0);assert.equal((await service.listingTemplates(3,{shop_id:b.id})).rows.length,0);await assert.rejects(service.saveListingTemplate(3,{shop_id:b.id,template_id:template.id,subject_id:3373,name:'Attack',revision:1}),e=>e.statusCode===404);});
  const payload={template_id:template.id,subject_id:3373,currency:'CNY',source_draft_id:5169,video_url:'https://example.test/review.mp4',images:['https://example.test/main.png'],card:{title:'Key cover Mercedes-Benz GLC GLE GLS',vendorCode:'WF-24244810-1',dimensions:{length:12,width:22,height:11,weightBrutto:0.22},characteristics:[{id:7,value:0}],sizes:[{techSize:'0',price:258,skus:[]}]}};
  const saved=await service.saveListingDraft(2,{shop_id:a.id,payload});
  await t.test('review draft retains 258 CNY without manufacturing a barcode or applying Ozon prices',async()=>{const row=(await service.listingDrafts(2,{shop_id:a.id})).rows[0];assert.equal(row.payload.card.sizes[0].price,258);assert.equal(row.payload.currency,'CNY');assert.equal(row.payload.video_url,'https://example.test/review.mp4');assert.equal(row.status,'draft');assert.equal(row.payload.template_revision,1);assert.deepEqual(row.payload.card.sizes[0].skus,[]);const result=await service.validateListingDraft(2,{shop_id:a.id,draft_id:saved.draft_id});assert.equal(result.review_only,true);assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes('条码')));});
  await t.test('foreign shops, stale writes, duplicate vendor and foreign templates fail closed',async()=>{await assert.rejects(service.saveListingDraft(3,{shop_id:b.id,payload}),e=>e.statusCode===404);await assert.rejects(service.saveListingDraft(2,{shop_id:a.id,payload,draft_id:saved.draft_id,revision:99}),e=>e.statusCode===409);await assert.rejects(service.saveListingDraft(2,{shop_id:a.id,payload}),e=>e.statusCode===409);await assert.rejects(service.saveListingDraft(2,{shop_id:a.id,payload:{...payload,currency:'RUB'}}),e=>e.statusCode===400);});
  assert.ok(calls.every(c=>c.method==='GET'));assert.ok(!calls.some(c=>/upload|media|barcodes|stocks|supplies/.test(c.path)));
 }finally{await f.cleanup();}
});

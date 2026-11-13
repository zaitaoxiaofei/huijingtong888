import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { listingTenantLookup } from '../src/services/listing-tenant-scope.js';
import { authorizeBusinessTaskSession } from '../src/services/business-task-tenant.js';
import * as identity from '../src/services/ozon-category-identity.js';
import { fetchOzonCategoryAttributes, fetchOzonProductInfoAttributes, resolveOzonCategoryIdentity } from '../src/ozonClient.js';
const session=id=>({personId:7,tenant:{id,slug:id===1?'default':id===2?'a':'b'}});
const source=readFileSync(new URL('../src/services/listing-automation.js',import.meta.url),'utf8');
const nodes=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.map(n=>n.declaration||n);

test('legacy category reads keep exact product, shop, credentials and enterprise boundaries', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated MySQL socket'},async t=>{
 const f=await createTenantMysqlFixture('legacy_category');const q=f.query,original=globalThis.fetch;
 try{
  try{await q('ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL');}catch(e){if(e.code!=='ER_DUP_FIELDNAME')throw e;}
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(7,'Operator','operations')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations'))");
  await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,ozon_api_key,api_key_hint) VALUES(10,NULL,'Legacy','active','client10','key10',''),(20,2,'A','active','client20','key20',''),(21,2,'Inactive','inactive','client21','key21',''),(30,3,'B','active','client30','key30',''),(40,2,'Demo','active','client40','demo-key',''),(41,2,'Missing key','active','client41',NULL,'')");
  for(const table of ['ozon_category_mappings','ozon_category_attributes','ozon_attribute_values']){
   const statement=source.match(new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\([^]*?\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'))?.[0];assert.ok(statement,table);await q(statement);
  }
  await q("INSERT INTO ozon_category_mappings(description_category_id,type_id,name_zh,status) VALUES(300,400,'A类目','active'),(500,600,'B类目','active')");
  await q("INSERT INTO ozon_category_attributes(description_category_id,type_id,attribute_id,name,dictionary_id) VALUES(300,400,85,'A attribute',0),(500,600,86,'B attribute',0)");
  await q("INSERT INTO ozon_attribute_values(description_category_id,type_id,attribute_id,dictionary_value_id,value) VALUES(300,400,85,1,'A value'),(500,600,85,2,'B value')");
  const products={client10:{id:110,offer_id:'offer-legacy',sku:'202',description_category_id:300,type_id:400},client20:{id:101,offer_id:'offer-a',sku:'202',description_category_id:300,type_id:400},client30:{id:201,offer_id:'offer-b',sku:'202',description_category_id:500,type_id:600}};
  for(const [client,p] of Object.entries(products))await q("INSERT INTO online_products(shop_id,ozon_sku,offer_id,ozon_product_id,name,attributes_json) VALUES(?,?,?,?,?,?)",[Number(client.slice(6)),p.sku,p.offer_id,String(p.id),'Original '+client,JSON.stringify({description_category_id:900,type_id:999})]);
  let calls=[],hook=null,status=200,rowsOverride=null;
  globalThis.fetch=async(url,options)=>{
   const path=new URL(url).pathname,client=options.headers['Client-Id'];assert.ok(['/v4/product/info/attributes','/v1/description-category/attribute'].includes(path));calls.push({path,client,body:JSON.parse(options.body)});if(hook){const action=hook;hook=null;await action();}
   const body=status!==200?{message:'provider rejected'}:path==='/v4/product/info/attributes'?{result:rowsOverride||[products[client]],total:String((rowsOverride||[products[client]]).length),last_id:''}:{result:[{id:87,name:'Fresh attribute',dictionary_id:0}]};
   return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','retry-after':'0'}});
  };
  const context=vm.createContext({...identity,console,Number,String,Object,Array,Map,Set,Date,JSON,listingTenantLookup,
   ensureListingAutomationSchema:async()=>{},mysqlQuery:async(sql,params=[]) => (await f.connection.query(sql,params))[0],mysqlExecute:q,currentAiTenantSession:()=>null,
   authorizeBusinessTaskSession:s=>authorizeBusinessTaskSession(s,q),fetchOzonCategoryAttributes,fetchOzonProductInfoAttributes,resolveOzonCategoryIdentity,
   parseJson:(v,fallback)=>{try{return JSON.parse(v);}catch{return fallback;}},
   normalizeOzonCategoryAttributeRow:r=>r,normalizeOzonAttributeValueRow:r=>r,pickOzonAttributeNameZh:r=>r.name||'',
   attributeValueQueryCacheKey:()=> 'fixture',getCachedAttributeValues:()=>null,setCachedAttributeValues:()=>{},isColorAttributeValueQuery:()=>false
  });
  for(const name of ['listingTenantId','all','row','run','resolveOzonApiShop','ozonCategoryShopReadOptions','resolveOzonCategoryFromSku','normalizeOzonCategoryRow','hasCyrillicText','buildOzonCategoryKey','listingOzonCategoryAttributes','listingOzonAttributeValues','attachCachedAttributeValues','syncListingOzonCategoryAttributes','syncListingOzonAttributeValues','fetchOzonCategoryAttributesForProduct']){
   const node=nodes.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.ok(node,name);vm.runInContext(source.slice(node.start,node.end),context);
  }
  const reset=()=>{calls=[];hook=null;status=200;rowsOverride=null;};
  await t.test('exact historical composite keys read official attribute and dictionary caches',async()=>{
   const attrs=await context.listingOzonCategoryAttributes({category_id:'300:400',auto_sync:false},session(2));assert.equal(attrs[0].attribute_id,85);
   const values=await context.listingOzonAttributeValues({ozon_category_id:'300:400',attribute_id:85,auto_refresh:false},session(2));assert.equal(values[0].value,'A value');assert.equal(calls.length,0);
  });
  await t.test('a lone old category is blocked before reads or schema-cache writes',async()=>{
   const before=await q('SELECT * FROM ozon_category_attributes ORDER BY id');
   for(const [fn,body]of [['listingOzonCategoryAttributes',{category_id:999}],['listingOzonAttributeValues',{category_id:999,attribute_id:85}],['syncListingOzonCategoryAttributes',{category_id:999,shop_id:20}],['syncListingOzonAttributeValues',{category_id:999,attribute_id:85,shop_id:20}]])await assert.rejects(context[fn](body,session(2)),/旧 category_id/);
   assert.deepEqual(await q('SELECT * FROM ozon_category_attributes ORDER BY id'),before);assert.equal(calls.length,0);
  });
  await t.test('a cold category cache preserves provider errors rather than claiming no attributes',async()=>{
   reset();status=403;await assert.rejects(context.listingOzonCategoryAttributes({category_id:'700:800',shop_id:20},session(2)),e=>e.statusCode===403);assert.equal(calls.length,1);assert.equal((await q('SELECT COUNT(*) AS n FROM ozon_category_attributes WHERE description_category_id=700 AND type_id=800'))[0].n,0);
  });
  await t.test('a revoked member cannot begin original-product category lookup',async()=>{
   reset();await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),e=>e.statusCode===403);assert.equal(calls.length,0);await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7');
  });
  await t.test('A/B/default lookup uses same-shop exact original product despite stale cached pairs',async()=>{
   for(const [tenant,shop,type]of [[2,20,400],[3,30,600],[1,10,400]]){reset();const result=await context.resolveOzonCategoryFromSku({sku:'202',shop_id:shop},session(tenant));assert.equal(result.category.type_id,type);assert.ok(calls.every(c=>c.client==='client'+shop));}
  });
  await t.test('automatic shop lookup never selects another enterprise for an identical SKU',async()=>{
   reset();const result=await context.resolveOzonCategoryFromSku({sku:'202'},session(2));assert.equal(result.shopId,20);assert.equal(result.category.type_id,400);assert.ok(calls.every(c=>c.client==='client20'));
  });
  await t.test('foreign, inactive, demo and missing-key shops fail before provider access',async()=>{
   for(const shop of [30,21,40,41]){reset();await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:shop},session(2)),/当前企业中所选店铺/);assert.equal(calls.length,0);}
  });
  await t.test('ambiguous matches across owned shops require an explicit original shop',async()=>{
   reset();await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,ozon_api_key,api_key_hint) VALUES(22,2,'Another A','active','client22','key22','')");await q("INSERT INTO online_products(shop_id,ozon_sku,offer_id,ozon_product_id,name) VALUES(22,'202','offer-another','222','Another product')");await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202'},session(2)),/多个店铺/);assert.equal(calls.length,0);assert.equal((await context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2))).shopId,20);await q('DELETE FROM online_products WHERE shop_id=22');await q('DELETE FROM shops WHERE id=22');
  });
  await t.test('ambiguous SKU/catalog ID matches within one shop cannot select the first cache row',async()=>{
   reset();await q("INSERT INTO online_products(shop_id,ozon_sku,offer_id,ozon_product_id,name) VALUES(20,'203','offer-other','202','Other product')");await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),/唯一商品/);assert.equal(calls.length,0);assert.equal((await context.resolveOzonCategoryFromSku({offer_id:'offer-a',shop_id:20},session(2))).category.type_id,400);await q("DELETE FROM online_products WHERE shop_id=20 AND ozon_sku='203'");
  });
  await t.test('a WB shop carrying stale Ozon-looking credentials is not an Ozon category source',async()=>{
   reset();await q("INSERT INTO shops(id,tenant_id,name,status,platform,ozon_client_id,ozon_api_key,api_key_hint) VALUES(42,2,'WB','active','wb','client42','key42','')");await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:42},session(2)),/当前企业中所选店铺/);assert.equal(calls.length,0);
  });
  await t.test('credential replacement during response cannot return a recovered pair',async()=>{
   reset();hook=()=>q("UPDATE shops SET ozon_api_key='rotated' WHERE id=20");await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),/授权已变化/);assert.equal(calls.length,1);await q("UPDATE shops SET ozon_api_key='key20' WHERE id=20");
  });
  await t.test('membership revocation during response blocks the result',async()=>{
   reset();hook=()=>q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),e=>e.statusCode===403);assert.equal(calls.length,1);await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7');
  });
  await t.test('shop reassignment during response cannot leak the original metadata',async()=>{
   reset();hook=()=>q('UPDATE shops SET tenant_id=3 WHERE id=20');await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),/当前企业中所选店铺/);assert.equal(calls.length,1);await q('UPDATE shops SET tenant_id=2 WHERE id=20');
  });
  await t.test('a stopped shop during response cannot return category metadata',async()=>{
   reset();hook=()=>q("UPDATE shops SET status='inactive' WHERE id=20");await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),/当前企业中所选店铺/);await q("UPDATE shops SET status='active' WHERE id=20");
  });
  await t.test('403 remains an error instead of falling back to old cached classification',async()=>{
   reset();status=403;await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),e=>e.statusCode===403);assert.equal(calls.length,1);
  });
  await t.test('a mismatched original product is never replaced by the first response row',async()=>{
   reset();rowsOverride=[{...products.client30}];await assert.rejects(context.resolveOzonCategoryFromSku({sku:'202',shop_id:20},session(2)),/编号一致/);
  });
  await t.test('template refresh gets the recovered modern pair without mutating its input or storage',async()=>{
   reset();const shop=await context.resolveOzonApiShop(20,session(2));const detail={id:101,offer_id:'offer-a',sku:'202',category_id:999,images:['https://example.invalid/current.jpg']},original=JSON.stringify(detail);
   const before=await q('SELECT * FROM online_products ORDER BY id');const result=await context.fetchOzonCategoryAttributesForProduct(shop,detail,session(2));assert.equal(result.detail.description_category_id,300);assert.equal(result.detail.type_id,400);assert.equal(result.attributes[0].id,87);assert.equal(JSON.stringify(detail),original);assert.deepEqual(await q('SELECT * FROM online_products ORDER BY id'),before);assert.equal(calls.length,2);
  });
  await t.test('explicit composite sync writes only the corresponding official dictionary pair',async()=>{
   reset();const result=await context.syncListingOzonCategoryAttributes({category_id:'300:400',shop_id:20},session(2));assert.equal(result.saved,1);assert.equal(calls[0].body.description_category_id,300);assert.equal(calls[0].body.type_id,400);const saved=await q('SELECT description_category_id,type_id FROM ozon_category_attributes WHERE attribute_id=87');assert.deepEqual(saved,[{description_category_id:300,type_id:400}]);
  });
 }finally{globalThis.fetch=original;await f.cleanup();}
});

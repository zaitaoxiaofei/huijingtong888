import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {prepareInventoryNumberingV2Schema,installInventoryNumberingV2Triggers,inspectInventoryNumberingV2Schema} from '../src/services/inventory-numbering-v2.js';
import {inventoryProductSearch} from '../src/services/inventory-product-search.js';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
import {handleCatalogRestRoute} from '../src/server/routes/catalog.js';

test('actual V2 inventory edits retain stable product identity and record only committed owned history',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('product_history');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {productEditHistory,ensureProductNameAliasSchema}=await import('../src/services/product-edit-history.js');
 const naming=await import('../src/services/inventory-product-naming.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const session=(personId,tenantId=2)=>({personId,roles:[personId===11?'manager':personId===8?'packing':personId===10?'technical':'procurement'],tenant:{id:tenantId,slug:tenantId===1?'default':tenantId===2?'a':'b'}});
 const buyer=session(7),packer=session(8),foreign=session(9,3),manager=session(11),defaultActor=session(1,1);
 const product=async(id=200)=>(await q('SELECT * FROM products WHERE id=?',[id]))[0];
 const payload=async(id=200,changes={})=>{const {observed_updated_at,...row}=(await q("SELECT p.*,DATE_FORMAT(p.updated_at,'%Y-%m-%d %H:%i:%s') AS observed_updated_at FROM products p WHERE p.id=?",[id]))[0];return {...row,updated_at:observed_updated_at,owner_person_id:id===100?1:7,...changes};};
 const save=async(changes={},id=200,actor=buyer,tenantId=2)=>api.updateProductMysql(id,await payload(id,changes),tenantId,{session:actor});
 const history=(id=200,actor=buyer,params={})=>productEditHistory(id,params,actor);
 const json=value=>JSON.parse(JSON.stringify(value));
 const versions=async id=>Number((await q("SELECT COUNT(*) n FROM inventory_flow_events WHERE tenant_id=2 AND product_id=? AND action='product_edit'",[id]))[0].n);
 let firstNumber;
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Default editor','procurement'),(7,'A editor','procurement'),(8,'A packing','packing'),(9,'Foreign editor','procurement'),(10,'No inventory reader','technical'),(11,'A naming manager','manager')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(1,1,'member',JSON_ARRAY('procurement'),1),(2,7,'member',JSON_ARRAY('procurement'),1),(2,8,'member',JSON_ARRAY('packing'),1),(3,9,'member',JSON_ARRAY('procurement'),1),(2,10,'member',JSON_ARRAY('technical'),1),(2,11,'member',JSON_ARRAY('manager'),1)");
  await api.warmCoreInventoryRuntimeMysql('admin');await ensureProductNameAliasSchema();
  await naming.inventoryProductNamingOptions({},manager);
  await prepareInventoryNumberingV2Schema(f.connection);await installInventoryNumberingV2Triggers(f.connection);await q('UPDATE inventory_numbering_state SET version=2 WHERE id=1');
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).active,true);
  for(const [id,tenant,category,brand,owner] of [[100,null,'钥匙壳','TENET',1],[200,2,'钥匙壳','TENET',7],[201,2,'门槛条','TENET',7],[203,2,'配件','TENET',7],[204,2,'赠品','TENET',7],[300,3,'门槛条','TENET',9]]){
   await q("INSERT INTO products(id,tenant_id,name,code,inventory_category,vehicle_brand,fitment_type,vehicle_model,vehicle_models_json,accessory_name,product_quantity,stock_unit,package_mode,product_type,selection_status,owner_person_id,created_by_person_id,purchase_cost,purchase_url,supplier_note,package_weight_g,length_cm,width_cm,height_cm) VALUES(?,?,'同名库存',?, ?,?,'specific','T7',JSON_ARRAY('T7'),'普通款',1,'个','single','main','listed',?,?,17,'https://private.invalid/purchase','PRIVATE-SUPPLIER-NOTE',50,10,10,10)",[id,tenant,'P-HISTORY-'+id,category,brand,owner,owner]);
  }
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A shop'),(30,3,'B shop')");
  await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(2000,2,20,200,'KEEP-SKU',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(500,20,'KEEP-ORDER','cancelled',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(501,500,2000,'KEEP-SKU',1,20)");
  await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at,total_quantity,total_amount) VALUES(2000,2,'KEEP-PURCHASE','purchased',UTC_TIMESTAMP(),2,20)");
  await q("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,requested_quantity,actual_quantity,amount,status) VALUES(2001,2,2000,200,2,2,20,'purchased')");
  await q("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,purchase_order_id,purchase_order_item_id,status) VALUES(2002,2,200,2,20,2000,2001,'pending_arrival')");
  const references=async()=>json({mappings:await q('SELECT id,product_id,ozon_sku FROM sku_mappings'),purchases:await q('SELECT id,purchase_order_id,product_id,actual_quantity,amount FROM purchase_order_items'),inbounds:await q('SELECT id,product_id,quantity,amount,status FROM inbound_records'),movements:await q('SELECT * FROM inventory_movements')});
  const referenceBefore=await references();

  await t.test('existing products start with an honest empty history and same names do not join histories',async()=>{
   const initial=await history();firstNumber=initial.current.inventory_number;
   assert.equal(initial.product_id,200);assert.equal(initial.current.id,200);assert.equal(initial.total,0);assert.deepEqual(initial.rows,[]);assert.equal(initial.history_complete,false);assert.match(initial.history_notice,/不能|不.*还原/);
   assert.equal(initial.current.name,'同名库存');assert.match(firstNumber,/^\d+-\d+-\d+$/);
   assert.notEqual((await history(300,foreign)).current.inventory_number,firstNumber,'number allocation remains globally unique across enterprises');
   await assert.rejects(history(200,foreign),{statusCode:404});await assert.rejects(history(200,session(10)),{statusCode:403});
  });
  await t.test('real HTTP catalog dispatch allows packing reads but rejects foreign, revoked and non-reader requests',async()=>{
   const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
   const actors={packing:packer,buyer,foreign,technical:session(10),default:defaultActor};
   const server=createServer(async(req,res)=>{
    try{
     req._session=actors[req.headers['x-test-actor']];
     const url=new URL(req.url,'http://127.0.0.1:8788'),parts=url.pathname.split('/').filter(Boolean);
     const isolation=tenantIsolationDecision(req._session,parts,req.method);
     if(!isolation.allowed)return send(res,{error:isolation.error},403);
     const permission=authorizeApiRequest(req,parts);
     if(!permission.allowed)return send(res,{error:permission.error},permission.status||403);
     await handleCatalogRestRoute({req,res,url,parts,services:{productEditHistory},json:send});
     if(!res.writableEnded)send(res,{error:'Not found'},404);
    }catch(error){send(res,{error:error.message},error.statusCode||error.status||500);}
   });
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
   const request=(actor,path='/api/products/200/edit-history')=>fetch('http://127.0.0.1:8788'+path,{headers:{'x-test-actor':actor}});
   try{
    const response=await request('packing');assert.equal(response.status,200);assert.equal((await response.json()).product_id,200);
    assert.equal((await request('default','/api/products/100/edit-history')).status,200);
    assert.equal((await request('technical')).status,403);assert.equal((await request('foreign')).status,404);
    assert.equal((await request('packing','/api/products/200/edit-history/extra')).status,403);
    assert.equal((await request('packing','/api/products/200/edit-history?page=Infinity')).status,400);
    await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2 AND person_id=8");
    try{assert.equal((await request('packing')).status,403,'fresh DB roles override the packing session cached by the route');}finally{await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=8");}
   }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
  await t.test('a same-group name edit retains its number and saves one real before/after and old-name alias',async()=>{
   await save({name:'改名后的库存'});
   const saved=await product(),result=await history(),event=result.rows[0];
   assert.equal(saved.id,200);assert.equal(saved.code,'P-HISTORY-200');assert.equal(saved.inventory_number,firstNumber);
   assert.equal(result.total,1);assert.equal(event.source,'catalog_edit');assert.equal(event.actor.id,7);assert.equal(event.actor.name,'A editor');
   assert.equal(event.before.name,'同名库存');assert.equal(event.after.name,'改名后的库存');assert.equal(event.after.inventory_number,firstNumber);assert.ok(event.changed_fields.includes('name'));
   assert.ok(result.name_aliases.some(row=>row.name==='同名库存'));assert.equal((await history(201)).total,0);assert.equal((await history(300,foreign)).total,0);
   for(const secret of ['PRIVATE-SUPPLIER-NOTE','private.invalid','purchase_cost','supplier_note'])assert.ok(!JSON.stringify(result).includes(secret));
   await save();assert.equal((await history()).total,1,'unchanged identity does not invent a version');
  });
  await t.test('a real core/brand regroup records the final triggered number while every business relation stays stable',async()=>{
   const before=await product();
   await save({vehicle_brand:'GEELY',vehicle_model:'GX',structured_naming:{category:'门槛条',vehicle_brand:'GEELY',fitment_type:'specific',vehicle_model:'GX',vehicle_models:['GX'],accessory:'普通款',colors:['红'],materials:['塑料'],quantity:1,stock_unit:'个',package_mode:'single'}});
   const after=await product(),result=await history(),event=result.rows[0];
   assert.equal(after.id,before.id);assert.equal(after.code,before.code);assert.notEqual(after.inventory_number,before.inventory_number);assert.equal(after.inventory_number_version,2);
   assert.equal(event.before.inventory_number,before.inventory_number);assert.equal(event.after.inventory_number,after.inventory_number);assert.equal(event.after.name,after.name);assert.equal(event.after.inventory_category,'门槛条');assert.equal(event.after.vehicle_brand,'GEELY');
   assert.ok(result.number_aliases.some(row=>row.number===before.inventory_number));assert.deepEqual(await references(),referenceBefore);
   const scope={id:2,isDefault:false},search=inventoryProductSearch({searchMode:'inventory_id',query:before.inventory_number},scope);
   const matches=await q(`SELECT p.id FROM products p WHERE p.tenant_id=2 AND ${search.sql}`,search.params);assert.deepEqual(matches.map(row=>row.id),[200]);
  });
  await t.test('internal catalog callers retain the real version without inventing an editor',async()=>{
   await api.updateProductMysql(203,await payload(203,{name:'内部编辑配件'}),2);
   const result=await history(203);assert.equal(result.total,1);assert.deepEqual(result.rows[0].actor,{id:null,name:null});assert.equal(result.rows[0].source,'catalog_edit');
  });
  await t.test('composition snapshots keep only owned physical identity fields and no-op saves stay silent',async()=>{
   await save({composition_items:[{component_product_id:203,quantity:2,component_role:'included'},{component_product_id:204,quantity:1,component_role:'gift'}]});
   const result=await history(),event=result.rows[0];
   assert.ok(event.changed_fields.includes('components'));assert.deepEqual(event.after.components,[{product_id:203,quantity:2,component_role:'included'},{product_id:204,quantity:1,component_role:'gift'}]);
   const count=result.total;await save();assert.equal((await history()).total,count);assert.deepEqual(await references(),referenceBefore);
  });
  await t.test('stale, foreign and revoked writes never leave a successful version',async()=>{
   const before=json(await product()),count=await versions(200);
   await assert.rejects(save({updated_at:'2000-01-01T00:00:00Z',name:'过期保存'}),error=>error.status===409||error.statusCode===409);
   await assert.rejects(save({name:'仓库越权'},200,packer),{statusCode:403});await assert.rejects(save({name:'外企业越权'},300,buyer),{statusCode:404});
   await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2 AND person_id=7");
   try{await assert.rejects(save({name:'撤权保存'}),{statusCode:403});await assert.rejects(history(),{statusCode:403});}finally{await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");}
   assert.deepEqual(json(await product()),before);assert.equal(await versions(200),count);assert.equal((await history(200,packer)).product_id,200);
  });
  await t.test('a failed audit rolls back product, aliases and V2 numbering together',async()=>{
   const before=json(await product()),numbers=json(await q('SELECT * FROM inventory_number_aliases WHERE product_id=200')),names=json(await q('SELECT * FROM product_name_aliases WHERE product_id=200')),count=await versions(200);
   const numbering=async()=>json({categories:await q('SELECT * FROM inventory_number_core_categories_v2 ORDER BY id'),brands:await q('SELECT * FROM inventory_number_brands_v2 ORDER BY id'),sequences:await q('SELECT * FROM inventory_number_sequences_v2 ORDER BY category_id,brand_id')});
   const numberingBefore=await numbering();
   await f.connection.query("CREATE TRIGGER fail_product_edit_audit BEFORE INSERT ON inventory_flow_events FOR EACH ROW BEGIN IF NEW.action='product_edit' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated history audit failure'; END IF; END");
   try{await assert.rejects(save({vehicle_brand:'TENET',structured_naming:{category:'车贴',vehicle_brand:'TENET',fitment_type:'specific',vehicle_model:'T7',vehicle_models:['T7'],accessory:'普通款',quantity:1,stock_unit:'个',package_mode:'single'}}),/isolated history audit failure/);}finally{await f.connection.query('DROP TRIGGER fail_product_edit_audit');}
   assert.deepEqual(json(await product()),before);assert.deepEqual(json(await q('SELECT * FROM inventory_number_aliases WHERE product_id=200')),numbers);assert.deepEqual(json(await q('SELECT * FROM product_name_aliases WHERE product_id=200')),names);assert.equal(await versions(200),count);
   assert.deepEqual(await numbering(),numberingBefore,'failed history also rolls back dictionary and sequence allocations');
  });
  await t.test('default NULL products work while aliases and forged event payloads never leak another enterprise',async()=>{
   await save({name:'默认企业旧归属编辑'},100,defaultActor,'admin');const legacy=await history(100,defaultActor);assert.equal(legacy.current.id,100);assert.equal(legacy.rows[0].actor.id,1);assert.equal((await product(100)).tenant_id,null);
   await q("INSERT INTO product_name_aliases(tenant_id,product_id,alias_name,alias_type) VALUES(3,200,'FOREIGN-NAME-SECRET','previous_name')");
   await q("INSERT INTO inventory_number_aliases(tenant_id,product_id,alias_number) VALUES(3,200,'991-991-991')");
   const forged={source:'catalog_edit',before:{id:300,name:'FOREIGN-PAYLOAD-SECRET'},after:{id:300,name:'FOREIGN-PAYLOAD-SECRET'},changed_fields:['name']};
   await q("INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(2,200,9,'product_edit',?),(3,200,9,'product_edit',?)",[JSON.stringify(forged),JSON.stringify(forged)]);
   const result=await history(),unavailable=result.rows.find(row=>row.unavailable);assert.ok(unavailable);assert.equal(unavailable.before,null);assert.equal(unavailable.after,null);assert.equal(unavailable.actor.name,null);
   for(const secret of ['FOREIGN-NAME-SECRET','991-991-991','FOREIGN-PAYLOAD-SECRET','Foreign editor'])assert.ok(!JSON.stringify(result).includes(secret));
  });
  await t.test('disabled old-name aliases stay disabled and foreign alias conflicts roll back the rename',async()=>{
   await q("UPDATE product_name_aliases SET active=0 WHERE tenant_id=2 AND product_id=200 AND alias_name='同名库存'");await save({name:'同名库存'});await save({name:'再次改名'});
   assert.equal((await q("SELECT active FROM product_name_aliases WHERE product_id=200 AND alias_name='同名库存'"))[0].active,0);
   await q("INSERT INTO product_name_aliases(tenant_id,product_id,alias_name,alias_type) VALUES(3,200,'再次改名','previous_name')");
   const before=json(await product()),count=await versions(200);await assert.rejects(save({name:'不可保存的改名'}),{statusCode:409});assert.deepEqual(json(await product()),before);assert.equal(await versions(200),count);
   await q("DELETE FROM product_name_aliases WHERE tenant_id=3 AND product_id=200 AND alias_name='再次改名'");
  });
  await t.test('a reviewed core-name edit records each affected owned product and paginates only real events',async()=>{
   const option=await naming.createInventoryProductNamingOption({option_type:'category',value:'门槛条'},manager);
   const before=await product(),foreignBefore=json(await product(300));await naming.updateInventoryProductNamingOption(option.id,{value:'门槛饰条'},manager);
   const after=await product(),result=await history();assert.equal(after.inventory_category,'门槛饰条');assert.notEqual(after.inventory_number,before.inventory_number);assert.equal(after.id,200);
   assert.equal(result.rows[0].source,'core_name_edit');assert.equal(result.rows[0].actor.id,11);assert.equal(result.rows[0].before.inventory_number,before.inventory_number);assert.equal(result.rows[0].after.inventory_number,after.inventory_number);
   assert.deepEqual(json(await product(300)),foreignBefore);assert.equal((await history(201)).rows[0].source,'core_name_edit');
   const page1=await history(200,buyer,{page:1,pageSize:1}),page2=await history(200,buyer,{page:2,pageSize:1});assert.equal(page1.total,page2.total);assert.equal(page1.rows.length,1);assert.equal(page2.rows.length,1);assert.notEqual(page1.rows[0].id,page2.rows[0].id);
   assert.deepEqual(await references(),referenceBefore);
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { loadTenantOrderService } from './helpers/tenant-order-service.js';

test('catalog import and online archive remain usable within A/B/default without widening the legacy gate', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires the explicit independent MySQL socket', timeout:180000
}, async t => {
  const fixture=await createTenantMysqlFixture('catalog_compat');
  let closeMysqlPool;
  const originalFetch=globalThis.fetch;
  try {
    fixture.useEnvironment();
    const {query,connection}=fixture;
    const service=await import('../src/services/mysql-cutover.js');
    ({closeMysqlPool}=await import('../src/mysql-pool.js'));
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role,username) VALUES(1,'Default actor','admin','default-actor'),(2,'A actor','admin','a-actor'),(3,'B actor','admin','b-actor')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(1,1,'Default shop'),(2,2,'A shop'),(3,3,'B shop'),(4,NULL,'Legacy shop')");
    await service.warmCoreInventoryRuntimeMysql('admin');
    await t.test('CSV names resolve only enterprise members and commits ignore forged ownership',async()=>{
      const preview=await service.previewProductCsvImportMysql({csv:'商品名称,人员,汇率\nA CSV,B actor,11.32'},2);
      assert.equal(preview.rows[0].data.owner_person_id,null);
      for(const tenant of [1,2,3]) {
        const result=await service.commitProductCsvImportMysql({tenant_id:tenant===2?3:2,rows:[{name:`csv-${tenant}`,tenant_id:tenant===2?3:2}]},tenant,tenant===1?'admin':tenant);
        assert.equal(result.inserted,1,JSON.stringify(result));
      }
      assert.deepEqual((await query("SELECT tenant_id,owner_person_id,created_by_person_id FROM products WHERE name LIKE 'csv-%' ORDER BY tenant_id")).map(row=>[Number(row.tenant_id),Number(row.owner_person_id),Number(row.created_by_person_id)]),[[1,1,1],[2,2,2],[3,3,3]]);
      const before=await query('SELECT * FROM products WHERE tenant_id=3 ORDER BY id');
      const bad=await service.commitProductCsvImportMysql({rows:[{name:'not-created',owner_person_id:3}]},2,2);
      assert.equal(bad.inserted,0);assert.equal(bad.skipped,1);
      await assert.rejects(service.commitProductCsvImportMysql({rows:[{name:'invalid-actor'}]},3,2),{statusCode:400});
      assert.deepEqual(await query('SELECT * FROM products WHERE tenant_id=3 ORDER BY id'),before);
    });
    await t.test('selection add/remove/delete/restore refuse foreign IDs and preserve the existing own workflow',async()=>{
      const own=await service.createProductMysql({name:'complete selection',product_type:'selection',image_url:'https://example.invalid/a.png',inventory_category:'test',accessory_name:'part',purchase_cost:1,package_weight_g:100,length_cm:10,width_cm:10,height_cm:10,stock_unit:'unit',owner_person_id:2,created_by_person_id:2},null,2);
      const foreign=(await query('SELECT id FROM products WHERE tenant_id=3 LIMIT 1'))[0].id;
      const before=await query('SELECT * FROM products WHERE id=?',[foreign]);
      await assert.rejects(service.addSelectionToInventoryMysql(foreign,2),{statusCode:404});
      await assert.rejects(service.removeProductFromInventoryMysql(foreign,'admin'),{statusCode:404});
      await assert.rejects(service.deleteProductMysql(foreign,2),{statusCode:404});
      await service.addSelectionToInventoryMysql(own.id,2);
      assert.equal((await query('SELECT selection_status FROM products WHERE id=?',[own.id]))[0].selection_status,'listed');
      await service.removeProductFromInventoryMysql(own.id,2);
      assert.equal(Number((await query('SELECT active FROM products WHERE id=?',[own.id]))[0].active),0);
      await service.restoreProductMysql(own.id,2);
      assert.equal(Number((await query('SELECT active FROM products WHERE id=?',[own.id]))[0].active),1);
      assert.deepEqual(await query('SELECT * FROM products WHERE id=?',[foreign]),before);
    });
    const sessions=tenant=>({personId:tenant,tenant:{id:tenant,slug:tenant===1?'default':tenant===2?'a':'b',role:'admin'},roles:['admin']});
    const opts=tenant=>({session:sessions(tenant)});
    const onlineEntries=[];
    await t.test('online bind and create-from-online validate all product/person/recipe references before writes',async()=>{
      for(const tenant of [1,2,3]) {
        const own=(await query("SELECT id FROM products WHERE name=?",[`csv-${tenant}`]))[0].id;
        const created=await service.createOnlineProductMysql({shop_id:tenant,ozon_sku:`bind-${tenant}`,offer_id:`bind-offer-${tenant}`,name:`Bind ${tenant}`,sale_price:100},tenant);
        onlineEntries.push({tenant,own,online:created.id});
        const foreign=(await query('SELECT id FROM products WHERE tenant_id=? LIMIT 1',[tenant===3?2:3]))[0].id;
        const before=await query('SELECT * FROM online_products WHERE id=?',[created.id]);
        await assert.rejects(service.bindOnlineProductMysql({online_product_id:created.id,product_id:foreign},tenant,opts(tenant)),{statusCode:404});
        await assert.rejects(service.bindOnlineProductMysql({online_product_id:created.id,product_id:own,inventory_recipe:{mode:'combo',items:[{product_id:foreign,quantity:1}]}},tenant,opts(tenant)),{statusCode:404});
        assert.deepEqual(await query('SELECT * FROM online_products WHERE id=?',[created.id]),before);
        await service.bindOnlineProductMysql({online_product_id:created.id,product_id:own,person_id:tenant,inventory_recipe:{mode:'single',items:[]}},tenant,opts(tenant));
        assert.equal(Number((await query('SELECT product_id FROM online_products WHERE id=?',[created.id]))[0].product_id),own);
        const reused=await service.createProductFromOnlineProductMysql({online_product_id:created.id,owner_person_id:tenant,created_by_person_id:tenant},tenant,opts(tenant));
        assert.equal(Number(reused.id),own);assert.equal(reused.reused,true);
        const unbound=await service.createOnlineProductMysql({shop_id:tenant,ozon_sku:`create-${tenant}`,offer_id:`new-offer-${tenant}`,name:`New ${tenant}`,sale_price:100},tenant);
        const made=await service.createProductFromOnlineProductMysql({online_product_id:unbound.id,owner_person_id:tenant,created_by_person_id:tenant},tenant,opts(tenant));
        assert.equal(Number((await query('SELECT tenant_id FROM products WHERE id=?',[made.id]))[0].tenant_id),tenant);
      }
      await assert.rejects(service.bindOnlineProductMysql({online_product_id:onlineEntries[2].online,product_id:onlineEntries[1].own},2,opts(2)),{statusCode:404});
      await assert.rejects(service.createProductFromOnlineProductMysql({online_product_id:onlineEntries[2].online,owner_person_id:2},'admin',opts(1)),{statusCode:404});
    });
    const listing=await import('../src/services/listing-automation.js');
    await listing.ensureListingAutomationSchema();
    await t.test('inventory quick draft stores enterprise ownership and cannot reuse a foreign poisoned draft',async()=>{
      const foreign=await query("INSERT INTO listing_drafts(tenant_id,product_name,source_product_id,status,source_urls_json,source_images_json,manual_facts_json,ai_payload_json,template_payload_json) VALUES('3','Foreign poisoned draft',?,'draft','[]','[]','{}','{}','{}')",[onlineEntries[1].own]);
      const before=await query('SELECT * FROM listing_drafts WHERE id=?',[foreign.insertId]);
      for(const {tenant,own}of onlineEntries) {
        const draft=await listing.createInventoryProductListingDraft({product_id:own,tenant_id:'3'},sessions(tenant));
        assert.notEqual(Number(draft.id),Number(foreign.insertId));
        assert.equal((await query('SELECT tenant_id FROM listing_drafts WHERE id=?',[draft.id]))[0].tenant_id,tenant===1?'admin':String(tenant));
        const again=await listing.createInventoryProductListingDraft({product_id:own},sessions(tenant));
        assert.equal(Number(again.id),Number(draft.id));assert.equal(again.reused,true);
      }
      await assert.rejects(listing.createInventoryProductListingDraft({product_id:onlineEntries[2].own},sessions(2)),{statusCode:404});
      await assert.rejects(listing.createInventoryProductListingDraft({product_id:onlineEntries[2].own},sessions(1)),{statusCode:404});
      assert.deepEqual(await query('SELECT * FROM listing_drafts WHERE id=?',[foreign.insertId]),before);
    });
    await t.test('runtime online edit wrapper forwards the session and ignores foreign publish snapshots',async()=>{
      const remoteCalls=[];
      await query("UPDATE shops SET ozon_client_id=CONCAT('client-',id),api_key_hint='fixture-key' WHERE id IN(1,2,3)");
      globalThis.fetch=async(url,request)=>{
        remoteCalls.push({url:String(url),client:request.headers['Client-Id']});
        return {ok:true,status:200,text:async()=>JSON.stringify({result:[{id:123,offer_id:'live-offer',name:'Own live draft',attributes:[],images:[]}]})};
      };
      const ownA=onlineEntries[1];
      await query("INSERT INTO listing_publish_records(tenant_id,draft_id,shop_id,source_product_id,offer_id,status,template_snapshot_json) VALUES('3',0,2,?,'bind-offer-2','success',?)",[ownA.online,JSON.stringify({title:'B secret snapshot',editable_payload:{title:'B secret snapshot'}})]);
      const beforeCalls=remoteCalls.length;
      await assert.rejects(listing.onlineProductListingEditDraft(onlineEntries[2].online,{},sessions(2)),{statusCode:404});
      assert.equal(remoteCalls.length,beforeCalls);
      for(const {tenant,online}of onlineEntries) {
        const draft=await listing.onlineProductListingEditDraft(online,{auto_sync:false,diagnostics:false},sessions(tenant));
        assert.equal(Number(draft.shop_id),tenant);assert.equal(remoteCalls.at(-1).client,`client-${tenant}`);
        assert.notEqual(draft.template.title,'B secret snapshot');
      }
      globalThis.fetch=originalFetch;
    });

    const remote=[];let afterRemote=async()=>{};
    const methods=['performOnlineProductActionMysql','activeShopForTenantMysql','recordOnlineProductActionMysql','finishOnlineProductActionMysql','resolveOnlineProductZeroStockTargetsMysql','resolveFreshOzonProductIdForArchiveMysql','isOzonItemNotFoundError','relatedArchivedOnlineProductExceptionTaskIdsMysql','markArchivedOnlineProductExceptionsHandledMysql','archivedOnlineOrderExceptionTaskIdsMysql','exceptionTaskMysql','upsertExceptionTaskStatesMysql','assertExceptionTaskOwnershipMysql'];
    const {service:archive}=loadTenantOrderService(connection,{extraMethods:methods,
      ensureMysqlColumns:async()=>{},ensureProfitAnalyticsSchemaMysql:async()=>{},invalidateExceptionWorkbenchCache(){},invalidateTenantExceptionWorkbenchMysql:async()=>{},
      stockAlertsMysql:async()=>({rows:[]}),
      updateOzonProductStocks:async(shop,targets)=>{remote.push(['stock',shop.id,targets]);await afterRemote();return {ok:true};},
      archiveOzonProducts:async(shop,ids)=>{remote.push(['archive',shop.id,ids]);await afterRemote();return {ok:true};},
      fetchOzonProductStocks:async(shop)=>{remote.push(['resolve',shop.id]);await afterRemote();return [{offer_id:'resolve-offer',ozon_product_id:2222}];}
    });
    await query("INSERT INTO online_products(id,shop_id,ozon_sku,offer_id,name,ozon_product_id) VALUES(10,1,'same','default-offer','Default','1000'),(20,2,'same','a-offer','A','2000'),(30,3,'same','b-offer','B','3000'),(40,4,'same','legacy-offer','Legacy','4000'),(21,2,'resolve','resolve-offer','Resolve',NULL)");
    await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(10,1,'same-posting','awaiting_packaging','2026-10-22'),(20,2,'same-posting','awaiting_packaging','2026-10-22'),(30,3,'same-posting','awaiting_packaging','2026-10-22'),(40,4,'same-posting','awaiting_packaging','2026-10-22')");
    await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity) VALUES(10,10,'same',1),(20,20,'same',1),(30,30,'same',1),(40,40,'same',1)");
    await query("INSERT INTO exception_task_states(task_id,status) VALUES('profit:30:订单利润为负','open')");
    await t.test('foreign archive rejects before remote API or audit write; all owned enterprise shops may archive',async()=>{
      const foreign=await query('SELECT * FROM online_products WHERE id=30');
      for(const tenant of [2,'admin'])await assert.rejects(archive.performOnlineProductActionMysql({online_product_id:30,action:'archive',tenant_id:3},tenant===2?2:1,tenant,opts(tenant===2?2:1)),{statusCode:404});
      assert.equal(remote.length,0);assert.equal((await query('SELECT COUNT(*) n FROM online_product_actions'))[0].n,0);
      for(const [tenant,id]of [[2,20],[3,30],['admin',10],['admin',40]]) {
        const actor=tenant==='admin'?1:tenant;
        const otherStates=await query('SELECT * FROM exception_task_states WHERE task_id NOT LIKE ? ORDER BY task_id',[`%:${id}:%`]);
        const result=await archive.performOnlineProductActionMysql({online_product_id:id,action:'archive'},actor,tenant,opts(actor));
        assert.equal(result.ok,true);assert.equal(Number((await query('SELECT archived FROM online_products WHERE id=?',[id]))[0].archived),1);
        assert.equal(result.handled_exception_count,5);
        assert.ok(Array.from(result.handled_exception_task_ids).every(taskId=>taskId.includes(`:${id}:`)));
        assert.deepEqual(await query('SELECT * FROM exception_task_states WHERE task_id NOT LIKE ? ORDER BY task_id',[`%:${id}:%`]),otherStates);
      }
      assert.deepEqual(remote.map(row=>row[1]),[2,3,1,4]);
      assert.deepEqual((await query('SELECT DISTINCT tenant_id FROM online_product_actions ORDER BY tenant_id')).map(row=>Number(row.tenant_id)),[1,2,3]);
      assert.equal(foreign[0].name,(await query('SELECT name FROM online_products WHERE id=30'))[0].name);
    });
    await t.test('zero-then-archive stops after remote completion if membership is revoked',async()=>{
      await query('UPDATE online_products SET archived=0,status=\'online\' WHERE id=20');
      const before=await query('SELECT * FROM online_products WHERE id IN(10,30,40) ORDER BY id');
      const beforeCalls=remote.length;
      afterRemote=()=>query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await assert.rejects(archive.performOnlineProductActionMysql({online_product_id:20,action:'zero_then_archive'},2,2,opts(2)),{statusCode:403});
      assert.deepEqual(remote.slice(beforeCalls).map(row=>row[0]),['stock']);
      assert.equal(Number((await query('SELECT archived FROM online_products WHERE id=20'))[0].archived),0);
      assert.deepEqual(await query('SELECT * FROM online_products WHERE id IN(10,30,40) ORDER BY id'),before);
      afterRemote=async()=>{};await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
    });
    await t.test('refreshed Ozon ID lookup cannot write after subscription revocation',async()=>{
      const beforeCalls=remote.length;
      afterRemote=()=>query("UPDATE tenants SET subscription_status='expired' WHERE id=2");
      await assert.rejects(archive.performOnlineProductActionMysql({online_product_id:21,action:'archive'},2,2,opts(2)),{statusCode:403});
      assert.deepEqual(remote.slice(beforeCalls).map(row=>row[0]),['resolve']);
      assert.equal((await query('SELECT ozon_product_id FROM online_products WHERE id=21'))[0].ozon_product_id,null);
    });
  } finally { globalThis.fetch=originalFetch;if(closeMysqlPool)await closeMysqlPool();await fixture.cleanup(); }
});

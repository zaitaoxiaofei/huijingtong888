import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('independent review rejects advertising alias references and revoked procurement task roles',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
  const fixture=await createTenantMysqlFixture('review');fixture.useEnvironment();
  const service=await import('../src/services/mysql-cutover.js');
  const ads=await import('../src/services/advertising-analytics.js');
  const {withAdvertisingTenantSession}=await import('../src/services/advertising-tenant-context.js');
  const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const {query}=fixture;
  const session={personId:2,roles:['admin'],tenant:{id:2,slug:'a',role:'member'}};
  try{
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES(1,'Default operator','admin'),(2,'A operator','operations'),(3,'B operator','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin')),(2,2,'member',JSON_ARRAY('operations')),(3,3,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A shop'),(30,3,'B shop')");
    await query("INSERT INTO products(id,tenant_id,name) VALUES(20,2,'A product'),(30,3,'B product')");
    await service.warmCoreInventoryRuntimeMysql('admin');
    await t.test('camelCase productId cannot bypass the whole-batch foreign-reference check',async()=>{
      let denied=false;
      try{await withAdvertisingTenantSession(session,()=>ads.upsertAdvertisingDailyRowsMysql({rows:[
        {shop_id:20,date_key:'2026-10-02',ozon_sku:'own',productId:20},
        {shop_id:20,date_key:'2026-10-02',ozon_sku:'foreign',productId:30}
      ]}));}catch(error){denied=error.statusCode===403||error.status===403;}
      const stored=await query("SELECT product_id FROM ozon_ad_sku_daily WHERE shop_id=20 AND ozon_sku='foreign'");
      assert.equal(denied,true,`Foreign productId import accepted: ${JSON.stringify(stored)}`);
      assert.equal((await query('SELECT COUNT(*) n FROM ozon_ad_sku_daily'))[0].n,0,'Entire mixed batch must be rejected before writing its first row');
      await withAdvertisingTenantSession(session,()=>ads.upsertAdvertisingDailyRowsMysql({rows:[{shop_id:20,date_key:'2026-10-02',ozon_sku:'own',productId:20}]}));
      assert.equal(Number((await query("SELECT product_id FROM ozon_ad_sku_daily WHERE ozon_sku='own'"))[0].product_id),20);
    });
    await t.test('stale HTTP roles cannot enqueue purchase confirmation or inbound writes after role revocation',async()=>{
      const request=await service.createProcurementRequestMysql({product_id:20,quantity:1,amount:10},2,2);
      const inbound=await service.createInboundRecordMysql({product_id:20,person_id:2,quantity:1,note:'original'},2);
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=2");
      const before=await query('SELECT status,note FROM inbound_records WHERE id=?',[inbound.id]);
      const outcomes=[];
      for(const run of [
        ()=>service.startConfirmProcurementRequestsPurchasedMysql({request_ids:[request.id]},3,3,session),
        ()=>service.startBatchUpdateInboundRecordsMysql({records:[{id:inbound.id,payload:{note:'revoked write'}}]},3,3,session)
      ])try{outcomes.push(await run());}catch(error){outcomes.push({statusCode:error.statusCode});}
      // Await an unexpectedly accepted task so a failing pre-fix run cannot
      // leave background writes or an open database behind.
      if(outcomes.some(result=>result.accepted))await new Promise(resolve=>setTimeout(resolve,300));
      assert.deepEqual(outcomes.map(result=>result.statusCode),[403,403],JSON.stringify(outcomes));
      assert.deepEqual(await query('SELECT status,note FROM inbound_records WHERE id=?',[inbound.id]),before);
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=2");
      const accepted=await service.startBatchUpdateInboundRecordsMysql({records:[{id:inbound.id,payload:{note:'authorized write'}}]},3,3,session);
      assert.equal(accepted.accepted,true);
      for(let i=0;i<100;i++){
        if((await query('SELECT note FROM inbound_records WHERE id=?',[inbound.id]))[0].note==='authorized write')break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal((await query('SELECT note FROM inbound_records WHERE id=?',[inbound.id]))[0].note,'authorized write');
      // Hold the actual target row while the authorized worker enters its
      // transaction, then revoke the role before its pending update can commit.
      await fixture.connection.beginTransaction();
      try {
        await query('SELECT id FROM inbound_records WHERE id=? FOR UPDATE',[inbound.id]);
        const queued=await service.startBatchUpdateInboundRecordsMysql({records:[{id:inbound.id,payload:{note:'must roll back'}}]},2,2,session);
        assert.equal(queued.accepted,true);
        let waiting=false;
        for(let i=0;i<100;i++){
          waiting=(await query("SELECT ID FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT owned.%FROM inbound_records%FOR UPDATE'",[fixture.database])).length>0;
          if(waiting)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true,'Worker must reach its target SELECT FOR UPDATE while our transaction holds the row');
        await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=2");
        await fixture.connection.commit();
      }catch(error){await fixture.connection.rollback();throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal((await query('SELECT note FROM inbound_records WHERE id=?',[inbound.id]))[0].note,'authorized write','Role revocation before commit rolls the pending transaction back');
    });
  }finally{await closeMysqlPool();await fixture.cleanup();}
});

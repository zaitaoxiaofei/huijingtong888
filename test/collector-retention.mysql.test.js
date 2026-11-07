import test from 'node:test';import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {cleanupCollectorHistory} from '../src/services/collector-history-retention.js';
test('collector cleanup previews, bounds work, retains fresh edits and tenant composite keys, and rechecks concurrent recollection',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const f=await createTenantMysqlFixture('collector_retention');const q=f.query;
 try{
 await q(`CREATE TABLE ozon_plugin_collected_products(tenant_id VARCHAR(80),sku VARCHAR(128),collect_date DATE,updated_at DATETIME,edited_at DATETIME,payload_json LONGTEXT,edit_payload_json LONGTEXT,PRIMARY KEY(tenant_id,sku))`);
 await q(`CREATE TABLE listing_collected_product_details(id VARCHAR(80),tenant_id VARCHAR(80),created_at DATETIME,updated_at DATETIME,payload_json LONGTEXT,PRIMARY KEY(id,tenant_id))`);
 for(const tenant of ['admin','2','3'])await q("INSERT INTO ozon_plugin_collected_products VALUES(?,'same','2026-08-01','2026-08-01',NULL,'{}','{}')",[tenant]);
 await q("INSERT INTO ozon_plugin_collected_products VALUES('2','recent','2026-10-01','2026-10-01',NULL,'{}',NULL),('2','edited','2026-08-01','2026-10-29','2026-10-29','{}',NULL),('2','boundary','2026-09-29','2026-08-01',NULL,'{}',NULL)");
 await q("INSERT INTO listing_collected_product_details VALUES('same','2','2026-08-01','2026-08-01','{}'),('same','3','2026-08-01','2026-10-29','{}')");
 const opts={now:new Date('2026-10-29T12:00:00Z'),batchSize:1,maxBatches:1},deps={query:q,execute:q};
 const preview=await cleanupCollectorHistory(opts,deps);assert.equal(preview.tables[0].eligible,3);assert.equal(preview.tables[1].eligible,1);assert.equal(preview.tables[0].deleted,0);
 const one=await cleanupCollectorHistory({...opts,apply:true},deps);assert.equal(one.tables[0].deleted,1);assert.equal(one.tables[1].deleted,1);
 await cleanupCollectorHistory({...opts,apply:true,maxBatches:5},deps);
 assert.deepEqual((await q('SELECT sku FROM ozon_plugin_collected_products ORDER BY sku')).map(r=>r.sku),['boundary','edited','recent']);
 assert.equal((await q('SELECT tenant_id FROM listing_collected_product_details'))[0].tenant_id,'3');
 await q("INSERT INTO ozon_plugin_collected_products VALUES('2','racing','2026-08-01','2026-08-01',NULL,'{}',NULL)");
 let raced=false;await cleanupCollectorHistory({...opts,apply:true},{query:q,execute:async(sql,args)=>{if(sql.includes('ozon_plugin')&&!raced){raced=true;await q("UPDATE ozon_plugin_collected_products SET collect_date='2026-10-29',updated_at='2026-10-29' WHERE sku='racing'")}return q(sql,args)}});
 assert.equal((await q("SELECT COUNT(*) n FROM ozon_plugin_collected_products WHERE sku='racing'"))[0].n,1);
 await assert.rejects(cleanupCollectorHistory({...opts,batchSize:0},deps),/bounds/);
 }finally{await f.cleanup()}
});

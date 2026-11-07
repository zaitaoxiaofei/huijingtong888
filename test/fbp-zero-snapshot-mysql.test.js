import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {resolveInventoryTenantScope,inventoryTenantSql} from '../src/services/inventory-tenant-scope.js';
const source=readFileSync(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
const functionSource=name=>source.match(new RegExp(`async function ${name}\\([^]*?\\n}`))[0];
test('bulk sync keeps explicitly verified FBP zero timestamps; real FBP rows replace only that SKU marker',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL'},async t=>{
 const f=await createTenantMysqlFixture('fbp_zero'),q=f.query;
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A','active'),(30,3,'B','active')");
  const seed=async()=>{
   await q('DELETE FROM ozon_stock_snapshots');
   await q("INSERT INTO ozon_stock_snapshots(shop_id,product_id,ozon_sku,ozon_product_id,offer_id,warehouse_id,stock_type,present,available,reserved,synced_at) VALUES(20,NULL,'101','201','one','flow-confirmed-zero','fbp_real',0,0,0,'2026-10-30 01:00:00'),(20,NULL,'101','201','one','fbs','fbs_virtual',50,50,0,'2026-10-30 01:00:00'),(20,NULL,'102','202','two','normal','fbp_real',5,4,1,'2026-10-30 01:00:00'),(30,NULL,'101','201','one','flow-confirmed-zero','fbp_real',0,0,0,'2026-10-30 01:00:00')");
  };
  const context=vm.createContext({mysqlExecute:q,mysqlQuery:q,mysqlQueryOne:async(sql,args)=>(await q(sql,args))[0],ensureOzonStockStorageSchemaMysql:async()=>{},resolveInventoryTenantScope:tenant=>resolveInventoryTenantScope(tenant,q),inventoryTenantSql,
   stockWarehouseRulesEnabledMysql:async()=>[],resolveStockTypeMysql:row=>row.stock_type,normalizedOzonSkuCandidateMysql:row=>row.ozon_sku,missingOnlineProductSkuMarker:()=>{throw Error('No SKU');},snapshotStockNumberMysql:value=>Number(value||0),normalizeMysqlNullableDate:value=>value||null,nullableNumber:value=>value==null?null:Number(value)});
  vm.runInContext(['clearStockSnapshotsForSyncMysql','upsertStockSnapshotMysql'].map(functionSource).join('\n'),context);
  await t.test('full, product-ID and offer filters preserve verified zeros and do not create invented zero rows',async()=>{
   for(const filters of [{},{filters:{productIds:[201]}},{filters:{offerIds:['one']}}]){
    await seed();await context.clearStockSnapshotsForSyncMysql(20,filters);const rows=await q('SELECT *,CAST(synced_at AS CHAR) AS sync_text FROM ozon_stock_snapshots ORDER BY shop_id,ozon_sku,warehouse_id');
    const zero=rows.find(r=>Number(r.shop_id)===20&&r.warehouse_id==='flow-confirmed-zero');assert.ok(zero);assert.equal(zero.sync_text,'2026-10-30 01:00:00');assert.ok(rows.some(r=>Number(r.shop_id)===30));assert.ok(!rows.some(r=>Number(r.shop_id)===20&&r.stock_type==='fbs_virtual'));assert.ok(rows.every(r=>['101','102'].includes(r.ozon_sku)));
   }
  });
  await t.test('FBS updates keep the separate FBP confirmation; an explicit FBP row supersedes it',async()=>{
   await seed();await context.upsertStockSnapshotMysql(20,{ozon_sku:'101',warehouse_id:'fbs',stock_type:'fbs_virtual',present:40,available:40});assert.equal(Number((await q("SELECT COUNT(*) n FROM ozon_stock_snapshots WHERE shop_id=20 AND warehouse_id='flow-confirmed-zero'"))[0].n),1);
   await context.upsertStockSnapshotMysql(20,{ozon_sku:'101',warehouse_id:'fbp-new',warehouse_name:'FBP',stock_type:'fbp_real',present:7,available:6,reserved:1});const rows=await q("SELECT * FROM ozon_stock_snapshots WHERE shop_id=20 AND stock_type='fbp_real' AND ozon_sku='101'");assert.equal(rows.length,1);assert.equal(rows[0].warehouse_id,'fbp-new');assert.equal(Number(rows[0].available),6);assert.equal(Number((await q("SELECT COUNT(*) n FROM ozon_stock_snapshots WHERE shop_id=30 AND warehouse_id='flow-confirmed-zero'"))[0].n),1);
  });
 }finally{await f.cleanup();}
});

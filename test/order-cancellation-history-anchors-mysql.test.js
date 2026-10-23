import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';
import { procurementLedgerSchema } from '../src/services/procurement-ledger.js';

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const methods = ['syncOutboundForOpenOrdersMysql','orderOutboundSyncScopeMysql','revokeShippedCancellationReturnsMysql',
  'postInventoryMysql','applyInventoryCurrentMysql','inventoryDeltasMysql','movementTypeFromSourceMysql',
  'rebuildInventoryCurrentForProductMysql','mysqlConnectionQuery','mysqlConnectionQueryOne','normalizeStockLocationMysql'];

test('cancellation inventory writes require fresh exact historical shop and posting anchors', {
  skip: !socketPath && 'Requires isolated TENANT_TEST_MYSQL_SOCKET'
}, async t => {
  const database = `ozon_cancel_anchor_${randomBytes(8).toString('hex')}`;
  const connection = await mysql.createConnection({ socketPath, user: 'root', dateStrings: true });
  let created = false;
  try {
    assert.equal(Number((await connection.query('SELECT @@skip_networking n'))[0][0].n), 1);
    await connection.query(`CREATE DATABASE \`${database}\``); created = true;
    await connection.changeUser({ database });
    await createOrderFixtureSchema(connection);
    for (const sql of procurementLedgerSchema) await connection.query(sql);
    // Some deployments have this extra audit timestamp; include it in the byte proof.
    await connection.query('ALTER TABLE inventory_movements ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    const { service } = loadTenantOrderService(connection, { extraMethods: methods,
      ensureStockLocationSchemaMysql: async () => {}, inventoryMovementTenantColumnExistsMysql: async () => true,
      resolveOrderStockLocationMysql: () => ({ stockLocation: 'LOCAL', stockLocationSource: 'fixture' }),
      invalidateOrderProcurementCoverage() {}
    });
    await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Default legacy'),(11,1,'Default'),(20,2,'A'),(21,2,'A second shop'),(30,3,'B')");
    await query("INSERT INTO people(id,name,role) VALUES(1,'Default packer','packing'),(2,'A packer','packing'),(3,'B packer','packing')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'member',JSON_ARRAY('packing')),(2,2,'member',JSON_ARRAY('packing')),(3,3,'member',JSON_ARRAY('packing'))");
    await query("INSERT INTO products(id,tenant_id,name,code,purchase_cost) VALUES(10,NULL,'Legacy','P10',5),(11,1,'Default','P11',5),(20,2,'A','P20',5),(30,3,'B','P30',5)");
    const fixtures = [{ item: 10, shop: 10, product: 10, tenant: 1, key: 'admin', slug: 'default' },
      { item: 11, shop: 11, product: 11, tenant: 1, key: '1', slug: 'default' },
      { item: 20, shop: 20, product: 20, tenant: 2, key: '2', slug: 'a' },
      { item: 30, shop: 30, product: 30, tenant: 3, key: '3', slug: 'b' }];
    for (const f of fixtures) {
      await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,person_id) VALUES(?,?,?,?,?,?)", [f.item,f.tenant,f.shop,f.product,'SKU-'+f.item,f.tenant]);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(?,?,'ORIGINAL','cancelled','cancelled','2026-10-01')", [f.item,f.shop]);
      await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES(?,?,?,?,99)", [f.item,f.item,f.item,'SKU-'+f.item]);
    }
    await query("INSERT INTO procurement_stock_cost_tasks(product_id,stocktake_action_id,quantity,person_id,reason) VALUES(20,1,2,2,'untouched cost evidence')");
    await query("INSERT INTO order_exceptions(store_id,posting_number,ozon_sku,exception_type,message) VALUES(20,'ORIGINAL','SKU-20','ANCHOR_REVIEW','untouched exception evidence')");
    async function reset(f = fixtures[2]) {
      await query('DELETE FROM inventory_movements'); await query('DELETE FROM outbound_records'); await query('DELETE FROM inventory_current');
      await query('DELETE FROM order_status_history');
      await query("UPDATE orders SET status='cancelled',tracking_stage='cancelled',logistics_status='created',cancelled_after_ship=0,delivered_at=NULL");
      await query("UPDATE orders SET shop_id=?,posting_number='ORIGINAL' WHERE id=?", [f.shop,f.item]);
      await query("INSERT INTO outbound_records(id,product_id,shop_id,order_ref,order_item_id,quantity,note) VALUES(100,?,?,'ORIGINAL',?,2,'original outbound')", [f.product,f.shop,f.item]);
      await query("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,related_posting_number,unit_cost,amount,note,stock_location) VALUES(100,?,?,?,'order_outbound','ORIGINAL',-2,'posted','ORDER_SHIPPED',?,'ORIGINAL',5,10,'original ledger','LOCAL')", [f.tenant,f.product,f.shop,f.item]);
      await query('INSERT INTO inventory_current(real_product_id,available_stock) VALUES(?,-2)', [f.product]);
    }
    async function addReturn({ item = 20, product = 20, tenant = 2, shop = 20, source = `cancel_${item}_${product}`, related = source, status = 'void' } = {}) {
      await query("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,related_posting_number,unit_cost,amount,note,stock_location) VALUES(101,?,?,?,'return_in',?,2,?,'RETURN_IN',?,?,5,10,'original automatic return','LOCAL')", [tenant,product,shop,source,status,item,related]);
    }
    // SQL serializes every column, including NULL/binary/timestamp, before hashing.
    async function nativeProof() {
      const tables = await query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME');
      const result = {};
      for (const { name } of tables) {
        const columns = await query('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name]);
        const parts = columns.map(({name:c}) => `IF(\`${c}\` IS NULL,'N;',CONCAT('V',OCTET_LENGTH(CAST(\`${c}\` AS BINARY)),':',HEX(CAST(\`${c}\` AS BINARY)),';'))`);
        const rows = await query(`SELECT SHA2(CONCAT(${parts.join(',')}),256) hash FROM \`${name}\` ORDER BY hash`);
        result[name] = { count: rows.length, sha256: createHash('sha256').update(rows.map(r => r.hash).join('\n')).digest('hex') };
      }
      return result;
    }
    const run = (f = fixtures[2]) => service.syncOutboundForOpenOrdersMysql({ tenantId: f.key, order_item_id: f.item,
      session: { personId: f.tenant, tenant: { id: f.tenant, slug: f.slug }, roles: ['packing'] } });
    async function blocked(change, { transported = false } = {}) {
      await reset(); if (transported) await query('UPDATE orders SET cancelled_after_ship=1 WHERE id=20');
      await change(); const before = await nativeProof();
      const result = await run();
      assert.deepEqual(Array.from(result.cancellation_review_required, row => [row.order_item_id,row.code]), [[20,'HISTORY_ORDER_LINK_REVIEW_REQUIRED']]);
      assert.deepEqual(await nativeProof(), before, 'every native column in every fixture table must remain unchanged');
      if (transported) {
        await assert.rejects(service.revokeShippedCancellationReturnsMysql(20,'2'), { code: 'HISTORY_ORDER_LINK_REVIEW_REQUIRED' });
        assert.deepEqual(await nativeProof(), before);
      }
    }
    for (const [label, shop, posting] of [['same shop / different posting',20,'OTHER'],['different shop / same posting',21,'ORIGINAL'],['different shop / different posting',21,'OTHER']]) {
      await t.test(`${label} outbound relationship drift preserves all native bytes`, () => blocked(() => query('UPDATE outbound_records SET shop_id=?,order_ref=? WHERE id=100',[shop,posting])));
    }
    await t.test('both nonempty negative ledger posting fields must match', () => blocked(() => query("UPDATE inventory_movements SET related_posting_number='OTHER' WHERE id=100")));
    await t.test('a conflicting negative source_ref cannot borrow the correct related posting', () => blocked(() => query("UPDATE inventory_movements SET source_ref='OTHER' WHERE id=100")));
    await t.test('cross enterprise poison under a reused item ID fails closed', () => blocked(() => query('UPDATE inventory_movements SET tenant_id=3,product_id=30,shop_id=30 WHERE id=100')));
    await t.test('void return independent posting conflict cannot be reposted', () => blocked(() => addReturn({ related: 'OTHER' })));
    await t.test('posted return independent shop conflict cannot be voided after transport', () => blocked(() => addReturn({ shop:21,status:'posted' }), { transported:true }));
    await t.test('a related automatic return with a different synthetic item key is rejected', () => blocked(() => addReturn({ source:'cancel_999_20' })));
    await t.test('a synthetic return without original historical proof is rejected', () => blocked(async () => { await query('DELETE FROM outbound_records');await query('DELETE FROM inventory_movements');await addReturn(); }));
    await t.test('current parent changes during the lock wait are checked after acquiring the lock', async () => {
      await reset(); const writer = await mysql.createConnection({ socketPath,user:'root',database,dateStrings:true });
      try {
        const original=await nativeProof();
        await writer.beginTransaction(); await writer.query('SELECT id FROM orders WHERE id=20 FOR UPDATE');
        const pending = run();
        // Observe the actual lock wait instead of relying only on a fixed sleep.
        let waiting = false;
        for (let i=0;i<50&&!waiting;i++) { waiting = Number((await writer.query('SELECT COUNT(*) n FROM performance_schema.data_lock_waits'))[0][0].n)>0;if(!waiting)await new Promise(r=>setTimeout(r,20)); }
        assert.equal(waiting,true);
        await writer.query("UPDATE orders SET posting_number='CHANGED-WHILE-WAITING' WHERE id=20"); await writer.commit();
        const result = await pending;assert.equal(result.cancellation_review_required[0].code,'HISTORY_ORDER_LINK_REVIEW_REQUIRED');
        const after=await nativeProof();assert.deepEqual({...after,orders:original.orders},original,'only the intentional parent posting change may differ');
        assert.equal((await query('SELECT note FROM inventory_movements WHERE id=100'))[0].note,'original ledger');
        assert.equal((await query('SELECT status FROM outbound_records WHERE id=100'))[0].status,'deducted');
        assert.equal(Number((await query('SELECT available_stock FROM inventory_current'))[0].available_stock),-2);
      } finally { await writer.rollback();await writer.end(); }
    });
    await t.test('membership revoked during a row-lock wait stops before every inventory write', async () => {
      await reset(); const writer = await mysql.createConnection({ socketPath,user:'root',database,dateStrings:true });
      try {
        const original=await nativeProof();
        await writer.beginTransaction();await writer.query('SELECT id FROM orders WHERE id=20 FOR UPDATE');
        const pending = run();
        let waiting = false;
        for (let i=0;i<50&&!waiting;i++) { waiting=Number((await writer.query('SELECT COUNT(*) n FROM performance_schema.data_lock_waits'))[0][0].n)>0;if(!waiting)await new Promise(r=>setTimeout(r,20)); }
        assert.equal(waiting,true);
        await writer.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');await writer.commit();
        await assert.rejects(pending,/不可用/);
        const before=await nativeProof();
        assert.deepEqual({...before,tenant_members:original.tenant_members},original,'only the intentional membership revocation may differ');
        assert.equal((await query('SELECT note FROM inventory_movements WHERE id=100'))[0].note,'original ledger');
        assert.equal((await query('SELECT COUNT(*) n FROM inventory_movements'))[0].n,1);
        assert.equal((await query('SELECT status FROM outbound_records WHERE id=100'))[0].status,'deducted');
        assert.equal(Number((await query('SELECT available_stock FROM inventory_current'))[0].available_stock),-2);
        await assert.rejects(run(),/不可用/);assert.deepEqual(await nativeProof(),before);
      } finally { await writer.rollback();await writer.end();await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2'); }
    });
    for (const f of fixtures) await t.test(`${f.key}/${f.shop} normal cancellation returns deducted units once with ordinary packing permission`, async () => {
      await reset(f); const result = await run(f);assert.equal(result.cancellation_review_required.length,0);await run(f);
      const returns = await query("SELECT * FROM inventory_movements WHERE source_type='return_in'");assert.equal(returns.length,1);assert.equal(Number(returns[0].quantity_delta),2);assert.equal(returns[0].related_posting_number,'ORIGINAL');
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current'))[0].available_stock),0);
      assert.equal((await query('SELECT status FROM outbound_records'))[0].status,'cancelled');
    });
    await t.test('legacy synthetic related posting remains valid with a proven original anchor', async () => {
      await reset();await addReturn();await run();assert.equal((await query('SELECT status FROM inventory_movements WHERE id=101'))[0].status,'posted');
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current'))[0].available_stock),0);
    });
    await t.test('transport voids only the matching automatic return, preserves original outbound/manual receipt, and repeats safely', async () => {
      await reset();await addReturn({ status:'posted' });await query('UPDATE orders SET cancelled_after_ship=1 WHERE id=20');
      await query("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,note) VALUES(102,2,20,20,'return_in','manual_receipt_20',3,'posted','RETURN_IN',20,'manual receipt')");
      const original = await query('SELECT * FROM inventory_movements WHERE id IN(100,102) ORDER BY id');
      assert.equal(await service.revokeShippedCancellationReturnsMysql(20,'2'),1);assert.equal(await service.revokeShippedCancellationReturnsMysql(20,'2'),0);
      assert.deepEqual(await query('SELECT * FROM inventory_movements WHERE id IN(100,102) ORDER BY id'),original);
      assert.equal((await query('SELECT status FROM inventory_movements WHERE id=101'))[0].status,'void');assert.equal(Number((await query('SELECT available_stock FROM inventory_current'))[0].available_stock),1);
    });
    await t.test('synthetic source matching never mistakes item 20 for 200 or arbitrary suffix tags', async () => {
      await reset();await addReturn({ item:200, source:'cancel_200_20',shop:30,tenant:3,product:30 });
      const untouched = await query('SELECT * FROM inventory_movements WHERE id=101');
      const result = await run();assert.equal(result.cancellation_review_required.length,0);assert.deepEqual(await query('SELECT * FROM inventory_movements WHERE id=101'),untouched);
      await reset();await addReturn({ source:'cancel_20_bad_tag' });const before=await nativeProof();const rejected=await run();assert.equal(rejected.cancellation_review_required.length,1);assert.deepEqual(await nativeProof(),before);
    });
    await t.test('indexed locking reads do not wait for an unrelated enterprise ledger/outbound lock', async () => {
      await reset();
      for (let offset=0;offset<4000;offset+=200) {
        const ids=Array.from({length:200},(_,i)=>1000+offset+i);
        await query("INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,related_order_item_id) VALUES ?",[ids.map(id=>[id,3,30,30,'return_in',`cancel_${id}_30`,1,'posted',id])]);
        await query('INSERT INTO outbound_records(id,product_id,shop_id,order_ref,order_item_id,quantity) VALUES ?',[ids.map(id=>[id,30,30,`FOREIGN-${id}`,id,1])]);
      }
      await query('ANALYZE TABLE inventory_movements,outbound_records');
      const writer=await mysql.createConnection({socketPath,user:'root',database,dateStrings:true});
      const plans=[];
      const traced={ query:async(sql,params)=>{
        if(sql.includes('FROM inventory_movements anchor')||sql.includes('FROM outbound_records')) {
          const explain=await query('EXPLAIN '+sql,params);
          const main=explain.find(row=>row.table==='anchor'||row.table==='outbound_records');
          assert.ok(main&&main.key&&main.type!=='ALL'&&Number(main.rows)<=10,JSON.stringify(explain));
          plans.push({type:main.type,key:main.key,rows:Number(main.rows)});
        }
        return connection.query(sql,params);
      }};
      try {
        await writer.beginTransaction();await writer.query('SELECT id FROM inventory_movements WHERE id=4000 FOR UPDATE');await writer.query('SELECT id FROM outbound_records WHERE id=4000 FOR UPDATE');
        await query('SET SESSION innodb_lock_wait_timeout=1');await connection.beginTransaction();
        const scope=await service.orderOwnershipTenantScopeMysql('2');
        const current=await service.assertCancellationInventoryAnchorsMysql(traced,20,scope);assert.equal(current.order_item_id,20);
        assert.equal(plans.length,5);assert.ok(plans.some(row=>row.type==='range'&&row.key==='idx_inventory_source_ref'));
        await connection.rollback();
      } finally {await connection.rollback();await writer.rollback();await writer.end();await query('SET SESSION innodb_lock_wait_timeout=50');}
    });
  } finally {
    if (created) { await connection.changeUser({database:'mysql'});await connection.query(`DROP DATABASE \`${database}\``); }
    await connection.end();
  }
});

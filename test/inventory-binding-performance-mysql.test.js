import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createCatalogRoutes } from '../src/server/routes/catalog.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const legacyHistoryJoin = `LEFT JOIN (
      SELECT h.*
      FROM order_status_history h
      JOIN (
        SELECT order_id, MAX(observed_at) AS observed_at
        FROM order_status_history
        GROUP BY order_id
      ) latest ON latest.order_id = h.order_id AND latest.observed_at = h.observed_at
    ) osh ON osh.order_id = o.id`;
const scopedHistoryJoin = /LEFT JOIN order_status_history osh ON osh\.order_id = o\.id\s+AND osh\.observed_at = \(\s+SELECT MAX\(latest_history\.observed_at\)\s+FROM order_status_history latest_history\s+WHERE latest_history\.order_id = o\.id\s+\)/g;
const shape = sql => String(sql).replace(/\s+/g, ' ').trim();

test('inventory create and binding preserve historical inventory while limiting history reads to candidate orders', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires an explicit isolated no-TCP MySQL socket', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('binding_perf');
  let closeMysqlPool;
  const profile = { baseline: false, active: null };
  const report = { fixture: { unrelated_history_rows: 50000 }, checks: {}, sql: [], requests: [] };
  const originalSetTimeout = globalThis.setTimeout;
  // Profit work already runs outside confirmation; keep its scheduled callback
  // outside these isolated inventory proofs rather than racing fixture resets.
  const deferredProfit = [];
  globalThis.setTimeout = function (callback, delay, ...args) {
    if (delay === 0 && new Error().stack.includes('scheduleBindingProfitRecalculationMysql')) {
      deferredProfit.push(callback);
      return { unref() {} };
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    fixture.useEnvironment();
    const { query, connection } = fixture;
    const runtime = await import('../src/services/mysql-cutover.js');
    const poolRuntime = await import('../src/mysql-pool.js');
    closeMysqlPool = poolRuntime.closeMysqlPool;
    const pool = poolRuntime.getMysqlPool();
    pool.pool.on('connection', raw => {
      for (const method of ['query', 'execute']) {
        const original = raw[method];
        raw[method] = function (...args) {
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
          if (profile.baseline && typeof sql === 'string') {
            const replacement = sql.replace(scopedHistoryJoin, legacyHistoryJoin);
            args[0] = typeof args[0] === 'string' ? replacement : { ...args[0], sql: replacement };
          }
          const actualSql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
          const recording = profile.active;
          const started = performance.now();
          const last = args.length - 1;
          if (recording && typeof args[last] === 'function') {
            const callback = args[last];
            args[last] = function (...values) {
              recording.push({ sql: actualSql, params: Array.isArray(args[1]) ? [...args[1]] : [], ms: performance.now() - started });
              callback.apply(this, values);
            };
          }
          return original.apply(this, args);
        };
      }
    });
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role,username) VALUES(1,'Default actor','admin','default'),(2,'A actor','admin','a'),(3,'B actor','admin','b')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Default legacy'),(20,2,'A'),(30,3,'B')");
    await runtime.warmCoreInventoryRuntimeMysql('2');
    await runtime.prepareInventoryProductCreationMysql();
    await (await import('../src/services/inventory-product-naming.js')).ensureInventoryProductNamingSchema();
    const requestRuntime=await import('../src/services/inventory-product-requests.js');
    const routes=createCatalogRoutes({services:{...runtime,bindOnlineProduct:runtime.bindOnlineProductMysql,createProductFromOnlineProduct:runtime.createProductFromOnlineProductMysql,submitInventoryProductRequest:requestRuntime.submitInventoryProductRequest},readJson:async req=>req.body});
    await query("INSERT INTO inventory_product_naming_options(tenant_id,option_type,value,label,status) VALUES(2,'category','Fixture','Fixture','active'),(2,'accessory','Style','Style','active')");
    await query('ALTER TABLE order_status_history MODIFY observed_at DATETIME NULL');
    await query('CREATE TABLE fixture_digits(n INT PRIMARY KEY)');
    await query('INSERT INTO fixture_digits VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)');
    await query(`INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour)
      SELECT 100000+FLOOR(n/5),30,CONCAT('UNRELATED-',n),'awaiting_packaging',
        TIMESTAMPADD(HOUR,n,'2020-01-01'),TIMESTAMPADD(HOUR,n,'2020-01-01')
      FROM (SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n n FROM fixture_digits a
        CROSS JOIN fixture_digits b CROSS JOIN fixture_digits c CROSS JOIN fixture_digits d CROSS JOIN fixture_digits e) numbers
      WHERE n<50000`);
    await query('ANALYZE TABLE order_status_history');
    const session = { personId: 2, tenant: { id: 2, slug: 'a', role: 'admin' }, roles: ['admin'] };
    async function reset({ create = false } = {}) {
      for (const table of ['order_exceptions','inventory_movements','inventory_current','outbound_records','order_items','orders','online_products','sku_mappings','product_components','sku_inventory_recipe_items','sku_inventory_recipes','products']) await query(`DELETE FROM ${table}`);
      await query('DELETE FROM order_status_history WHERE order_id<100000');
      await query("INSERT INTO products(id,tenant_id,name,code,purchase_cost,owner_person_id,created_by_person_id,stock_unit) VALUES(200,2,'A inventory','P200',5,2,2,'unit'),(300,3,'Foreign untouched','P300',7,3,3,'unit')");
      await query("INSERT INTO online_products(id,shop_id,ozon_sku,offer_id,name,sale_price) VALUES(200,20,'PERF-SKU','PERF-OFFER','Fixture item',100),(300,30,'PERF-SKU','FOREIGN','Foreign online',100)");
      await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,online_product_id,ozon_sku,person_id) VALUES(200,2,20,0,200,'PERF-SKU',2),(300,3,30,300,300,'PERF-SKU',3)");
      await query(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES
        (200,20,'OPEN','awaiting_packaging','','2026-11-01'),(201,20,'HISTORY','delivered','delivered','2026-10-01'),
        (202,20,'CANCEL','cancelled','cancelled','2026-10-01'),(203,20,'TRANSPORT','delivering','delivering','2026-10-01'),
        (204,20,'NO-HISTORY','awaiting_packaging','','2026-11-01'),(205,20,'NULL-HISTORY','awaiting_packaging','','2026-11-01'),
        (300,30,'FOREIGN','awaiting_packaging','','2026-11-01')`);
      await query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES(200,200,200,?,3),(201,201,200,?,2),(202,202,200,?,2),(203,203,200,?,4),(204,204,200,?,1),(205,205,200,?,1),(300,300,300,?,8)',Array(7).fill('PERF-SKU'));
      await query(`INSERT INTO order_status_history(order_id,shop_id,posting_number,status,warehouse_name,observed_at,observed_hour) VALUES
        (200,20,'OPEN','old','Old warehouse','2026-11-01','2026-11-01'),
        (200,20,'OPEN','latest-a','Latest warehouse A','2026-11-02','2026-11-02'),
        (200,20,'OPEN','latest-b','Latest warehouse B','2026-11-02','2026-11-02'),
        (202,20,'CANCEL','cancelled','Cancellation warehouse','2026-11-02','2026-11-02'),
        (205,20,'NULL-HISTORY','null-time','Must not win',NULL,'2026-11-02')`);
      if (create) {
        await query('DELETE FROM products WHERE id=200');
        await query('ALTER TABLE products AUTO_INCREMENT=400');
      } else {
        await query("INSERT INTO outbound_records(id,product_id,shop_id,order_ref,order_item_id,quantity,note) VALUES(100,200,20,'CANCEL',202,2,'original cancellation'),(101,200,20,'TRANSPORT',203,4,'original shipped')");
        await query(`INSERT INTO inventory_movements(id,tenant_id,product_id,shop_id,sku_mapping_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,related_posting_number,unit_cost,amount,note,stock_location)
          VALUES(100,2,200,20,200,'order_outbound','CANCEL',-2,'posted','ORDER_SHIPPED',202,'CANCEL',5,10,'original cancellation','LOCAL'),
          (101,2,200,20,200,'order_outbound','TRANSPORT',-4,'posted','ORDER_SHIPPED',203,'TRANSPORT',5,20,'original shipped','LOCAL')`);
        await query('INSERT INTO inventory_current(real_product_id,available_stock) VALUES(200,-6)');
      }
    }
    async function proof() {
      const result = {};
      const fields = {
        inventory_movements: 'tenant_id,product_id,shop_id,sku_mapping_id,owner_person_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,related_posting_number,unit_cost,amount,note,stock_location,stock_location_source',
        inventory_current: 'real_product_id,available_stock,reserved_stock,damaged_stock,in_transit_stock',
        outbound_records: 'product_id,shop_id,online_product_id,order_ref,order_item_id,ozon_sku,person_id,quantity,stock_location,stock_location_source,reason,status,note',
        order_items: 'id,order_id,sku_mapping_id,ozon_sku,quantity',
        online_products: 'id,shop_id,product_id,ozon_sku',
        sku_mappings: 'id,tenant_id,shop_id,product_id,person_id,ozon_sku'
      };
      for (const [table, columns] of Object.entries(fields)) result[table] = (await query(`SELECT ${columns} FROM ${table}`)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return result;
    }
    async function measure(name, baseline, action) {
      profile.baseline = baseline;
      const calls = [];
      profile.active = calls;
      const started = performance.now();
      const result = await action();
      const ms = performance.now() - started;
      profile.active = null;
      const shapes=new Map();
      for(const call of calls){const sql=shape(call.sql),entry=shapes.get(sql)||{sql,count:0,total_ms:0};entry.count++;entry.total_ms+=call.ms;shapes.set(sql,entry);}
      report.requests.push({ name, baseline, ms, query_count: calls.length,
        shapes:[...shapes.values()].sort((a,b)=>b.count-a.count),
        slowest: [...calls].sort((a,b)=>b.ms-a.ms).slice(0,5).map(row=>({ms:row.ms,sql:shape(row.sql)})) });
      return { result, calls };
    }
    let candidateCalls;
    await t.test('binding preserves historical outbound, cancellation restoration, transported evidence and enterprise ownership', async () => {
      const snapshots = [];
      for (const baseline of [true,false,true,false]) {
        await reset();
        const measured = await measure('bind',baseline,()=>routes['POST /api/online-products/bind']({_session:session,body:{online_product_id:200,order_item_id:200,ozon_sku:'PERF-SKU',product_id:200,person_id:2,inventory_recipe:{mode:'single',items:[]}}}));
        assert.equal(measured.result.ok,true);
        candidateCalls = measured.calls.filter(call=>call.sql?.includes('FROM order_items oi') && call.sql.includes('AS warehouse_name'));
        assert.equal(candidateCalls.length,2);
        snapshots.push(await proof());
        assert.equal((await query("SELECT note FROM inventory_movements WHERE related_order_item_id=203"))[0].note,'original shipped');
        assert.equal(Number((await query("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='return_in' AND related_order_item_id=202"))[0].n),1);
        assert.equal(Number((await query('SELECT product_id FROM online_products WHERE id=300'))[0].product_id || 0),0);
      }
      for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshot,snapshots[0]);
      const unchanged=await proof();
      await assert.rejects(routes['POST /api/online-products/bind']({_session:session,body:{online_product_id:300,product_id:200,person_id:2}}),{statusCode:404});
      assert.deepEqual(await proof(),unchanged,'a foreign online product cannot enter either sync query');
      report.checks.binding=true;
    });
    await t.test('same-time latest rows, absent history and NULL observed times are equivalent with bounded reads', async () => {
      profile.baseline = false;
      for (const call of candidateCalls) {
        const scopedSql = call.sql;
        const oldSql = scopedSql.replace(scopedHistoryJoin,legacyHistoryJoin);
        assert.notEqual(oldSql,scopedSql);
        const [before] = await connection.query(oldSql,call.params);
        const [after] = await connection.query(scopedSql,call.params);
        const sorted = rows=>rows.map(row=>JSON.stringify(row)).sort();
        assert.deepEqual(sorted(after),sorted(before));
        if (scopedSql.includes('NOT LIKE')) {
          assert.equal(after.filter(row=>Number(row.id)===200).length,2,'maximum observed_at ties remain separate rows');
          assert.equal(after.find(row=>Number(row.id)===205).warehouse_name,null);
          assert.equal(after.find(row=>Number(row.id)===204).warehouse_name,null);
        }
        const measurements=[];
        for (const [label,sql] of [['legacy',oldSql],['scoped',scopedSql]]) {
          const status=async()=>Object.fromEntries((await connection.query("SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_next','Handler_read_rnd_next','Handler_read_key','Handler_read_prev')"))[0].map(row=>[row.Variable_name,Number(row.Value)]));
          const start=await status(), began=performance.now();
          await connection.query(sql,call.params);
          const ms=performance.now()-began, end=await status();
          const reads=Object.fromEntries(Object.entries(end).map(([key,value])=>[key,value-start[key]]));
          const [plan]=await connection.query('EXPLAIN ANALYZE '+sql,call.params);
          measurements.push({label,ms,reads,plan:Object.values(plan[0])[0]});
        }
        const reads=row=>Object.values(row.reads).reduce((total,count)=>total+count,0);
        report.sql.push({query:scopedSql.includes('NOT LIKE')?'non_cancelled':'cancelled',rows:after.length,measurements});
        assert.ok(reads(measurements[0])>10000,'legacy candidate query groups unrelated history');
        assert.ok(reads(measurements[1])<1000,'scoped candidate query stays bounded');
        assert.match(measurements[1].plan,/idx_order_status_history_order_time/);
      }
      report.checks.history=true;
    });
    await t.test('create from unbound online inventory retains the same SKU and historical ledgers', async () => {
      const snapshots=[];
      for (const baseline of [true,false,true,false]) {
        await reset({create:true});
        const measured=await measure('create_from_online',baseline,()=>routes['POST /api/online-products/create-product']({_session:session,body:{online_product_id:200,order_item_id:200,ozon_sku:'PERF-SKU',owner_person_id:2,created_by_person_id:2,purchase_cost:5,exchange_rate:11.32,structured_naming:{category:'Fixture',accessory:'Style',quantity:1,stock_unit:'unit'}}}));
        assert.equal(Number(measured.result.id),400);
        assert.equal(Number((await query('SELECT product_id FROM online_products WHERE id=200'))[0].product_id),400);
        assert.equal(Number((await query('SELECT sku_mapping_id FROM order_items WHERE id=200'))[0].sku_mapping_id),200);
        snapshots.push(await proof());
      }
      for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshot,snapshots[0]);
      report.checks.create_from_online=true;
    });
    await t.test('standalone creation is profiled separately from binding and keeps structured naming and BOM fields', async () => {
      await reset();
      const made=await measure('create_product_only',false,()=>runtime.createProductMysql({owner_person_id:2,created_by_person_id:2,purchase_cost:5,exchange_rate:11.32,stock_unit:'unit',structured_naming:{category:'Fixture',accessory:'Style',quantity:1,stock_unit:'unit'},composition_items:[{component_product_id:200,quantity:2,component_role:'included'}]},null,'2'));
      assert.ok(Number(made.result.id)>300);
      assert.ok(made.calls.every(call=>!call.sql?.includes('FROM order_status_history')));
      assert.equal(Number((await query('SELECT quantity FROM product_components WHERE product_id=?',[made.result.id]))[0].quantity),2);
      report.checks.create_product=true;
    });
    assert.equal(deferredProfit.length,8);
    report.pass=Object.keys(report.checks).length===4;
  } finally {
    globalThis.setTimeout=originalSetTimeout;
    profile.active=null;
    const verification=new URL('../.verification/',import.meta.url);
    await mkdir(verification,{recursive:true});
    await writeFile(new URL('inventory-binding-performance.json',verification),JSON.stringify(report,null,2)+'\n','utf8');
    if(closeMysqlPool)await closeMysqlPool();
    await fixture.cleanup();
  }
});

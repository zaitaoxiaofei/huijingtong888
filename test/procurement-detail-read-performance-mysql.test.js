import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const plain = value => JSON.parse(JSON.stringify(value));
const baselineCommit = '4650f54b';
const functionNames = ['procurementRequestsMysql', 'procurementGroupedPageIdsMysql', 'workflowFbpCandidateMysql',
  'inventoryScopeCoverageMysql', 'chinaDateSqlMysql', 'localStockLocationPredicateMysql', 'fbpTransferInTransitWhereMysql'];

// Extract the complete checked-in functions, rather than reproducing either SQL
// implementation in the oracle. Only startup DDL is skipped after real startup.
function loadReader(source, connection, dependencies) {
  const calls = [];
  const query = async (sql, params = []) => {
    const rows = (await connection.query(sql, params))[0];
    if (sql.includes('AS historical_purchase_inbound_quantity')) calls.push({ sql, params: [...params], rows: plain(rows) });
    return rows;
  };
  const noop = async () => {};
  const context = vm.createContext({ Date, Map, Set, Number, String, Object, Array, Math, console, ...dependencies,
    mysqlQuery: query,
    resolveInventoryTenantScope: tenant => dependencies.resolveInventoryTenantScope(tenant, query),
    createInventoryWorkflowService: () => dependencies.createInventoryWorkflowService({ query }),
    ensureMysqlCutoverEnabled() {}, requireProcurementTenantSchemaMysql: noop,
    ensureProcurementRequestTimestampSchemaMysql: noop, ensureProcurementFlexibleRequestSchemaMysql: noop,
    ensureStockLocationSchemaMysql: noop, ensureFbpTransferRecordsSchemaMysql: noop
  });
  for (const name of functionNames) {
    const match = source.match(new RegExp('^(?:export )?(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, `Missing complete source function: ${name}`);
    vm.runInContext(match[0].replace(/^export /, ''), context);
  }
  return { calls, async read(query, tenant = 2) {
    calls.length = 0;
    const result = await context.procurementRequestsMysql(query, tenant);
    return { result: plain(result), detail: calls.at(-1) };
  } };
}

async function seed(f, api) {
  const q = f.query;
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Default operator','admin'),(2,'A operator','admin'),(3,'B operator','admin')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
  await api.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({ grouped: '1', compact: '1' }, 2);
  // Exercise possible legacy nullable timestamps without changing application DDL.
  await q('ALTER TABLE orders MODIFY ordered_at DATETIME NULL');
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(10,1,'Default','active'),(11,NULL,'Legacy','active'),(20,2,'A','active'),(30,3,'B','active')");
  await q("INSERT INTO suppliers(id,tenant_id,name) VALUES(20,2,'A supplier'),(30,3,'B supplier')");
  await q(`INSERT INTO products(id,tenant_id,name,code,inventory_number,product_type,active,supplier_id,inventory_category,vehicle_brand,vehicle_model,accessory_name,color,material,source_platform,created_at) VALUES
    (100,1,'Default bundle','P-100','1-1-100','main',1,NULL,'part','BMW','X1','trim','black','ABS','1688','2026-10-01'),
    (101,NULL,'Legacy bundle','P-101','1-1-101','main',1,NULL,'part','','','','','','1688','2026-10-01'),
    (110,1,'Default component','P-110',NULL,'main',1,NULL,'part','','','','','','1688','2026-10-01'),
    (111,NULL,'Legacy component','P-111',NULL,'main',1,NULL,'part','','','','','','1688','2026-10-01'),
    (200,2,'Alpha bundle','P-200','2-1-200','main',1,20,'part','BMW','X1/X3','trim','black/red','ABS/steel','1688','2026-10-01'),
    (201,2,'Beta shared','P-201','2-1-201','main',1,20,'part','BMW','X1','trim','black','ABS','pdd','2026-10-01'),
    (202,2,'Gamma shared','P-202','2-1-202','main',1,20,'part','','','','','','1688','2026-10-01'),
    (203,2,'Negative bundle','P-203','2-1-203','main',1,20,'part','','','','','','1688','2026-10-01'),
    (204,2,'Zero bundle','P-204','2-1-204','main',1,20,'part','','','','','','1688','2026-10-01'),
    (205,2,'Live shortage only','P-205','2-1-205','main',1,20,'part','','','','','','1688','2026-10-01'),
    (206,2,'Cancelled purchase','P-206','2-1-206','main',1,20,'part','','','','','','1688','2026-10-01'),
    (210,2,'Shared component','P-210',NULL,'main',1,20,'part','','','','','','1688','2026-10-01'),
    (211,2,'Negative component','P-211',NULL,'main',1,20,'part','','','','','','1688','2026-10-01'),
    (212,2,'Inactive component','P-212',NULL,'main',0,20,'part','','','','','','1688','2026-10-01'),
    (214,2,'Zero component','P-214',NULL,'main',1,20,'part','','','','','','1688','2026-10-01'),
    (300,3,'Foreign bundle','P-300','3-1-300','main',1,30,'part','','','','','','1688','2026-10-01'),
    (310,3,'Foreign component','P-310',NULL,'main',1,30,'part','','','','','','1688','2026-10-01')`);
  await q(`INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES
    (1,100,110,2),(NULL,101,111,2),(2,200,210,2),(2,200,211,1),(2,200,212,1),(2,200,310,1),
    (3,200,214,1),(2,201,210,1),(2,202,210,2),(2,203,211,2),(2,204,214,1),(3,300,310,1)`);
  await q(`INSERT INTO procurement_requests(id,tenant_id,product_id,person_id,supplier_id,quantity,status,demand_type,source_type,request_reason_code,created_at,updated_at) VALUES
    (100,1,100,1,NULL,2,'pending','advance_stock','1688','flow_local_safety','2026-11-01','2026-11-01'),
    (101,NULL,101,1,NULL,2,'pending','advance_stock','1688','flow_local_safety','2026-11-02','2026-11-02'),
    (200,2,200,2,20,4,'pending','advance_stock','1688','flow_local_safety','2026-11-01','2026-11-01'),
    (201,2,201,2,20,3,'submitted','real_order','pdd','flow_real_order','2026-11-02','2026-11-02'),
    (202,2,202,2,20,3,'pending','advance_stock','1688','flow_local_safety','2026-11-03','2026-11-03'),
    (203,2,203,2,20,3,'pending','advance_stock','1688','flow_local_safety','2026-11-04','2026-11-04'),
    (204,2,204,2,20,3,'pending','advance_stock','1688','flow_local_safety','2026-11-05','2026-11-05'),
    (206,2,206,2,20,3,'cancelled','advance_stock','1688','flow_local_safety','2026-11-06','2026-11-06'),
    (300,3,300,3,30,6,'pending','advance_stock','1688','flow_local_safety','2026-11-07','2026-11-07'),
    (301,3,200,3,30,999,'pending','advance_stock','1688','flow_local_safety','2026-11-08','2026-11-08')`);
  await q(`INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES
    (1,110,'initial_stock',8,'posted','LOCAL'),(NULL,111,'initial_stock',10,'posted',''),
    (2,210,'initial_stock',11,'posted','LOCAL'),(2,211,'initial_stock',-3,'posted','UNKNOWN'),
    (2,214,'initial_stock',0,'posted','LOCAL'),(2,210,'initial_stock',999,'cancelled','LOCAL'),
    (2,210,'initial_stock',999,'posted','FBP'),(3,210,'initial_stock',999,'posted','LOCAL'),
    (2,212,'initial_stock',999,'posted','LOCAL'),(3,310,'initial_stock',999,'posted','LOCAL')`);
  await q(`INSERT INTO inbound_records(tenant_id,product_id,quantity,status) VALUES
    (1,110,4,'pending_arrival'),(NULL,111,6,'pending_arrival'),(2,210,5,'pending_arrival'),
    (2,211,7,'pending_arrival'),(2,214,0,'pending_arrival'),(2,210,999,'cancelled'),
    (2,210,999,'approved'),(3,210,999,'pending_arrival'),(3,310,999,'pending_arrival')`);
  await q(`INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES
    (100,1,10,100,'DEFAULT',1),(101,NULL,11,101,'LEGACY',1),(200,2,20,200,'MAIN',1),
    (201,2,20,200,'ALIAS',1),(202,2,20,202,'OTHER',1),(205,2,20,205,'LIVE',1),
    (206,2,20,200,'INACTIVE',0),(300,3,30,300,'FOREIGN',1),(301,3,20,200,'POISON',1)`);
  // All boundaries are relative to CURRENT_DATE (the existing SQL's UTC-session
  // date), not an assumed Beijing server timezone. Future rows remain included.
  const offsets = [-30, -29, -21, -20, -15, -14, -13, -7, -6, 0, 1];
  for (let i = 0; i < offsets.length; i++) {
    const id = 1000 + i;
    await q(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at)
      VALUES(?,20,?,'delivered','delivered',DATE_SUB(DATE_ADD(CURRENT_DATE, INTERVAL ? DAY),INTERVAL 8 HOUR))`, [id, `WINDOW-${i}`, offsets[i]]);
    await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES(?,?,200,'MAIN',?)", [id, id, i + 1]);
  }
  await q(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES
    (1100,20,'JUST-BEFORE','delivered','delivered',DATE_SUB(DATE_SUB(CURRENT_DATE,INTERVAL 29 DAY),INTERVAL 8 HOUR)+INTERVAL -1 SECOND),
    (1101,20,'NULL-DATE','delivered','delivered',NULL),(1102,20,'CANCELLED','cancelled','pending_stock',CURRENT_TIMESTAMP),
    (1103,20,'CANCEL-STAGE','delivered','cancelled',CURRENT_TIMESTAMP),(1104,20,'DOUBLE-OR','delivered','delivered',CURRENT_TIMESTAMP),
    (1105,20,'SPLIT-OR','delivered','delivered',CURRENT_TIMESTAMP),(1106,20,'INACTIVE','delivered','delivered',CURRENT_TIMESTAMP),
    (1107,30,'FOREIGN-SHOP','delivered','delivered',CURRENT_TIMESTAMP),(1108,20,'FOREIGN-MAPPING','delivered','delivered',CURRENT_TIMESTAMP),
    (1200,20,'LIVE-ORDER','awaiting_packaging','pending_stock',CURRENT_TIMESTAMP),
    (1300,10,'DEFAULT-ORDER','delivered','delivered',CURRENT_TIMESTAMP),(1301,11,'LEGACY-ORDER','delivered','delivered',CURRENT_TIMESTAMP)`);
  await q(`INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES
    (1100,1100,200,'MAIN',40),(1101,1101,200,'MAIN',50),(1102,1102,200,'MAIN',60),(1103,1103,200,'MAIN',70),
    (1104,1104,201,'MAIN',3),(1105,1105,202,'MAIN',5),(1106,1106,206,'INACTIVE',80),
    (1107,1107,300,'FOREIGN',90),(1108,1108,301,'POISON',100),(1200,1200,205,'LIVE',4),
    (1300,1300,100,'DEFAULT',6),(1301,1301,101,'LEGACY',7)`);
  await q(`INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES
    (200,2,'OLD-PURCHASE','inbound_done','2020-01-01'),(201,2,'CANCEL-PURCHASE','cancelled','2020-01-01'),(300,3,'FOREIGN-PURCHASE','purchased','2020-01-01')`);
  await q(`INSERT INTO purchase_order_items(tenant_id,purchase_order_id,product_id,requested_quantity,actual_quantity,amount) VALUES
    (2,200,200,10,10,100),(2,201,200,999,999,999),(3,300,200,999,999,999)`);
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location,related_order_item_id,created_at) VALUES(2,200,'purchase_inbound',12,'posted','LOCAL',NULL,'2020-01-01'),(2,200,'order_outbound',-2,'posted','LOCAL',1000,'2020-01-01'),(2,200,'return_in',1,'posted','LOCAL',NULL,'2020-01-01'),(2,200,'fbp_transfer_outbound',-1,'posted','LOCAL',NULL,'2020-01-01'),(2,200,'manual_outbound',-1,'posted','LOCAL',NULL,'2020-01-01')");
}

test('grouped procurement detail optimizations preserve actual baseline results and reduce unrelated reads', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires disposable socket-only MySQL', timeout: 240000
}, async t => {
  const f = await createTenantMysqlFixture('procure_detail');
  f.useEnvironment();
  const api = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  try {
    // Fixed time prevents old/new date-window or overdue differences at midnight.
    await f.query('SET timestamp = UNIX_TIMESTAMP(\'2026-11-27 12:00:00\')');
    await seed(f, api);
    const oldSource = execFileSync('git', ['show', `${baselineCommit}:src/services/mysql-cutover.js`], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const currentSource = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
    const dependencies = Object.assign({}, ...await Promise.all([
      '../src/services/inventory-tenant-scope.js', '../src/shared/vehicle-brand.js', '../src/services/inventory-search.js',
      '../src/services/order-outcome.js', '../src/services/mysql-procurement-list.js', '../src/services/procurement-live-demand.js',
      '../src/services/procurement-demand-cancellation.js', '../src/shared/procurement-demand-cancellation.js',
      '../src/services/mysql-order-procurement-coverage.js', '../src/services/inventory-workflow.js'
    ].map(path => import(path))));
    const old = loadReader(oldSource, f.connection, dependencies), current = loadReader(currentSource, f.connection, dependencies);
    const compare = async (query, tenant = 2) => {
      const before = await old.read(query, tenant), after = await current.read(query, tenant);
      assert.deepEqual(after.detail?.rows, before.detail?.rows, `All raw detail columns: ${JSON.stringify({query,tenant})}`);
      assert.deepEqual(after.result, before.result, `Complete result: ${JSON.stringify({query,tenant})}`);
      return { before, after };
    };
    await t.test('full and compact grouped pages, totals, priority and filters equal the release baseline', async () => {
      for (const demandType of ['all', 'advance_stock', 'real_order', 'local_safety', 'fbp_stock']) {
        for (const page of [1, 2, 20]) await compare({ grouped: '1', demandType, page, pageSize: 2 });
        await compare({ grouped: '1', demandType, pageSize: 100, compact: '1' });
      }
      for (const filter of [{ search: 'Alpha' }, { query: 'MAIN' }, { productId: 200 }, { personId: 2 }, { supplierId: 20 },
        { sourceType: 'pdd' }, { inventoryCategory: 'part', vehicleBrand: 'BMW', vehicleModel: 'X1', accessoryName: 'trim', color: 'black', material: 'ABS' }]) {
        await compare({ grouped: '1', pageSize: 20, ...filter });
      }
      const result = (await current.read({ grouped: '1', demandType: 'all', pageSize: 20 })).result;
      assert.ok(result.total >= 6, 'Fixture must contain real pages, including shortage without a saved request');
      const ids = result.rows.map(row => Number(row.product_id));
      assert.ok(ids.includes(205), 'An order shortage without a saved request remains visible');
      assert.ok(ids.indexOf(205) < ids.indexOf(200), 'Actual uncovered order demand precedes safety purchasing');
      assert.ok(!ids.includes(206) && !ids.includes(300), 'Cancelled requests and foreign products stay excluded');
    });
    await t.test('time windows, mapping OR multiplicity and lifetime history retain exact values', async () => {
      const { after } = await compare({ grouped: '1', productId: 200, pageSize: 20 });
      const row = after.detail.rows.find(row => Number(row.product_id) === 200);
      const nums = names => names.map(name => Number(row[name]));
      assert.deepEqual(nums(['recent_7d_qty', 'recent_15d_qty', 'recent_30d_qty', 'week1_qty', 'week2_qty', 'week3_qty']), [41, 62, 76, 41, 15, 15]);
      assert.equal(Number(row.historical_total_quantity), 297, 'Old/NULL/cancelled rows remain in lifetime history; OR joins retain multiplicity');
      assert.equal(Number(row.historical_purchase_count), 1);
      assert.equal(Number(row.historical_purchased_quantity), 10);
      assert.equal(Number(row.historical_purchase_amount), 100);
      assert.deepEqual(nums(['historical_purchase_inbound_quantity', 'historical_inventory_order_outbound_quantity', 'historical_return_in_quantity', 'historical_fbp_transfer_outbound_quantity', 'historical_other_inventory_quantity']), [12, 2, 1, 1, -1]);
      assert.equal(Number(row.historical_outbound_quantity), 2);
    });
    await t.test('shared, negative, zero, inactive and foreign component supply remains unchanged', async () => {
      const expected = new Map([[200, [2, -3, 7]], [201, [1, 11, 5]], [202, [1, 5, 3]], [203, [1, -2, 4]], [204, [1, 0, 0]]]);
      for (const [id, supply] of expected) {
        const { after } = await compare({ grouped: '1', productId: id, pageSize: 1 });
        const row = after.detail.rows.find(row => Number(row.product_id) === id);
        assert.deepEqual(['component_count', 'component_local_stock', 'component_incoming_stock'].map(key => Number(row[key])), supply, `Component supply for ${id}`);
      }
    });
    await t.test('default numeric and legacy NULL ownership stay separate from A and B', async () => {
      for (const tenant of ['admin', 1, 2, 3]) {
        const { after } = await compare({ grouped: '1', pageSize: 100 }, tenant);
        const ids = after.result.rows.map(row => Number(row.product_id));
        if (tenant === 'admin' || tenant === 1) assert.deepEqual(ids.sort(), [100, 101]);
        else if (tenant === 3) assert.deepEqual(ids, [300]);
        else assert.ok(ids.every(id => id >= 200 && id < 300));
      }
      for (const [tenant, id, expected] of [['admin', 100, [1, 4, 2]], ['admin', 101, [1, 5, 3]], [3, 300, [1, 999, 999]]]) {
        const { after } = await compare({ grouped: '1', productId: id }, tenant);
        assert.deepEqual(['component_count', 'component_local_stock', 'component_incoming_stock'].map(key => Number(after.detail.rows[0][key])), expected);
      }
      await compare({ grouped: '1', productId: 300 }, 2);
      await compare({ grouped: '1', productId: 200 }, 'admin');
    });
    await t.test('non-grouped legacy reads keep their full result and component totals', async () => {
      await compare({ status: 'all', paged: '1', pageSize: 100 });
      await compare({ status: 'pending', bindingStatus: 'bound' }, 'admin');
    });
    await t.test('actual purchasing and partial receiving preserve order coverage and enterprise isolation', async () => {
      const readLive = async () => {
        const { after } = await compare({ grouped: '1', demandType: 'real_order', productId: 205 });
        return after.result.rows[0];
      };
      assert.equal(Number((await readLive()).suggested_purchase_qty), 4);
      const purchase = await api.recordProcurementPurchaseMysql({ items: [{ product_id: 205, quantity: 2, amount: 20 }] }, 2, 2);
      assert.ok(purchase.purchase_order_id);
      const [inbound] = await f.query('SELECT id,quantity FROM inbound_records WHERE purchase_order_id=?', [purchase.purchase_order_id]);
      assert.equal(Number(inbound.quantity), 2);
      assert.equal(Number((await readLive()).suggested_purchase_qty), 2, 'Purchased supply is already counted once by shared order coverage');
      await api.updateInboundRecordMysql(inbound.id, { status: 'approved', receive_quantity: 1, expected_remaining_quantity: 2, receipt_difference_reason: 'partial' }, 2, 2);
      assert.equal(Number((await readLive()).suggested_purchase_qty), 2, 'Partial receipt replaces purchased supply without subtracting it twice');
      const [stock] = await f.query("SELECT SUM(quantity_delta) AS quantity FROM inventory_movements WHERE product_id=205 AND tenant_id=2 AND status='posted'");
      assert.equal(Number(stock.quantity), 1, 'Only the approved quantity reaches physical inventory');
      const [remaining] = await f.query("SELECT SUM(quantity) AS quantity FROM inbound_records WHERE product_id=205 AND tenant_id=2 AND status='pending_arrival'");
      assert.equal(Number(remaining.quantity), 1);
      for (const tenant of ['admin', 3]) {
        const { after } = await compare({ grouped: '1', productId: 205 }, tenant);
        assert.equal(after.result.rows.length, 0);
      }
    });
    await t.test('50k synthetic fact rows retain all fields while targeted read plans shrink', async () => {
      await f.query('CREATE TEMPORARY TABLE fixture_numbers(n INT PRIMARY KEY)');
      await f.query(`INSERT INTO fixture_numbers SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n FROM
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
        CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
        CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
        CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d
        CROSS JOIN (SELECT 0 n UNION ALL SELECT 1) e WHERE a.n+10*b.n+100*c.n+1000*d.n+10000*e.n<15000`);
      await f.query("INSERT INTO products(id,tenant_id,name,active) SELECT 10000+n,2,CONCAT('Unrelated component ',n),1 FROM fixture_numbers WHERE n<500");
      await f.query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) SELECT 10000+n,20,CONCAT('OLD-',n),'delivered','delivered','2020-01-01' FROM fixture_numbers WHERE n<10000");
      await f.query("INSERT INTO order_items(order_id,sku_mapping_id,ozon_sku,quantity) SELECT 10000+n,200,'MAIN',1 FROM fixture_numbers WHERE n<10000");
      await f.query("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) SELECT 2,10000+MOD(n,500),'initial_stock',1,'posted','LOCAL' FROM fixture_numbers");
      await f.query("INSERT INTO inbound_records(tenant_id,product_id,quantity,status) SELECT 2,10000+MOD(n,500),1,'pending_arrival' FROM fixture_numbers");
      await f.query('ANALYZE TABLE orders,order_items,inventory_movements,inbound_records');
      const { before, after } = await compare({ grouped: '1', productId: 200, demandType: 'advance_stock', pageSize: 1 });
      assert.notEqual(after.detail.sql, before.detail.sql, 'Performance case must run changed production SQL');
      const history = after.detail.rows[0];
      assert.equal(Number(history.historical_total_quantity), 10297, 'Optimizing recent sales never truncates lifetime order history');
      await measureReads(t, f.connection, before.detail, after.detail);
    });
  } finally {
    await closeMysqlPool();
    await f.cleanup();
  }
});

async function measureReads(t, connection, before, after) {
  const run = detail => connection.query(detail.sql, detail.params);
  const handlers = async () => Object.fromEntries((await connection.query("SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key','Handler_read_next','Handler_read_rnd_next')"))[0].map(row => [row.Variable_name, Number(row.Value)]));
  // Compare SQL itself, avoiding cross-request workflow/master-data caches. Both
  // sides are warm and the order is alternated; elapsed time is diagnostic only.
  await run(before); await run(after);
  const samples = [];
  for (const [label, detail] of [['old', before], ['new', after], ['new', after], ['old', before]]) {
    const start = await handlers(), time = performance.now();
    await run(detail);
    const elapsed = performance.now() - time, end = await handlers();
    samples.push({ label, ms: Number(elapsed.toFixed(2)), ...Object.fromEntries(Object.keys(start).map(key => [key, end[key] - start[key]])) });
  }
  t.diagnostic(`Detail SQL only (50k additional facts; warm, alternating): ${JSON.stringify(samples)}`);
  for (const [label, detail] of [['old', before], ['new', after]]) {
    const [plan] = await connection.query(`EXPLAIN ANALYZE ${detail.sql}`, detail.params);
    const text = String(Object.values(plan[0])[0]);
    const relevant = text.split('\n').filter(line => /Index (?:range scan|lookup) on (?:sales_order|inventory_movements|inbound_records)\b/.test(line));
    // Some MySQL builds report materialized branches as "never executed" here;
    // use these as access-path evidence and the measured handlers as read counts.
    t.diagnostic(`${label} affected EXPLAIN access paths: ${relevant.map(line => line.trim().slice(0, 280)).join(' | ')}`);
  }
  const reads = label => samples.filter(row => row.label === label).map(row => row.Handler_read_next + row.Handler_read_rnd_next + row.Handler_read_key);
  assert.ok(Math.max(...reads('new')) < Math.min(...reads('old')), 'Identical detail rows require fewer handler reads with unrelated component facts');
}

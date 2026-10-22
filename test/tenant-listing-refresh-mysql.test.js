import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'acorn';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const session = (id, personId = 7) => ({ personId, role: 'admin', platform_role: 'super_admin', tenant: { id, slug: id === 1 ? 'default' : `enterprise-${id}` } });
const tenantKey = id => id === 1 ? 'admin' : String(id);

test('publish-record refresh executes its real SQL and provider boundaries for A/B/default', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires the isolated TENANT_TEST_MYSQL_SOCKET'
}, async t => {
  const fixture = await createTenantMysqlFixture('listing_refresh');
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people(id,name,role) VALUES (7,'Operator','operations'),(8,'No member','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations'))");
    await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (10,NULL,'Legacy','client-10','key-10'),(11,1,'Default','client-11','key-11'),(20,2,'A','client-20','key-20'),(30,3,'B','client-30','key-30')");
    await query("INSERT INTO products(id,tenant_id,code,name) VALUES (110,NULL,'legacy','Legacy'),(111,1,'default','Default'),(220,2,'a','A'),(330,3,'b','B')");
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const module = await import('../src/services/listing-automation.js');
    await module.ensureListingAutomationSchema();
    const sourceUrl = new URL('../src/services/listing-automation.js', import.meta.url);
    let source = readFileSync(sourceUrl, 'utf8');
    const imports = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter(node => node.type === 'ImportDeclaration');
    const globals = { console, process, Buffer, URL, URLSearchParams, Date, Set, Map, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, fetch: async () => { throw Error('External network is disabled'); } };
    for (const declaration of imports) {
      const specifier = declaration.source.value;
      const imported = await import(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : specifier);
      for (const binding of declaration.specifiers) globals[binding.local.name] = binding.type === 'ImportDefaultSpecifier' ? imported.default : binding.type === 'ImportNamespaceSpecifier' ? imported : imported[binding.imported.name];
    }
    const seeds = new Map(), calls = [];
    let hook = null, importError = null, missingDetail = false;
    const provider = async (kind, shop) => {
      const seed = seeds.get(Number(shop.id));
      assert.ok(seed, 'Provider receives a persisted record rather than caller-selected shop credentials');
      assert.equal(Number(shop.shop_id), seed.shop);
      assert.equal(shop.ozon_client_id, `client-${seed.shop}`);
      assert.equal(shop.api_key_hint, `key-${seed.shop}`);
      calls.push({ kind, record: seed.id, shop: seed.shop });
      if (hook) await hook(kind, seed);
      return seed;
    };
    globals.fetchOzonProductImportInfo = async shop => {
      const seed = await provider('import', shop);
      if (importError) throw Error(importError);
      return { result: { items: [{ product_id: seed.ozonProduct, offer_id: seed.offer, status: 'imported' }] } };
    };
    globals.fetchOzonProductInfoAttributes = async shop => {
      const seed = await provider('attributes', shop);
      return missingDetail ? [] : [{ id: seed.ozonProduct, offer_id: seed.offer, sku: seed.sku, name: 'Fixture listing', price: '100', status: 'imported' }];
    };
    globals.fetchOzonProductsByIds = async shop => {
      const seed = await provider('products', shop);
      return [{ id: seed.ozonProduct, ozon_sku: seed.sku }];
    };
    globals.fetchOzonProductContentRating = async shop => {
      const seed = await provider('rating', shop);
      return [{ sku: seed.sku, rating: 87 }];
    };
    for (const declaration of imports.reverse()) source = source.slice(0, declaration.start) + source.slice(declaration.end);
    const service = vm.createContext(globals);
    vm.runInContext(source.replaceAll('export ', '') + '\nmysqlSchemaReady = true;', service);

    const seed = async (tenant, { shop = tenant === 1 ? 11 : tenant * 10, recordTenant = tenantKey(tenant), product = tenant === 1 ? 111 : tenant * 110, task = true, expired = false, developmentTask = null } = {}) => {
      const draftResult = await query(`INSERT INTO listing_drafts(tenant_id,product_name,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json,created_by_person_id)
        VALUES (?,?,'[]','[]','{}','{}','{}',7)`, [tenantKey(tenant), `Fixture ${seeds.size}`]);
      const taskResult = await query("INSERT INTO listing_publish_tasks(tenant_id,task_no,status,total_count,request_json,created_by_person_id) VALUES (?,?,'running',1,'{}',7)", [tenantKey(tenant), `task-${draftResult.insertId}`]);
      const itemResult = await query("INSERT INTO listing_publish_task_items(tenant_id,publish_task_id,draft_id,shop_id,status) VALUES (?,?,?,?,'processing')", [tenantKey(tenant), taskResult.insertId, draftResult.insertId, shop]);
      const recordResult = await query(`INSERT INTO listing_publish_records(tenant_id,draft_id,shop_id,status,task_id,request_json,response_json,source_product_id,publish_task_id,publish_task_item_id,created_by_person_id,created_at)
        VALUES (?,?,?,'processing',?,'{}','{}',?,?,?,7,${expired ? 'DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 2 DAY)' : 'CURRENT_TIMESTAMP'})`, [recordTenant, draftResult.insertId, shop, task ? `ozon-${draftResult.insertId}` : '', product, taskResult.insertId, itemResult.insertId]);
      const current = { id: recordResult.insertId, tenant, shop, product, draft: draftResult.insertId, task: taskResult.insertId, item: itemResult.insertId, offer: `refresh-${recordResult.insertId}`, sku: String(800000 + recordResult.insertId), ozonProduct: 600000 + recordResult.insertId };
      current.variant = `variant-${current.draft}`;
      await query('UPDATE listing_publish_task_items SET record_id=? WHERE id=?', [current.id, current.item]);
      await query('UPDATE listing_publish_records SET offer_id=?,request_json=? WHERE id=?', [current.offer, JSON.stringify({ items: [{ offer_id: current.offer, name: 'Fixture listing', price: '100', currency_code: 'RUB' }] }), current.id]);
      await query("INSERT INTO listing_publish_variant_links(tenant_id,draft_id,variant_id,record_id,item_index,shop_id,offer_id,source_product_id) VALUES (?,?,?,?,0,?,?,?)", [tenantKey(tenant), current.draft, current.variant, current.id, shop, current.offer, product]);
      await query("INSERT INTO online_products(shop_id,ozon_sku,offer_id,ozon_product_id,name) VALUES (?,?,?,?,'Fixture online')", [shop, current.sku, current.offer, String(current.ozonProduct)]);
      if (developmentTask) await query('INSERT INTO listing_draft_bindings(tenant_id,draft_id,task_id) VALUES (?,?,?)', [tenantKey(tenant), current.draft, developmentTask]);
      seeds.set(current.id, current);return current;
    };
    const snapshot = async () => {
      const out = {};
      for (const table of ['listing_publish_records', 'listing_publish_variant_links', 'listing_variant_lineage', 'online_products', 'sku_mappings', 'listing_publish_tasks', 'listing_publish_task_items', 'team_tasks']) out[table] = await query(`SELECT * FROM ${table} ORDER BY id`);
      return JSON.stringify(out);
    };
    const resetAuthority = async () => {
      hook = null;importError = null;missingDetail = false;
      await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,role='member',business_roles_json=JSON_ARRAY('operations')");
      await query('UPDATE shops SET tenant_id=2,status=\'active\' WHERE id=20');
    };

    await t.test('A/B/default and legal default NULL/empty history perform real bind, SKU, quality and lineage writes', async () => {
      for (const [tenant, options] of [[1, {}], [2, {}], [3, {}], [1, { shop: 10, recordTenant: null, product: 110, task: false }], [1, { shop: 10, recordTenant: '', product: 110 }], [2, { task: false }]]) {
        const current = await seed(tenant, options);
        const beforeTasks = JSON.stringify(await query('SELECT * FROM listing_publish_tasks ORDER BY id'));
        const result = await service.refreshListingPublishRecord(current.id, session(tenant));
        assert.equal(result.id, current.id);
        assert.equal(result.ozon_sku, current.sku);
        const [record] = await query('SELECT binding_status,quality_score FROM listing_publish_records WHERE id=?', [current.id]);
        assert.equal(record.binding_status, 'bound');assert.equal(Number(record.quality_score), 87);
        const [mapping] = await query('SELECT tenant_id,product_id,shop_id FROM sku_mappings WHERE shop_id=? AND ozon_sku=?', [current.shop, current.sku]);
        assert.deepEqual(mapping, { tenant_id: tenant, product_id: current.product, shop_id: current.shop });
        const [lineage] = await query('SELECT tenant_id,inventory_id,quality_score FROM listing_variant_lineage WHERE record_id=?', [current.id]);
        assert.equal(lineage.tenant_id, tenantKey(tenant));assert.equal(lineage.inventory_id, current.product);assert.equal(Number(lineage.quality_score), 87);
        assert.equal(JSON.stringify(await query('SELECT * FROM listing_publish_tasks ORDER BY id')), beforeTasks, 'record refresh does not rewrite task counters');
      }
    });
    await t.test('foreign records, mismatched/foreign/deleted shops and foreign inventory references fail before any provider call or write', async () => {
      const foreign = await seed(3);
      for (const tenant of [1, 2]) {
        const before = await snapshot(), count = calls.length;
        await assert.rejects(service.refreshListingPublishRecord(foreign.id, session(tenant)), error => error.status === 404);
        assert.equal(calls.length, count);assert.equal(await snapshot(), before);
      }
      for (const options of [{ shop: 30 }, { shop: 10 }, { product: 330 }]) {
        const current = await seed(2, options), before = await snapshot(), count = calls.length;
        await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), error => error.status === 404);
        assert.equal(calls.length, count);assert.equal(await snapshot(), before);
      }
      const current = await seed(2);
      await query("UPDATE shops SET status='deleted' WHERE id=20");
      const before = await snapshot(), count = calls.length;
      await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), error => error.status === 404);
      assert.equal(calls.length, count);assert.equal(await snapshot(), before);await resetAuthority();
    });
    await t.test('fresh membership, role, person, tenant and subscription checks ignore forged session authority', async () => {
      const current = await seed(2);
      const changes = ["UPDATE tenant_members SET active=0 WHERE tenant_id=2", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2", "UPDATE people SET active=0 WHERE id=7", "UPDATE tenants SET status='suspended' WHERE id=2", "UPDATE tenants SET subscription_status='expired' WHERE id=2", "UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"];
      for (const change of changes) {
        await query(change);const before = await snapshot(), count = calls.length;
        await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), { code: 'TENANT_TASK_ACCESS_DENIED' });
        assert.equal(calls.length, count);assert.equal(await snapshot(), before);await resetAuthority();
      }
      const count = calls.length;
      await assert.rejects(service.refreshListingPublishRecord(current.id, session(2, 8)), { code: 'TENANT_TASK_ACCESS_DENIED' });
      await assert.rejects(service.refreshListingPublishRecord(current.id, null), { code: 'TENANT_TASK_ACCESS_DENIED' });
      assert.equal(calls.length, count);
    });
    await t.test('foreign inventory inferred through owned online/mapping rows cannot be adopted', async () => {
      for (const kind of ['online', 'mapping']) {
        const current = await seed(2, { product: null });
        if (kind === 'online') await query('UPDATE online_products SET product_id=330 WHERE shop_id=? AND ozon_sku=?', [current.shop, current.sku]);
        else await query("INSERT INTO sku_mappings(shop_id,tenant_id,product_id,ozon_sku,offer_id) VALUES (?,2,330,?,?)", [current.shop, current.sku, current.offer]);
        const before = await snapshot(), count = calls.length;
        await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), error => error.status === 404);
        assert.equal(calls.length, count);assert.equal(await snapshot(), before);
      }
    });
    await t.test('foreign publish-task/item and poisoned variant-link references cannot be copied or written', async () => {
      const foreign = await seed(3);
      for (const poison of [
        current => query('UPDATE listing_publish_records SET publish_task_id=? WHERE id=?', [foreign.task, current.id]),
        async current => { await query('UPDATE listing_publish_records SET publish_task_item_id=NULL WHERE id=?', [foreign.id]);await query('UPDATE listing_publish_records SET publish_task_item_id=? WHERE id=?', [foreign.item, current.id]); },
        current => query('UPDATE listing_publish_variant_links SET shop_id=30 WHERE record_id=?', [current.id]),
        current => query('UPDATE listing_publish_variant_links SET source_product_id=330 WHERE record_id=?', [current.id])
      ]) {
        const current = await seed(2);await poison(current);
        const before = await snapshot(), count = calls.length;
        await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), error => error.status === 404);
        assert.equal(calls.length, count);assert.equal(await snapshot(), before);
      }
      const current = await seed(2);
      await query("INSERT INTO listing_publish_variant_links(tenant_id,draft_id,variant_id,record_id,item_index,shop_id,offer_id,source_product_id) VALUES ('3',?, 'foreign-link',?,1,30,'foreign-offer',330)", [foreign.draft, current.id]);
      const foreignBefore = JSON.stringify(await query("SELECT * FROM listing_publish_variant_links WHERE tenant_id='3' ORDER BY id"));
      await service.refreshListingPublishRecord(current.id, session(2));
      assert.equal(JSON.stringify(await query("SELECT * FROM listing_publish_variant_links WHERE tenant_id='3' ORDER BY id")), foreignBefore);
    });
    await t.test('revocation during every Ozon stage stops all later providers and writes, including quality fallback', async () => {
      for (const [kind, change] of [['import', "UPDATE tenant_members SET active=0 WHERE tenant_id=2"], ['attributes', "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2"], ['products', "UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"], ['rating', "UPDATE tenant_members SET active=0 WHERE tenant_id=2"]]) {
        const current = await seed(2);let revokedSnapshot = null, callsAtRevocation = 0;
        hook = async stage => { if (stage === kind && !revokedSnapshot) { await query(change);revokedSnapshot = await snapshot();callsAtRevocation = calls.length; } };
        await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), { code: 'TENANT_TASK_ACCESS_DENIED' });
        assert.ok(revokedSnapshot, kind);assert.equal(await snapshot(), revokedSnapshot, `${kind}: no writes after revocation`);assert.equal(calls.length, callsAtRevocation);
        await resetAuthority();
      }
    });
    await t.test('shop reassignment during the provider await rejects before applying its response', async () => {
      const current = await seed(2);let movedSnapshot;
      hook = async kind => { if (kind === 'import') { await query('UPDATE shops SET tenant_id=3 WHERE id=20');movedSnapshot = await snapshot(); } };
      await assert.rejects(service.refreshListingPublishRecord(current.id, session(2)), error => error.status === 404);
      assert.equal(await snapshot(), movedSnapshot);await resetAuthority();
    });
    await t.test('foreign development-task titles and identifiers never enter owned lineage', async () => {
      await query("INSERT INTO team_tasks(id,tenant_id,title,work_type) VALUES (9001,'2','Own task','product_development'),(9002,'3','Private B task','product_development')");
      for (const [developmentTask, expectedId, expectedTitle] of [[9001, 9001, 'Own task'], [9002, null, '']]) {
        const current = await seed(2, { developmentTask });
        const before = JSON.stringify(await query("SELECT * FROM team_tasks WHERE tenant_id='3'"));
        await service.refreshListingPublishRecord(current.id, session(2));
        const [lineage] = await query('SELECT development_task_id,development_task_title FROM listing_variant_lineage WHERE record_id=?', [current.id]);
        assert.equal(lineage.development_task_id, expectedId);assert.equal(lineage.development_task_title, expectedTitle);
        assert.equal(JSON.stringify(await query("SELECT * FROM team_tasks WHERE tenant_id='3'")), before);
      }
    });
    await t.test('expired import tasks preserve successful discovery and not-found outcomes without re-publishing', async () => {
      for (const missing of [false, true]) {
        const current = await seed(2, { expired: true });importError = 'task not found';missingDetail = missing;
        const result = await service.refreshListingPublishRecord(current.id, session(2));
        assert.equal(result.status, missing ? 'failed' : 'imported');
        await resetAuthority();
      }
    });
    await t.test('real startup lineage backfill also excludes foreign development-task content', async () => {
      const own = await seed(2, { developmentTask: 9001 });
      const foreign = await seed(2, { developmentTask: 9002 });
      const beforeTasks = JSON.stringify(await query('SELECT * FROM team_tasks ORDER BY id')), count = calls.length;
      // The normal initializer backfills only when lineage has never been built.
      await query('DELETE FROM listing_variant_lineage');
      vm.runInContext('mysqlSchemaReady = false; mysqlSchemaReadyPromise = null;', service);
      await service.ensureListingAutomationSchema();
      for (const [current, taskId, title] of [[own, 9001, 'Own task'], [foreign, null, '']]) {
        const [lineage] = await query('SELECT development_task_id,development_task_title FROM listing_variant_lineage WHERE record_id=?', [current.id]);
        assert.equal(lineage.development_task_id, taskId);assert.equal(lineage.development_task_title, title);
      }
      assert.equal(calls.length, count);assert.equal(JSON.stringify(await query('SELECT * FROM team_tasks ORDER BY id')), beforeTasks);
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});

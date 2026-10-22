import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { listingTenantLookup } from '../src/services/listing-tenant-scope.js';

test('category diagnostics share official dictionaries while isolating shop sync metadata', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL'
}, async () => {
  const fixture = await createTenantMysqlFixture('category_diagnostics');
  try {
    const { query } = fixture;
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(11,1,'Default'),(20,2,'A'),(30,3,'B')");
    await query('CREATE TABLE ozon_category_mappings(id INT PRIMARY KEY, description_category_id BIGINT, type_id BIGINT, status VARCHAR(32), synced_at DATETIME NULL)');
    await query("INSERT INTO ozon_category_mappings VALUES(1,777,888,'active',NULL)");
    await query('CREATE TABLE ozon_category_attributes(id INT PRIMARY KEY, description_category_id BIGINT, type_id BIGINT, status VARCHAR(32), is_required INT, sort_order INT, attribute_id BIGINT)');
    await query('CREATE TABLE ozon_category_sync_jobs(id INT PRIMARY KEY,job_type VARCHAR(80),shop_id BIGINT NULL,status VARCHAR(32),started_at DATETIME,finished_at DATETIME NULL,result_json JSON,payload_json JSON,error_message TEXT)');
    for (const [id, shop] of [[1, 10], [2, 11], [3, 20], [4, 30], [5, null]]) {
      await query("INSERT INTO ozon_category_sync_jobs VALUES(?,'manual',?,'failed',TIMESTAMP('2026-10-01') + INTERVAL ? HOUR,NULL,NULL,JSON_OBJECT('description_category_id',777),?)", [id, shop, id, `private-sync-${id}`]);
    }
    const source = readFileSync(new URL('../src/services/listing-automation.js', import.meta.url), 'utf8');
    const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration || node);
    const context = vm.createContext({
      listingTenantLookup, mysqlQuery: query, ensureListingAutomationSchema: async () => {},
      normalizeEditablePayload: value => value, normalizeArray: value => Array.isArray(value) ? value : [],
      normalizeOzonCategoryRow: value => value, normalizeOzonCategoryAttributeRow: value => value,
      currentAiTenantSession: () => null
    });
    for (const name of ['listingTenantId', 'all', 'row', 'buildListingCategoryPublishDiagnostics']) {
      const node = declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
      assert.ok(node, name);
      vm.runInContext(source.slice(node.start, node.end), context);
    }
    for (const [tenant, expected] of [[1, 2], [2, 3], [3, 4]]) {
      const result = await context.buildListingCategoryPublishDiagnostics({}, {
        facts: { descriptionCategoryId: 777, typeId: 888 }, payload: { items: [] },
        session: { tenant: { id: tenant, slug: tenant === 1 ? 'default' : `tenant-${tenant}` } }
      });
      assert.equal(result.category.id, 1);
      assert.equal(result.latest_sync_job.id, expected);
      assert.equal(result.latest_sync_job.error_message, `private-sync-${expected}`);
    }
  } finally { await fixture.cleanup(); }
});

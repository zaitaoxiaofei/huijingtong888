import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
test('aliases persist through creation, independent readers, overwrite and deletion with enterprise isolation', { skip: !process.env.TENANT_TEST_MYSQL_SOCKET, timeout: 180000 }, async () => {
  const f = await createTenantMysqlFixture('product_alias'); f.useEnvironment();
  const { createProductAliasService } = await import('../src/services/product-alias.js');
  const legacy = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const q = f.query;
  const actor = { personId: 1, tenant: { id: 2, slug: 'a', role: 'member' } };
  const foreign = { personId: 2, tenant: { id: 3, slug: 'b', role: 'member' } };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(1,'Buyer','procurement'),(2,'Other','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(3,2,'member',JSON_ARRAY('procurement'),1)");
    await q("INSERT INTO products(id,tenant_id,name) VALUES(900,2,'历史库存')");
    await q('ALTER TABLE products DROP COLUMN product_alias');
    const created = await legacy.createProductMysql({ name: '测试库存', product_alias: '星途揽月', owner_person_id: 1, created_by_person_id: 1, package_weight_g: 100, length_cm: 10, width_cm: 10, height_cm: 10 }, null, 2);
    const id = Number(created.id), service = createProductAliasService();
    assert.ok(id > 0);
    assert.equal((await service.read({ product_ids: '900' }, actor)).rows[0].product_alias, '');
    assert.equal((await service.read({ product_ids: String(id) }, actor)).rows[0].product_alias, '星途揽月');
    await service.save({ product_id: id, expected_alias: '星途揽月', product_alias: '国内揽月2024款' }, actor);
    assert.equal((await createProductAliasService().read({ product_ids: String(id) }, actor)).rows[0].product_alias, '国内揽月2024款');
    await assert.rejects(service.save({ product_id: id, expected_alias: '星途揽月', product_alias: '' }, actor), { statusCode: 409 });
    assert.deepEqual((await service.read({ product_ids: String(id) }, foreign)).rows, []);
    await assert.rejects(service.save({ product_id: id, expected_alias: '国内揽月2024款', product_alias: '越权' }, foreign), { statusCode: 404 });
    const { filterInventoryProductRows } = await import('../src/services/inventory-product-search.js');
    const { resolveInventoryTenantScope } = await import('../src/services/inventory-tenant-scope.js');
    const scope = await resolveInventoryTenantScope(2, q);
    for (const searchMode of ['auto', 'name']) {
      const rows = await filterInventoryProductRows([{ product_id: id }], { query: '国内揽月', searchMode }, scope, q);
      assert.deepEqual(rows.map(row => row.product_id), [id]);
    }
    const found = await legacy.productsMysql({ paged: '1', view: 'inventory', includeStock: '0', query: '国内揽月', searchMode: 'name' }, 2);
    assert.equal(found.total, 1);
    await service.save({ product_id: id, expected_alias: '国内揽月2024款', product_alias: '' }, actor);
    assert.equal((await q('SELECT product_alias FROM products WHERE id=?', [id]))[0].product_alias, '');
    const plain = await legacy.createProductMysql({ name: '默认无别名', owner_person_id: 1, created_by_person_id: 1, package_weight_g: 100, length_cm: 10, width_cm: 10, height_cm: 10 }, null, 2);
    assert.equal((await q('SELECT product_alias FROM products WHERE id=?', [plain.id]))[0].product_alias, '');
    await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1');
    await assert.rejects(service.save({ product_id: id, expected_alias: '', product_alias: '失效成员' }, actor), { statusCode: 403 });
  } finally { await closeMysqlPool(); await f.cleanup(); }
});

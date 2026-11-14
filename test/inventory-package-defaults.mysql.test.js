import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('catalog creation stores price tier defaults, preserves manual fees and blocks zero stock weight on edit', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET, timeout: 180000
}, async () => {
  const fixture = await createTenantMysqlFixture('package_defaults');
  fixture.useEnvironment();
  const q = fixture.query;
  const api = await import('../src/services/mysql-cutover.js');
  const {closeMysqlPool} = await import('../src/mysql-pool.js');
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(2,'packaging-test','Packaging test')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('procurement'),1)");
    const input = {name:'Package test',owner_person_id:7,created_by_person_id:7,package_weight_g:100,length_cm:30,width_cm:20,height_cm:10};
    for (const [price, expected] of [[50,0.3],[75,0.5],[100,0.5],[101,1]]) {
      const created = await api.createProductMysql({...input,air_sale_price_rmb:price}, null, 2);
      const [saved] = await q('SELECT * FROM products WHERE id=?',[created.id]);
      assert.equal(Number(saved.handling_fee),expected);
      await assert.rejects(api.updateProductMysql(created.id,{...saved,package_weight_g:0},2), error => error.statusCode===400 && error.message.includes('包装克重'));
      assert.equal(Number((await q('SELECT package_weight_g FROM products WHERE id=?',[created.id]))[0].package_weight_g),100);
    }
    const manual = await api.createProductMysql({...input,air_sale_price_rmb:101,handling_fee:0}, null, 2);
    assert.equal(Number((await q('SELECT handling_fee FROM products WHERE id=?',[manual.id]))[0].handling_fee),0);
  } finally { await closeMysqlPool(); await fixture.cleanup(); }
});

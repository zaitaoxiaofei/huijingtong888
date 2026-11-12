import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryCreationSearchParams } from '../frontend/admin/utils/inventory-creation-search.js';
import { inventoryProductSearch } from '../src/services/inventory-product-search.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { readFileSync } from 'node:fs';

test('creation sends independent standard fields without name search or default quantity', () => {
  const params = inventoryCreationSearchParams({category:'门槛条', vehicle_brand:'ESTEO', vehicle_models:['VR7'], accessory:'普通款', colors:['银色'], materials:['不锈钢'], process:'拉丝', quantity:1});
  assert.deepEqual(Object.fromEntries(params), {inventoryCategory:'门槛条', vehicleBrand:'ESTEO', requiredModels:'VR7', accessoryName:'普通款', requiredColors:'银色', requiredMaterials:'不锈钢', process:'拉丝'});
  assert.equal(inventoryCreationSearchParams({}).toString(), '');
});

test('a stale response cannot restore candidates after an attribute changes', async () => {
  const source = readFileSync(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('let similarProductsRequest = 0;'), source.indexOf('function selectExistingProduct'));
  const pending = [];
  const api = {get: () => new Promise(resolve => pending.push(resolve))};
  const rows = {value:[]};
  const loading = {value:false};
  const query = {value:'inventoryCategory=门槛条&vehicleBrand=FORD'};
  const form = {structured_naming:{category:'门槛条'}};
  const {loadSimilarProducts, scheduleSimilarProducts} = Function('props', 'form', 'similarProductQuery', 'similarProducts', 'similarProductsLoading', 'apiClient', 'window', `let similarProductsTimer; ${block}; return {loadSimilarProducts, scheduleSimilarProducts};`)({visible:true}, form, query, rows, loading, api, {clearTimeout(){},setTimeout(){}});
  const oldRequest = loadSimilarProducts();
  query.value = 'inventoryCategory=门槛条&vehicleBrand=ESTEO';
  scheduleSimilarProducts();
  pending[0]({rows:[{id:1,name:'FORD'}]});
  await oldRequest;
  assert.deepEqual(rows.value, []);
  const newRequest = loadSimilarProducts();
  pending[1]({rows:[{id:2,name:'ESTEO VR7'}]});
  await newRequest;
  assert.deepEqual(rows.value, [{id:2,name:'ESTEO VR7'}]);
  assert.equal(loading.value, false);
});

test('creation filters before pagination and preserves enterprise isolation', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET, timeout:180000}, async () => {
  const f = await createTenantMysqlFixture('creation_search');
  f.useEnvironment();
  const q = f.query;
  const {productsMysql} = await import('../src/services/mysql-cutover.js');
  const {closeMysqlPool} = await import('../src/mysql-pool.js');
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    // The wanted product is older than more than 30 unrelated products.
    await q("INSERT INTO products(id,tenant_id,name,inventory_category,vehicle_brand,vehicle_model,accessory_name,color,material,surface_process) VALUES(200,2,'标准库存','门槛条','ESTEO','VR7','LOGO定制款','银色/黑色','不锈钢/ABS塑料','拉丝'),(201,2,'另一型号','门槛条','ESTEO','VR70','普通款','银色','不锈钢','拉丝'),(300,3,'其他企业','门槛条','ESTEO','VR7','普通款','银色','不锈钢','拉丝')");
    for (let id = 400; id < 435; id++) await q("INSERT INTO products(id,tenant_id,name,inventory_category,vehicle_brand,vehicle_model,accessory_name) VALUES(?,2,'门槛条 FORD','门槛条','FORD','Focus','普通款')", [id]);
    const find = async item => {
      const query = {...Object.fromEntries(inventoryCreationSearchParams(item)), bindableOnly:'1'};
      const criteria = inventoryProductSearch(query, {id:2,isDefault:false});
      assert.equal(criteria.sql.match(/\?/g).length, criteria.params.length);
      return (await q(`SELECT p.id FROM products p WHERE p.tenant_id=2 AND p.active=1 AND ${criteria.sql} ORDER BY p.id DESC LIMIT 5`, criteria.params)).map(row=>Number(row.id));
    };
    assert.deepEqual(await find({category:'门槛条'}), [434,433,432,431,430]);
    const item = {category:'门槛条', vehicle_brand:'ESTEO'};
    assert.deepEqual(await find(item), [201,200]);
    item.vehicle_models = ['VR7'];
    assert.deepEqual(await find(item), [200]);
    assert.deepEqual(await find({...item, accessory:'普通款'}), []);
    Object.assign(item, {accessory:'LOGO定制款', colors:['银色','黑色'], materials:['不锈钢','ABS塑料'], process:'拉丝'});
    assert.deepEqual(await find(item), [200]);
    const apiQuery = {...Object.fromEntries(inventoryCreationSearchParams(item)), bindableOnly:'1', paged:'1', pageSize:5};
    const result = await productsMysql(apiQuery, 2);
    assert.equal(result.total, 1);
    assert.deepEqual(result.rows.map(row=>Number(row.id)), [200]);
    assert.equal((await productsMysql({...apiQuery, excludeProductId:200}, 2)).total, 0);
    for (const mismatch of [{category:'钥匙壳'}, {vehicle_brand:'GEELY'}, {vehicle_models:['VR8']}, {accessory:'无LOGO款'}, {colors:['红色']}, {materials:['皮革']}, {process:'激光'}]) {
      assert.deepEqual(await find({...item,...mismatch}), []);
    }
    await q("UPDATE products SET selection_status='merged' WHERE id=200");
    assert.deepEqual(await find(item), []);
  } finally {
    await closeMysqlPool();
    await f.cleanup();
  }
});


test('new creation and category changes do not silently constrain style to ordinary', () => {
  const source = readFileSync(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue', import.meta.url), 'utf8');
  const defaults = source.slice(source.indexOf('function createDefaultForm()'), source.indexOf('function resetForm()'));
  const form = Function(`${defaults}; return createDefaultForm();`)();
  assert.equal(form.structured_naming.accessory, '');
  const change = source.slice(source.indexOf('async function handleCategoryChange('), source.indexOf('async function handleVehicleBrandChange('));
  assert.match(change, /form\.structured_naming\.accessory = ""/);
  const query = inventoryCreationSearchParams({...form.structured_naming, category:'门槛条', vehicle_brand:'ESTEO'});
  assert.equal(query.has('accessoryName'), false);
  assert.equal(inventoryCreationSearchParams({...form.structured_naming, accessory:'普通款'}).get('accessoryName'), '普通款');
});

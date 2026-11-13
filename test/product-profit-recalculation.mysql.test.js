import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('real MySQL product recalculation uses 300g, keeps history, refreshes live detail and isolates enterprises', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET, timeout: 180000
}, async () => {
  const f = await createTenantMysqlFixture('profit_parameters'); f.useEnvironment(); const q = f.query;
  const api = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const session = { personId: 7, roles: ['procurement'], tenant: { id: 2, slug: 'a' } };
  const options = { tenantId: 2, session, recalculation_scope: 'pending', tariff_mode: 'original', preview: true };
  const calculate = args => api.recalculateOrderProfitsForProductMysql(1041, { ...options, ...args });
  const run = async args => { const preview = await calculate(args); const result = await calculate({ ...args, preview: false, preview_token: preview.preview_token }); assert.equal(result.failed, 0, JSON.stringify(result)); assert.equal(result.refresh_warning, ''); return { preview, result }; };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Buyer','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('procurement','technical'),1)");
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(5,2,'A shop'),(6,3,'B shop')");
    await api.warmCoreInventoryRuntimeMysql('admin');
    await q('ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT UNSIGNED NULL');
    await q("INSERT INTO logistics_fee_rules(id,name,carrier,channel,mode,min_weight_g,max_weight_g,min_price_rub,max_price_rub,base_fee_cny,per_gram_cny,per_ticket_cny,version_group_id,effective_from) VALUES(17070,'OGL 陆运 Extra Small','OGL','economy','per_gram',1,500,1,1500,0,0.0242,2.8,17070,'2026-10-19 16:00:00')");
    await q("INSERT INTO products(id,tenant_id,name,purchase_cost,package_weight_g,length_cm,width_cm,height_cm,logistics_rule_id,shipping_method,withdrawal_fee_rate,return_rate) VALUES(1041,2,'300g test',27,0,30,20,10,17070,'economy',0.012,0.05)");
    await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(2682,2,5,1041,'6191758261')");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(35440,5,'0112339342-0272-1','awaiting_packaging','2026-11-13 06:01:04'),(35441,6,'B-1','awaiting_packaging','2026-11-13 06:01:04')");
    await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,sale_price,frozen_logistics_rule_id) VALUES(35793,35440,2682,'6191758261',100,17070),(35794,35441,2682,'6191758261',100,17070)");
    await q("INSERT INTO order_profit_daily_fx_rates(id,business_date,currency_from,currency_to,rate,source,source_date,source_nominal,source_value,source_url,source_sha256,fetched_at) VALUES(1,'2026-11-13','CNY','RUB',12.4009,'cbr','2026-11-13','1','12.4009','https://www.cbr.ru/scripts/XML_daily_eng.asp?date_req=13/11/2026',REPEAT('a',64),NOW(3))");
    await q("INSERT INTO order_profit_fx_state(tenant_key,order_id,ordered_business_date,order_fx_id,prices_json,state) VALUES('2',35440,'2026-11-13',1,?, 'ready')", [JSON.stringify([{ ozon_sku: '6191758261', amount: 100, currency: 'CNY' }])]);
    await q("INSERT INTO system_settings(`key`,value_json) VALUES('profit.daily_fx_policy.v2',?)", [JSON.stringify({ version: 'V2', enabled_at: '2026-10-20T00:00:00Z', legacy_max_order_id: 0 })]);
    await q("INSERT INTO order_profit_calc_state(tenant_key,order_item_id,order_id,formula_version) VALUES('2',35793,35440,'V4')");
    const initial = await run(); assert.equal(initial.preview.rows.length, 1); assert.equal(initial.preview.rows[0].new_freight, 5.04);
    await q('UPDATE products SET package_weight_g=300 WHERE id=1041');
    const manual = await api.recalculateOrderProfitMysql(35440, { tenantId: 2, session: { ...session, roles: ['technical'] }, sync_outbound: false, refresh_snapshots: false });
    assert.equal(manual.updated, 1);
    const manualDetail = await api.orderDetailMysql(35440, 2);
    assert.equal(manualDetail.profit_detail_snapshot.summary.estimatedProfit, 43.77);
    const corrected = await run(); assert.equal(corrected.preview.rows[0].new_freight, 12.06); assert.equal(corrected.preview.rows[0].new_profit, 43.77);
    const saved = (await q('SELECT * FROM order_items WHERE id=35793'))[0]; assert.equal(Number(saved.frozen_international_shipping), 12.06); assert.equal(Number(saved.estimated_profit), 43.77);
    const detail = await api.orderDetailMysql(35440, 2);
    assert.equal(detail.profit_detail_snapshot.summary.estimatedProfit, 43.77);
    assert.equal(detail.profit_detail_snapshot.detailRows.find(row => row.key === 'international').estimated, 12.06);
    assert.equal(Number((await q('SELECT frozen_international_shipping FROM order_items WHERE id=35794'))[0].frozen_international_shipping), 0);
    const history = await q("SELECT outputs_json FROM order_profit_calc_revisions WHERE order_item_id=35793 AND source='order_recalculation' ORDER BY revision_no");
    assert.equal(JSON.parse(history[0].outputs_json).frozen_international_shipping, '5.0400');
    assert.equal(JSON.parse(history.at(-1).outputs_json).frozen_international_shipping, '12.0600');
    const preview = await calculate(); await q('UPDATE products SET package_weight_g=400 WHERE id=1041');
    await assert.rejects(calculate({ preview: false, preview_token: preview.preview_token }), { statusCode: 409 });
    const { preserveOrderEstimateParameters } = await import('../src/services/product-profit-recalculation.js');
    const preserved = await preserveOrderEstimateParameters({ query: q, tenantKey: 2 }, 35793,
      { product: { id: 1041, package_weight_g: 400 }, mapping: { id: 2682 } });
    assert.equal(Number(preserved.product.package_weight_g), 300);
    await q("UPDATE order_profit_items SET is_locked=1 WHERE order_item_id=35793");
    assert.equal((await calculate()).selected_items, 0);
    await assert.rejects(api.recalculateOrderProfitsForProductMysql(1041, { ...options, tenantId: 3 }), /enterprise|企业|权限|tenant/i);
    // Legacy default-enterprise rows use the authoritative shop's 'admin' key.
    await q("INSERT INTO people(id,name,role) VALUES(1,'Default buyer','procurement')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(1,1,'member',JSON_ARRAY('procurement'),1)");
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(7,NULL,'Legacy default')");
    await q("INSERT INTO products(id,tenant_id,name,purchase_cost,package_weight_g,length_cm,width_cm,height_cm,logistics_rule_id,shipping_method) VALUES(1042,NULL,'Legacy 300g',27,300,30,20,10,17070,'economy')");
    await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku) VALUES(2683,NULL,7,1042,'legacy-sku')");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(35442,7,'LEGACY-1','awaiting_packaging','2026-11-13 06:01:04')");
    await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,sale_price,frozen_logistics_rule_id) VALUES(35795,35442,2683,'legacy-sku',100,17070)");
    await q("INSERT INTO order_profit_fx_state(tenant_key,order_id,ordered_business_date,order_fx_id,prices_json,state) VALUES('admin',35442,'2026-11-13',1,?, 'ready')", [JSON.stringify([{ozon_sku:'legacy-sku',amount:100,currency:'CNY'}])]);
    await q("INSERT INTO order_profit_calc_state(tenant_key,order_item_id,order_id,formula_version) VALUES('admin',35795,35442,'V4')");
    const legacy = await api.recalculateOrderProfitsForProductMysql(1042, { ...options, tenantId: 1, session: { personId: 1, roles: ['procurement'], tenant: { id: 1, slug: 'default' } } });
    assert.equal(legacy.selected_items, 1); assert.equal(legacy.rows[0].new_freight, 12.06);

  } finally { await closeMysqlPool(); await f.cleanup(); }
});

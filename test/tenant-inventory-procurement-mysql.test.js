import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('actual inventory and procurement services isolate A, B, and default across a complete receipt workflow', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Set TENANT_TEST_MYSQL_SOCKET to a disposable socket-only MySQL instance', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('inventory');
  fixture.useEnvironment();
  const service = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const { query } = fixture;
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES (1,'Default operator','admin'),(2,'A operator','admin'),(3,'B operator','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
    await t.test('fresh canonical schema warms default inventory without requiring creative startup first', async () => {
      await query("INSERT INTO products(id,tenant_id,name) VALUES (98,3,'Foreign warm seed'),(99,1,'Default warm seed')");
      assert.deepEqual(await service.warmCoreInventoryRuntimeMysql('admin'), { ok: true });
      const columns = await query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME IN ('vehicle_brand','vehicle_model','inventory_category','accessory_name')");
      assert.equal(columns.length, 4);
      assert.equal((await query('SELECT name FROM products WHERE id=98'))[0].name, 'Foreign warm seed');
      await query('DELETE FROM products WHERE id IN (98,99)');
    });
    const supplierA = await service.createSupplierMysql({ name: 'A supplier', tenant_id: 3 }, 2);
    const supplierB = await service.createSupplierMysql({ name: 'B supplier' }, 3);
    const products = {};
    for (const id of [1, 2, 3]) products[id] = await service.createProductMysql({ name: `Product ${id}`, owner_person_id: id, created_by_person_id: id,
      image_url: `https://example.invalid/${id}.png`, supplier_id: id === 2 ? supplierA.id : id === 3 ? supplierB.id : null }, null, id);
    const legacy = await service.createProductMysql({ name: 'Legacy default', owner_person_id: 1, created_by_person_id: 1 }, null, 'admin');
    await query('UPDATE products SET tenant_id = NULL WHERE id = ?', [legacy.id]);

    await t.test('A/B/default lists and images never widen for admin or forged tenant fields', async () => {
      for (const id of [1, 2, 3]) {
        const rows = await service.productsMysql({ tenant_id: id === 2 ? 3 : 2 }, id === 1 ? 'admin' : id);
        assert.deepEqual(rows.map(row => Number(row.id)).sort((a, b) => a - b), (id === 1 ? [products[1].id, legacy.id] : [products[id].id]).sort((a,b) => a-b));
      }
      assert.equal(await service.productImageMysql(products[3].id, 2), '');
      assert.equal(await service.productImageMysql(products[2].id, 'admin'), '');
      assert.deepEqual((await service.suppliersMysql({}, 2)).map(row => Number(row.id)), [supplierA.id]);
      await assert.rejects(service.updateSupplierMysql(supplierB.id, { name: 'foreign' }, 'admin'));
    });

    await t.test('foreign and malformed references fail before creating inventory, components or requests', async () => {
      const before = await query('SELECT COUNT(*) AS n FROM inventory_movements');
      await assert.rejects(service.createInventoryMovementMysql({ product_id: products[3].id, quantity_delta: 9 }, 2, 2), { statusCode: 404 });
      await assert.rejects(service.createInventoryMovementMysql({ product_id: products[2].id, quantity_delta: 9, shop_id: 999 }, 2, 2), { statusCode: 404 });
      await assert.rejects(service.createInventoryMovementMysql({ product_id: products[2].id, quantity_delta: 9 }, 1, 'admin'), { statusCode: 404 });
      await assert.rejects(service.updateProductComponentsMysql(products[2].id, { components: [{ component_product_id: products[3].id, quantity: 1 }] }, 2));
      await assert.rejects(service.createProcurementRequestMysql({ product_id: products[2].id, quantity: 2, supplier_id: supplierB.id }, 2, 2), { statusCode: 404 });
      assert.deepEqual(await query('SELECT COUNT(*) AS n FROM inventory_movements'), before);
    });

    await t.test('A request to purchase to partial receipt writes explicit ownership and keeps B untouched', async () => {
      const request = await service.createProcurementRequestMysql({ product_id: products[2].id, supplier_id: supplierA.id, quantity: 5, amount: 50, shipping_amount: 5, tenant_id: 3 }, 2, 2);
      const purchase = await service.mergeProcurementRequestsMysql({ request_ids: [request.id] }, 2, null, 2);
      await assert.rejects(service.purchaseOrderDetailMysql(purchase.id, 3), { statusCode: 404 });
      await assert.rejects(service.confirmPurchaseOrderMysql(purchase.id, {}, 1, null, 'admin'), { statusCode: 404 });
      await service.confirmPurchaseOrderMysql(purchase.id, {}, 2, null, 2);
      const inboundRows = await service.inboundRecordsMysql({}, 2);
      assert.equal(inboundRows.length, 1);
      assert.equal(Number(inboundRows[0].tenant_id), 2);
      await assert.rejects(service.updateInboundRecordMysql(inboundRows[0].id, { status: 'approved' }, 3, 3), { statusCode: 404 });
      await service.updateInboundRecordMysql(inboundRows[0].id, { receive_quantity: 3, expected_remaining_quantity: 5, receipt_difference_reason: 'partial', status: 'approved' }, 2, 2);
      const rows = await service.productsMysql({}, 2);
      assert.equal(Number(rows[0].stock), 3);
      assert.equal(Number((await service.productsMysql({}, 3))[0].stock), 0);
      for (const table of ['procurement_requests','purchase_orders','purchase_order_items','inbound_records','inventory_movements','purchase_cost_versions']) {
        const owned = await query(`SELECT DISTINCT tenant_id FROM ${table}`);
        assert.ok(owned.length, table);
        assert.deepEqual(owned.map(row => Number(row.tenant_id)), [2], table);
      }
      assert.deepEqual(await service.purchaseOrdersMysql({}, 'admin'), []);
      assert.deepEqual(await service.inboundRecordsMysql({}, 3), []);
    });

    await t.test('SKU recipe, ledger and canonical fees preserve scope despite poisoned foreign references', async () => {
      await query("INSERT INTO shops(id,tenant_id,name) VALUES (1,1,'Default shop'),(2,2,'A shop'),(3,3,'B shop')");
      await query("INSERT INTO online_products(id,shop_id,ozon_sku,name) VALUES (2,2,'A-SKU','A online'),(3,3,'B-SKU','B online')");
      await query("INSERT INTO sku_mappings(tenant_id,shop_id,product_id,online_product_id,ozon_sku) VALUES (2,2,?,2,'A-SKU'),(3,3,?,3,'B-SKU')", [products[2].id, products[3].id]);
      assert.equal((await service.mappingsMysql({}, 'admin')).length, 0);
      assert.equal((await service.mappingsMysql({ paged: '1' }, 2)).total, 1);
      await assert.rejects(service.skuInventoryRecipeMysql({ online_product_id: 3 }, 2), { statusCode: 404 });
      await assert.rejects(service.saveSkuInventoryRecipeMysql({ online_product_id: 2, mode: 'combo', items: [{ product_id: products[3].id, quantity: 1 }] }, { tenantId: 2, syncOutbound: false }), { statusCode: 404 });
      await service.saveSkuInventoryRecipeMysql({ online_product_id: 2, mode: 'combo', items: [{ product_id: products[2].id, quantity: 2 }] }, { tenantId: 2, syncOutbound: false });
      const recipe = await service.skuInventoryRecipeMysql({ online_product_id: 2 }, 2);
      assert.equal(recipe.items.length, 1);
      assert.equal(recipe.items[0].quantity, 2);
      await assert.rejects(service.procurementLedgerMysql({ product_id: products[2].id }, 'admin'), { statusCode: 404 });
      const before = await service.procurementLedgerMysql({ product_id: products[2].id }, 2);
      const forged = await query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,status) VALUES (3,?,999,'initial_stock','posted')", [products[2].id]);
      assert.equal((await service.procurementLedgerMysql({ product_id: products[2].id }, 2)).local_stock, before.local_stock);
      const action = { action_type: 'stocktake', product_id: products[2].id, counted_quantity: 4, reason: 'Fixture physical count', revision: before.revision, request_key: 'tenant-ledger-shared-key-001' };
      await assert.rejects(service.applyProcurementLedgerMysql(action, 3, 2), { statusCode: 400 });
      const result = await service.applyProcurementLedgerMysql(action, 2, 2);
      assert.deepEqual(await service.applyProcurementLedgerMysql(action, 2, 2), result);
      assert.equal((await service.procurementLedgerMysql({ product_id: products[2].id }, 2)).local_stock, 4);
      await query('DELETE FROM inventory_movements WHERE id = ?', [forged.insertId]);
      await query("INSERT INTO logistics_fee_rules(tenant_id,name) VALUES (1,'canonical'),(NULL,'legacy shared'),(3,'B private')");
      const fees = await query('SELECT id,tenant_id FROM logistics_fee_rules ORDER BY id');
      const feePayload = async id => ({ ...await service.selectionProductMysql(products[2].id, { includeDetails: 0 }, 2), structured_naming: undefined, owner_person_id: 2, logistics_rule_id: id });
      await service.updateProductMysql(products[2].id, await feePayload(fees[0].id), 2);
      await service.updateProductMysql(products[2].id, await feePayload(fees[1].id), 2);
      await assert.rejects(service.updateProductMysql(products[2].id, await feePayload(fees[2].id), 2), { statusCode: 400 });
    });

    await t.test('import migration preserves old writer idempotence while A/B use the same external IDs independently', async () => {
      const { inspectProcurementImportOwnership, migrateProcurementImportOwnership } = await import('../src/services/tenant-procurement-import-schema.js');
      const reconciliation = await import('../src/services/procurement-reconciliation.js');
      for (const [table, index, columns] of [
        ['procurement_platform_orders','uk_procurement_platform_order','platform,platform_order_no'],
        ['procurement_payment_transactions','uk_procurement_payment_transaction','provider,external_no'],
        ['procurement_payment_matches','uk_procurement_payment_match_order','platform_order_id']
      ]) await query(`ALTER TABLE ${table} MODIFY tenant_id BIGINT UNSIGNED NULL, DROP INDEX ${index}, ADD UNIQUE INDEX ${index} (${columns})`);
      await query("INSERT INTO procurement_platform_orders(id,platform,platform_order_no,paid_amount) VALUES (1,'pdd','legacy',7)");
      await query("INSERT INTO procurement_payment_transactions(id,provider,external_no,amount) VALUES (1,'wechat','legacy',7)");
      await query("INSERT INTO procurement_payment_matches(platform_order_id,payment_transaction_id) VALUES (1,1)");
      assert.equal((await inspectProcurementImportOwnership(query)).tables[0].legacy_null_count, 1);
      await assert.rejects(migrateProcurementImportOwnership(query), /explicit/);
      await migrateProcurementImportOwnership(query, { assignLegacyDefault: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        await query("INSERT INTO procurement_platform_orders(platform,platform_order_no,paid_amount) VALUES ('pdd','old-writer',8) ON DUPLICATE KEY UPDATE paid_amount=VALUES(paid_amount)");
        await query("INSERT INTO procurement_payment_transactions(provider,external_no,amount) VALUES ('wechat','old-writer',8) ON DUPLICATE KEY UPDATE amount=VALUES(amount)");
      }
      assert.equal(Number((await query("SELECT COUNT(*) n FROM procurement_platform_orders WHERE platform_order_no='old-writer'"))[0].n), 1);
      assert.equal(Number((await query("SELECT COUNT(*) n FROM procurement_payment_transactions WHERE external_no='old-writer'"))[0].n), 1);
      for (const id of [2,3]) for (let attempt = 0; attempt < 2; attempt++) {
        await service.importProcurementPlatformOrdersMysql({ tenant_id: id === 2 ? 3 : 2, rows: [{ platform_order_no: 'same-external', paid_amount: id * 10, order_time: '2026-10-01 10:00:00' }] }, id, id);
        await reconciliation.importProcurementPayments({ rows: [{ external_no: 'same-external', amount: id * 10, transaction_time: '2026-10-01 10:00:00' }] }, id, id);
      }
      const orders = await query("SELECT id,tenant_id,paid_amount FROM procurement_platform_orders WHERE platform_order_no='same-external' ORDER BY tenant_id");
      const payments = await query("SELECT id,tenant_id,amount FROM procurement_payment_transactions WHERE external_no='same-external' ORDER BY tenant_id");
      assert.deepEqual(orders.map(row => [Number(row.tenant_id), Number(row.paid_amount)]), [[2,20],[3,30]]);
      assert.deepEqual(payments.map(row => [Number(row.tenant_id), Number(row.amount)]), [[2,20],[3,30]]);
      await assert.rejects(reconciliation.setProcurementPaymentMatch(orders[0].id, { payment_transaction_id: payments[1].id }, 2, 2), { statusCode: 404 });
      await reconciliation.setProcurementPaymentMatch(orders[0].id, { payment_transaction_id: payments[0].id }, 2, 2);
      assert.equal((await reconciliation.procurementReconciliation({}, 2)).total, 1);
      assert.equal((await reconciliation.procurementReconciliation({}, 'admin')).total, 2);
      const before = await query('SELECT COUNT(*) n FROM procurement_payment_matches');
      await assert.rejects(reconciliation.autoMatchProcurementPayments(999), { statusCode: 403 });
      assert.deepEqual(await query('SELECT COUNT(*) n FROM procurement_payment_matches'), before);
    });

    await t.test('default legacy inventory, manual outbound and direct receipt remain independent from A/B', async () => {
      await service.createInventoryMovementMysql({ product_id: legacy.id, quantity_delta: 10, source_type: 'opening_stock' }, 1, 'admin');
      await service.createInventoryMovementMysql({ product_id: products[3].id, quantity_delta: 20, source_type: 'opening_stock' }, 3, 3);
      const movement = await service.createInventoryMovementMysql({ product_id: legacy.id, quantity: 1, source_type: 'manual_outbound' }, 1, 'admin');
      assert.equal(Number((await service.productsMysql({}, 'admin')).find(row => row.id === legacy.id).stock), 9);
      await assert.rejects(service.updateInventoryMovementMysql(movement.id, { quantity: 2 }, 2, 2));
      const updated = await service.updateInventoryMovementMysql(movement.id, { quantity: 2 }, 1, 'admin');
      assert.equal(Number((await service.productsMysql({}, 'admin')).find(row => row.id === legacy.id).stock), 8);
      await service.deleteInventoryMovementMysql(updated.id, 1, 'admin');
      assert.equal(Number((await service.productsMysql({}, 'admin')).find(row => row.id === legacy.id).stock), 10);
      assert.equal(Number((await service.productsMysql({}, 3))[0].stock), 20);
      const direct = await service.createProcurementRequestMysql({ product_id: products[2].id, quantity: 2, amount: 20 }, 2, 2);
      await assert.rejects(service.directInboundProcurementRequestsMysql({ request_ids: [direct.id] }, 'admin', 1), { statusCode: 404 });
      const receipt = await service.directInboundProcurementRequestsMysql({ request_ids: [direct.id] }, 2, 2);
      assert.equal(receipt.count, 1);
      assert.equal(Number((await query('SELECT tenant_id FROM inbound_records WHERE id=?', [receipt.inbound_ids[0]]))[0].tenant_id), 2);
      assert.equal((await service.procurementSummaryMysql({}, 'admin')).length, 0);
      assert.equal((await service.purchaseCostVersionsMysql({}, 'admin')).total, 0);
      assert.equal((await service.pendingInboundItemsMysql({}, 'admin')).length, 0);
      await assert.rejects(service.procurementProductPurchaseHistoryMysql({ product_id: products[2].id }, 'admin'), { statusCode: 404 });
      const { procurementDailyReport } = await import('../src/services/procurement-daily-report.js');
      assert.equal((await procurementDailyReport({ dateFrom: '2020-01-01', dateTo: '2030-01-01' }, 'admin')).rows.length, 0);
      assert.ok((await procurementDailyReport({ dateFrom: '2020-01-01', dateTo: '2030-01-01' }, 2)).rows.length > 0);
    });

    await t.test('order procurement candidates and newly created requests never cross shops or companies', async () => {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES (20,2,'A-order','awaiting_packaging','awaiting_packaging','2026-10-01'),(30,3,'B-order','awaiting_packaging','awaiting_packaging','2026-10-01')");
      const mappings = await query('SELECT id,shop_id FROM sku_mappings ORDER BY shop_id');
      await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES (20,20,?,'A-SKU',1,100),(30,30,?,'B-SKU',1,100)", [mappings[0].id,mappings[1].id]);
      await assert.rejects(service.previewOrderProcurementMysql(30, 2), { statusCode: 404 });
      const preview = await service.previewOrderProcurementMysql(20, 2);
      assert.ok(!JSON.stringify(preview).includes('B-SKU'));
      const created = await service.createOrderProcurementRequestsMysql(20, { order_item_ids: [20], product_purchases: [{ product_id: products[2].id, quantity: 1, amount: 10 }] }, 2, 2);
      assert.ok(created.request_ids.length > 0);
      for (const id of created.request_ids) assert.equal(Number((await query('SELECT tenant_id FROM procurement_requests WHERE id=?', [id]))[0].tenant_id), 2);
      await assert.rejects(service.createOrderProcurementRequestsMysql(20, { order_item_ids: [30] }, 2, 2), { statusCode: 404 });
      await assert.rejects(service.orderProcurementBatchesMysql(30, 2), { statusCode: 404 });
      assert.ok(Array.isArray((await service.orderProcurementBatchesMysql(20, 2)).batches));
    });

    await t.test('workspace reads, grouping and numeric product sorting execute scoped SQL for all enterprises', async () => {
      for (const tenant of ['admin',2,3]) {
        for (const status of ['all','pending','purchased','pending_purchase']) {
          const workspace = await service.procurementRequestsMysql({ status, grouped: '1', page: 1, pageSize: 10 }, tenant);
          const text = JSON.stringify(workspace);
          assert.ok(!text.includes(tenant === 2 ? 'B operator' : tenant === 3 ? 'A operator' : 'A operator'));
        }
        for (const key of ['stock','incoming_stock','fbp_transfer_in_transit_qty','total_sales_quantity','total_sales_amount','order_count','total_purchase_amount','manual_outbound_quantity','manual_outbound_amount','avg_unit_cost','estimated_profit_total','actual_profit_total','profit_rate','inventory_value']) {
          const result = await service.productsMysql({ paged: '1', sortKey: key, sortDir: 'asc' }, tenant);
          const allowed = tenant === 'admin' ? [products[1].id,legacy.id] : [products[tenant].id];
          assert.deepEqual(result.rows.map(row => Number(row.id)).sort((a,b) => a-b), allowed.sort((a,b) => a-b), `${tenant}:${key}`);
        }
      }
    });
    await t.test('advanced demand, binding recommendations, cost history and receipt impact keep tenant ownership', async () => {
      const related = await service.createProductMysql({ name: 'A related product', owner_person_id: 2, created_by_person_id: 2 }, null, 2);
      const group = await query("INSERT INTO procurement_purchase_groups(name,source_type) VALUES('A bundle','1688')");
      await query('INSERT INTO procurement_purchase_group_items(group_id,product_id) VALUES(?,?),(?,?)', [group.insertId,products[2].id,group.insertId,related.id]);
      const poisonedGroup = await query("INSERT INTO procurement_purchase_groups(name,source_type) VALUES('Foreign private group','1688')");
      await query('INSERT INTO procurement_purchase_group_items(group_id,product_id) VALUES(?,?),(?,?)', [poisonedGroup.insertId,products[2].id,poisonedGroup.insertId,products[3].id]);
      const recommendations = await service.procurementPurchaseGroupRecommendationsMysql({ product_ids: String(products[2].id) }, 2);
      assert.deepEqual(recommendations.map(row => Number(row.product_id)), [related.id]);
      await assert.rejects(service.procurementPurchaseGroupRecommendationsMysql({ product_ids: String(products[3].id) }, 2));
      const suggestions = await service.procurementBindingSuggestionsMysql({ query: 'Product' }, 2);
      assert.ok(suggestions.length > 0);
      assert.ok(suggestions.every(row => [products[2].id,related.id].includes(Number(row.product_id))));

      const historical = await service.createProcurementRequestMysql({ product_id: products[2].id, quantity: 2, amount: 20, source_type: '1688', supplier_id: supplierA.id }, 2, 2);
      const purchase = await service.mergeProcurementRequestsMysql({ request_ids: [historical.id] }, 2, null, 2);
      await service.confirmPurchaseOrderMysql(purchase.id, {}, 2, null, 2);
      const item = (await query('SELECT id FROM purchase_order_items WHERE purchase_order_id=?',[purchase.id]))[0];
      const sourceKey = `purchase_order_item:${item.id}:purchased`;
      await query('DELETE FROM purchase_cost_versions WHERE tenant_id=2 AND source_key=?',[sourceKey]);
      const foreignVersion = await query("INSERT INTO purchase_cost_versions(tenant_id,product_id,source_key,version_no,quantity,amount,source_type) VALUES(3,?,?,1,2,999,'1688')", [products[3].id,sourceKey]);
      const foreignBefore = await query('SELECT * FROM purchase_cost_versions WHERE id=?',[foreignVersion.insertId]);
      assert.ok((await service.previewPurchaseCostBackfillMysql(2)).trusted_samples.some(row => row.source_key === sourceKey));
      assert.equal((await service.previewPurchaseCostBackfillMysql('admin')).summary.total_count, 0);
      const initialized = await service.initializePurchaseCostBackfillMysql({ confirm: true, tenant_id: 3 },2,2);
      assert.ok(initialized.created_count > 0);
      assert.equal((await service.initializePurchaseCostBackfillMysql({ confirm: true },2,2)).created_count, 0);
      assert.deepEqual(await query('SELECT * FROM purchase_cost_versions WHERE id=?',[foreignVersion.insertId]),foreignBefore);

      const inbound = (await query("SELECT id,quantity FROM inbound_records WHERE tenant_id=2 AND status='pending_arrival' ORDER BY id DESC LIMIT 1"))[0];
      const impactBody = { records: [{ id: inbound.id, receive_quantity: 1 }] };
      const before = await service.previewInboundReceiptImpactMysql(impactBody,2);
      const forgedMovement = await query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,status) VALUES(3,?,-9999,'order_outbound','posted')",[products[2].id]);
      assert.deepEqual(await service.previewInboundReceiptImpactMysql(impactBody,2),before);
      await query('DELETE FROM inventory_movements WHERE id=?',[forgedMovement.insertId]);
      await assert.rejects(service.previewInboundReceiptImpactMysql(impactBody,'admin'));
      await assert.rejects(service.previewShippedProcurementReceiptsMysql({ order_ids: [30] },2));
      await service.previewShippedProcurementReceiptsMysql({ order_ids: [20] },2);

      const foreignRequests = await query('SELECT * FROM procurement_requests WHERE tenant_id=3 OR tenant_id=1 OR tenant_id IS NULL ORDER BY id');
      const mapping = await query("INSERT INTO sku_mappings(tenant_id,shop_id,product_id,ozon_sku) VALUES(2,2,?,'A-RELATED')", [related.id]);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(21,2,'A recent sales','delivered',UTC_TIMESTAMP())");
      await query("INSERT INTO order_items(order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(21,?,'A-RELATED',10,100)",[mapping.insertId]);
      const aSession = { personId:2,tenant:{ id:2,slug:'a' } };
      await service.refreshProcurementDemandMysql(2,{ session:aSession });
      const warnings = await query("SELECT tenant_id,person_id,created_by_person_id FROM procurement_requests WHERE request_group_no LIKE 'AUTO-STOCK-%'");
      assert.ok(warnings.length > 0);
      assert.ok(warnings.every(row => Number(row.tenant_id) === 2 && row.created_by_person_id === null));
      assert.deepEqual(await query('SELECT * FROM procurement_requests WHERE tenant_id=3 OR tenant_id=1 OR tenant_id IS NULL ORDER BY id'),foreignRequests);
      await assert.rejects(service.refreshProcurementDemandMysql('admin',{session:aSession}),{statusCode:403});
      await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await assert.rejects(service.refreshProcurementDemandMysql(2,{session:aSession}),{statusCode:403});
    });
  } finally { await closeMysqlPool(); await fixture.cleanup(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { prepareProductMergeFixture, loadProductMergeFixture } from './helpers/tenant-product-merge-service.js';
import { productMergeReferenceKeyWhere } from '../src/services/product-merge-tenant-scope.js';

test('merge reference keys accept only the static complete key', () => {
  assert.throws(() => productMergeReferenceKeyWhere({ idColumn: 'id' }, { 'id OR 1=1': 2 }));
  assert.throws(() => productMergeReferenceKeyWhere({ idColumn: 'id' }, { id: -1 }));
  assert.throws(() => productMergeReferenceKeyWhere({ idColumn: ['date_key','shop_id','product_id'] }, { date_key:'2026-10-22',shop_id:2 }));
  assert.deepEqual(productMergeReferenceKeyWhere({ idColumn:'id' }, {id:2}, 'merge_ref'), {clause:'merge_ref.id = ?',params:[2]});
});

test('production merge/undo SQL isolates A, B, default and legacy NULL, including poisoned parent references', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires the explicit disposable MySQL socket', timeout:180000
}, async t => {
  const fixture = await createTenantMysqlFixture('product_merge');
  const {connection, query} = fixture;
  try {
    await prepareProductMergeFixture(connection);
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES(1,'Default actor','admin'),(2,'A actor','admin'),(3,'B actor','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(1,1,'Default'),(2,2,'A'),(3,3,'B'),(4,NULL,'Legacy')");
    const {service,followups} = loadProductMergeFixture(connection);
    await service.ensureProductMergeSchemaMysql();
    const session = tenant => ({personId:tenant,tenant:{id:tenant,slug:tenant===1?'default':tenant===2?'a':'b',role:'admin'},roles:['admin']});
    const options = tenant => ({session:session(tenant)});
    const insert = async(table, values) => {
      const names=Object.keys(values); const result=await query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,Object.values(values));
      return Number(result.insertId);
    };
    const products = {};
    for (const [id,tenant,name] of [[10,1,'Default target'],[11,null,'Default source'],[20,2,'A target'],[21,2,'A source'],[22,2,'A component'],[30,3,'B target'],[31,3,'B source'],[32,3,'B component']]) {
      await insert('products',{id,tenant_id:tenant,name,selection_status:'listed',owner_person_id:tenant||1,created_by_person_id:tenant||1}); products[id]=id;
    }
    const ownedRows=[], foreignRows=[];
    for (const shop of [2,3]) {
      const target=shop===2?20:30, source=21;
      const online=await insert('online_products',{shop_id:shop,ozon_sku:`merge-${shop}`,name:`online-${shop}`,product_id:source});
      const mapping=await insert('sku_mappings',{tenant_id:shop,shop_id:shop,product_id:source,online_product_id:online,ozon_sku:`merge-${shop}`});
      const po=await insert('purchase_orders',{tenant_id:shop,order_no:`merge-${shop}`});
      const poi=await insert('purchase_order_items',{tenant_id:shop,purchase_order_id:po,product_id:source,requested_quantity:2});
      const pr=await insert('procurement_requests',{tenant_id:shop,product_id:source,person_id:shop,quantity:2,amount:20,status:'approved',approval_status:'approved',purchase_order_id:po});
      const inbound=await insert('inbound_records',{tenant_id:shop,product_id:source,quantity:2,purchase_order_id:po,purchase_order_item_id:poi,procurement_request_id:pr});
      const outbound=await insert('outbound_records',{shop_id:shop,product_id:source,quantity:1});
      const movement=await insert('inventory_movements',{tenant_id:shop,shop_id:shop,product_id:source,quantity_delta:2,movement_type:'PURCHASE_IN',source_type:'manual',status:'posted'});
      const stock=await insert('ozon_stock_snapshots',{shop_id:shop,product_id:source,ozon_sku:`merge-${shop}`});
      const fbp=await insert('fbp_replenishment_orders',{shop_id:shop,order_no:`merge-${shop}`});
      const fbpi=await insert('fbp_replenishment_order_items',{shop_id:shop,order_id:fbp,product_id:source});
      const transfer=await insert('fbp_transfer_records',{shop_id:shop,product_id:source});
      const child=await insert('products',{tenant_id:shop,name:`child-${shop}`,parent_product_id:source});
      const component=await insert('product_components',{tenant_id:shop,product_id:target,component_product_id:source,quantity:3,component_role:'included'});
      const recipe=await insert('sku_inventory_recipes',{shop_id:shop,ozon_sku:`merge-${shop}`});
      const recipeItem=await insert('sku_inventory_recipe_items',{recipe_id:recipe,product_id:source,quantity:2});
      const rows=[['online_products',online],['sku_mappings',mapping],['purchase_order_items',poi],['procurement_requests',pr],['inbound_records',inbound],['outbound_records',outbound],['inventory_movements',movement],['ozon_stock_snapshots',stock],['fbp_replenishment_order_items',fbpi],['fbp_transfer_records',transfer]];
      (shop===2?ownedRows:foreignRows).push(...rows);
      if(shop===3)foreignRows.push(['products',child],['product_components',component],['sku_inventory_recipe_items',recipeItem]);
      else {
        // A's selected composition is source -> independent component, while
        // the target -> source pair above would otherwise become self-linked.
        await query('DELETE FROM product_components WHERE id=?',[component]);
        await insert('product_components',{tenant_id:2,product_id:21,component_product_id:22,quantity:4,component_role:'included'});
        await insert('sku_inventory_recipe_items',{recipe_id:recipe,product_id:20,quantity:3});
      }
      await insert('analytics_product_profit_daily',{date_key:'2026-10-22',shop_id:shop,product_id:source,revenue:shop*10});
      await insert('analytics_sku_profit_daily',{date_key:'2026-10-22',shop_id:shop,ozon_sku:`merge-${shop}`,product_id:source,revenue:shop*10});
    }
    // Own tenant marker with a foreign parent must still remain untouched.
    const badInbound=await insert('inbound_records',{tenant_id:2,product_id:21,quantity:99,purchase_order_id:2});
    foreignRows.push(['inbound_records',badInbound]);
    const badMapping=await insert('sku_mappings',{tenant_id:2,shop_id:3,product_id:21,ozon_sku:'corrupt-parent'});
    foreignRows.push(['sku_mappings',badMapping]);
    const pendingTarget=await insert('procurement_requests',{tenant_id:2,product_id:20,person_id:2,quantity:2,amount:20,shipping_amount:1,status:'pending',approval_status:'pending'});
    const pendingSource=await insert('procurement_requests',{tenant_id:2,product_id:21,person_id:2,quantity:3,amount:30,shipping_amount:2,status:'pending',approval_status:'pending'});
    ownedRows.push(['procurement_requests',pendingSource]);
    const snapshotForeign=async()=>JSON.stringify(await Promise.all(foreignRows.map(async([table,id])=>[table,id,await query(`SELECT * FROM ${table} WHERE id=?`,[id])])).then(async rows=>[...rows,await query('SELECT * FROM analytics_product_profit_daily WHERE shop_id=3'),await query('SELECT * FROM analytics_sku_profit_daily WHERE shop_id=3')]));
    let baseline = await snapshotForeign();
    const businessSnapshot=async()=>JSON.stringify(await Promise.all(['products','online_products','sku_mappings','purchase_order_items','procurement_requests','inbound_records','outbound_records','inventory_movements','ozon_stock_snapshots','fbp_replenishment_order_items','fbp_transfer_records','product_components','sku_inventory_recipe_items','product_merge_history','product_merge_history_refs','inventory_current','analytics_product_profit_daily','analytics_sku_profit_daily'].map(async table=>[table,await query(`SELECT * FROM ${table}`)])));
    let merged;
    await t.test('mixed-enterprise preview/merge and injected field sources reject without writes',async()=>{
      await assert.rejects(service.previewMergeProductsMysql({product_ids:[20,30]},2),{statusCode:404});
      await assert.rejects(service.mergeProductsMysql({product_ids:[20,30]},2,options(2)),{statusCode:404});
      await assert.rejects(service.mergeProductsMysql({product_ids:[20,21],field_sources:{name:30}},2,options(2)),{statusCode:400});
      await assert.rejects(service.mergeProductsMysql({product_ids:[20,21]},'admin',options(1)),{statusCode:404});
      assert.equal((await query('SELECT COUNT(*) n FROM product_merge_history'))[0].n,0);
      assert.equal(await snapshotForeign(),baseline);
    });
    await t.test('preview counts only owned references and never leaks corrupt foreign names',async()=>{
      const preview=await service.previewMergeProductsMysql({product_ids:[20,21]},2);
      assert.equal(preview.affected_counts.inbound_records.total,1);
      assert.equal(preview.affected_counts.sku_mappings.total,1);
      assert.deepEqual(Array.from(preview.products,row=>row.id),[20,21]);
    });
    await t.test('mid-transaction SQL failure rolls back history, all references and target/source edits',async()=>{
      const before=await businessSnapshot();
      await connection.query("CREATE TRIGGER fixture_merge_failure BEFORE UPDATE ON inventory_movements FOR EACH ROW BEGIN IF NEW.product_id=20 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture merge rollback'; END IF; END");
      try { await assert.rejects(service.mergeProductsMysql({product_ids:[20,21],target_product_id:20,composition_source_product_id:21},2,options(2)),/fixture merge rollback/); }
      finally { await connection.query('DROP TRIGGER fixture_merge_failure'); }
      assert.equal(await businessSnapshot(),before);
    });
    await t.test('A merge preserves owned references, stock, complete bundle and recipe arithmetic',async()=>{
      merged=await service.mergeProductsMysql({product_ids:[20,21],target_product_id:20,composition_source_product_id:21},2,options(2));
      for(const [table,id]of ownedRows)assert.equal(Number((await query(`SELECT product_id FROM ${table} WHERE id=?`,[id]))[0].product_id),20,table);
      assert.equal(Number((await query('SELECT parent_product_id FROM products WHERE name=?',['child-2']))[0].parent_product_id),20);
      assert.equal(Number((await query('SELECT quantity FROM product_components WHERE product_id=20 AND component_product_id=22'))[0].quantity),4);
      assert.equal(Number((await query('SELECT quantity FROM sku_inventory_recipe_items WHERE product_id=20'))[0].quantity),5);
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=20'))[0].available_stock),2);
      assert.equal(Number((await query('SELECT active FROM products WHERE id=21'))[0].active),0);
      assert.equal(Number((await query('SELECT quantity FROM procurement_requests WHERE id=?',[pendingTarget]))[0].quantity),5);
      assert.equal((await query('SELECT status FROM procurement_requests WHERE id=?',[pendingSource]))[0].status,'merged');
      assert.equal(await snapshotForeign(),baseline);
      assert.equal(followups.find(row=>row[0]==='outbound')[1].tenantId,2);
    });
    await t.test('history and undo are enterprise scoped; changed post-merge data cannot be overwritten',async()=>{
      assert.equal((await service.productMergeHistoryMysql({},3)).length,0);
      assert.equal((await service.productMergeHistoryMysql({},'admin')).length,0);
      assert.equal((await service.productMergeHistoryMysql({},2)).length,1);
      await assert.rejects(service.undoMergeProductHistoryMysql(merged.merge_history_id,3,options(3)),{statusCode:404});
      const beforeUndo=await businessSnapshot();
      await connection.query("CREATE TRIGGER fixture_undo_failure BEFORE UPDATE ON products FOR EACH ROW BEGIN IF OLD.id=21 AND NEW.active=1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture undo rollback'; END IF; END");
      try { await assert.rejects(service.undoMergeProductHistoryMysql(merged.merge_history_id,2,options(2)),/fixture undo rollback/); }
      finally { await connection.query('DROP TRIGGER fixture_undo_failure'); }
      assert.equal(await businessSnapshot(),beforeUndo);
      await query('UPDATE sku_inventory_recipe_items SET quantity=6 WHERE product_id=20');
      await assert.rejects(service.undoMergeProductHistoryMysql(merged.merge_history_id,2,options(2)),{statusCode:409});
      assert.equal(Number((await query('SELECT active FROM products WHERE id=21'))[0].active),0);
      await query('UPDATE sku_inventory_recipe_items SET quantity=5 WHERE product_id=20');
    });
    await t.test('undo restores original owned references, bundle/recipe rows and product availability atomically',async()=>{
      await service.undoMergeProductHistoryMysql(merged.merge_history_id,2,options(2));
      for(const [table,id]of ownedRows)assert.equal(Number((await query(`SELECT product_id FROM ${table} WHERE id=?`,[id]))[0].product_id),21,table);
      assert.equal(Number((await query('SELECT quantity FROM product_components WHERE product_id=21 AND component_product_id=22'))[0].quantity),4);
      assert.deepEqual((await query('SELECT product_id,quantity FROM sku_inventory_recipe_items WHERE recipe_id=1 ORDER BY product_id')).map(row=>[Number(row.product_id),Number(row.quantity)]),[[20,3],[21,2]]);
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=21'))[0].available_stock),2);
      assert.equal(Number((await query('SELECT active FROM products WHERE id=21'))[0].active),1);
      assert.deepEqual((await query('SELECT quantity,amount,shipping_amount,status FROM procurement_requests WHERE id IN (?,?) ORDER BY id',[pendingTarget,pendingSource])).map(row=>[Number(row.quantity),Number(row.amount),Number(row.shipping_amount),row.status]),[[2,20,1,'pending'],[3,30,2,'pending']]);
      assert.equal(await snapshotForeign(),baseline);
    });
    await t.test('malformed/foreign stored recovery references fail before writing and revoked member cannot merge',async()=>{
      const result=await service.mergeProductsMysql({product_ids:[20,21],target_product_id:20,composition_source_product_id:21},2,options(2));
      const [reference]=await query('SELECT * FROM product_merge_history_refs WHERE merge_history_id=? AND table_key=? LIMIT 1',[result.merge_history_id,'online_products']);
      const key=typeof reference.ref_key_json==='string'?reference.ref_key_json:JSON.stringify(reference.ref_key_json);
      await query('UPDATE product_merge_history_refs SET ref_key_json=CAST(? AS JSON) WHERE id=?',[JSON.stringify({'id OR 1=1':1}),reference.id]);
      const before=await businessSnapshot();
      await assert.rejects(service.undoMergeProductHistoryMysql(result.merge_history_id,2,options(2)),{statusCode:409});
      assert.equal(await businessSnapshot(),before);
      await query('UPDATE product_merge_history_refs SET ref_key_json=CAST(? AS JSON) WHERE id=?',[key,reference.id]);
      await query('UPDATE product_merge_history_refs SET ref_key_json=JSON_OBJECT(\'id\',?) WHERE id=?',[foreignRows.find(row=>row[0]==='online_products')[1],reference.id]);
      const beforeForeign=await businessSnapshot();
      await assert.rejects(service.undoMergeProductHistoryMysql(result.merge_history_id,2,options(2)),{statusCode:409});
      assert.equal(await businessSnapshot(),beforeForeign);
      await query('UPDATE product_merge_history_refs SET ref_key_json=CAST(? AS JSON) WHERE id=?',[key,reference.id]);
      await service.undoMergeProductHistoryMysql(result.merge_history_id,2,options(2));
      await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      const beforeRevoked=await businessSnapshot();
      await assert.rejects(service.mergeProductsMysql({product_ids:[20,21]},2,options(2)),{statusCode:403});
      assert.equal(await businessSnapshot(),beforeRevoked);
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      assert.equal(await snapshotForeign(),baseline);
    });
    await t.test('B also merges and restores its own products without changing A or historical corrupt rows',async()=>{
      const aBefore=JSON.stringify(await query('SELECT id,active,parent_product_id,name FROM products WHERE tenant_id=2 ORDER BY id'));
      const movement=await insert('inventory_movements',{tenant_id:3,product_id:31,quantity_delta:8,movement_type:'PURCHASE_IN',source_type:'manual',status:'posted'});
      const result=await service.mergeProductsMysql({product_ids:[30,31],target_product_id:30},3,options(3));
      assert.equal(Number((await query('SELECT product_id FROM inventory_movements WHERE id=?',[movement]))[0].product_id),30);
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=30'))[0].available_stock),8);
      await service.undoMergeProductHistoryMysql(result.merge_history_id,3,options(3));
      assert.equal(Number((await query('SELECT product_id FROM inventory_movements WHERE id=?',[movement]))[0].product_id),31);
      assert.equal(JSON.stringify(await query('SELECT id,active,parent_product_id,name FROM products WHERE tenant_id=2 ORDER BY id')),aBefore);
      assert.equal(await snapshotForeign(),baseline);
    });
    await t.test('default plus NULL merge/undo never touches A/B and rejects foreign histories',async()=>{
      const aBefore=JSON.stringify(await query('SELECT id,active,parent_product_id,name FROM products WHERE tenant_id=2 ORDER BY id'));
      const nullMove=await insert('inventory_movements',{tenant_id:null,product_id:11,quantity_delta:7,movement_type:'PURCHASE_IN',source_type:'manual',status:'posted'});
      const defaultMove=await insert('inventory_movements',{tenant_id:1,product_id:11,quantity_delta:3,movement_type:'PURCHASE_IN',source_type:'manual',status:'posted'});
      const result=await service.mergeProductsMysql({product_ids:[10,11],target_product_id:10},'admin',options(1));
      assert.deepEqual((await query('SELECT product_id FROM inventory_movements WHERE id IN (?,?)',[nullMove,defaultMove])).map(row=>Number(row.product_id)),[10,10]);
      assert.equal(Number((await query('SELECT available_stock FROM inventory_current WHERE real_product_id=10'))[0].available_stock),10);
      await service.undoMergeProductHistoryMysql(result.merge_history_id,'admin',options(1));
      assert.deepEqual((await query('SELECT product_id FROM inventory_movements WHERE id IN (?,?)',[nullMove,defaultMove])).map(row=>Number(row.product_id)),[11,11]);
      assert.equal(JSON.stringify(await query('SELECT id,active,parent_product_id,name FROM products WHERE tenant_id=2 ORDER BY id')),aBefore);
      assert.equal(await snapshotForeign(),baseline);
    });
  } finally { await fixture.cleanup(); }
});

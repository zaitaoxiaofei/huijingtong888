import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import os from 'node:os';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {CONFIRMED_COSTS} from '../scripts/repair-confirmed-order-costs.mjs';
const exec=promisify(execFile);
test('real isolated repair preserves old revisions and unrelated freight, rejects stale previews, applies exact cost deltas', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000},async()=>{
 const f=await createTenantMysqlFixture('confirmed_cost'),q=f.query,tmp=await fs.mkdtemp(path.join(os.tmpdir(),'confirmed-cost-'));
 try{
  await q('ALTER TABLE order_items ADD COLUMN frozen_logistics_rule_id BIGINT NULL');
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','A'),(2,'foreign','B')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(1,1,'A'),(2,2,'B')");
  let n=0;for(const [id]of Object.entries(CONFIRMED_COSTS)){
   await q('INSERT INTO products(id,tenant_id,name,purchase_cost)VALUES(?,1,?,0)',[id,'cost-'+id]);
   await q('INSERT INTO sku_mappings(id,shop_id,product_id,ozon_sku)VALUES(?,1,?,?)',[++n,id,'sku'+id]);
  }
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at)VALUES(10,1,'1-2-1','delivered','2026-10-01'),(11,2,'1-2-1','delivered','2026-10-01')");
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price,estimated_profit,frozen_international_shipping)VALUES(100,10,1,'sku229',2,100,50,5),(101,11,1,'sku229',1,100,70,7)");
  await q("INSERT INTO order_profit_items(order_item_id,purchase_cost_cny,net_profit_cny,gross_profit_cny,profit_status)VALUES(100,0,50,55,'estimated'),(101,0,70,75,'estimated')");
  const input=path.join(tmp,'scope.json');await fs.writeFile(input,JSON.stringify({tenant_id:1,order_ids:[10],reference:'user confirmation'}));
  const env={...process.env,...f.env};const script=path.resolve('scripts/repair-confirmed-order-costs.mjs');
  const preview=()=>exec(process.execPath,[script,'--scope='+input,'--output-dir='+tmp],{env});
  await preview();let plan=JSON.parse(await fs.readFile(path.join(tmp,'cost-preview.json')));
  assert.equal((await q('SELECT * FROM order_profit_calc_revisions')).length,0,'preview does not create baselines');
  await q('UPDATE order_items SET estimated_profit=51 WHERE id=100');
  await assert.rejects(exec(process.execPath,[script,'--scope='+input,'--output-dir='+tmp,'--apply','--approved-hash='+plan.hash],{env}),/changed/);
  assert.equal(Number((await q('SELECT purchase_cost FROM products WHERE id=229'))[0].purchase_cost),0);
  await q('UPDATE order_items SET estimated_profit=50 WHERE id=100');await preview();plan=JSON.parse(await fs.readFile(path.join(tmp,'cost-preview.json')));
  await exec(process.execPath,[script,'--scope='+input,'--output-dir='+tmp,'--apply','--approved-hash='+plan.hash],{env});
  const [row]=await q('SELECT * FROM order_items WHERE id=100');assert.equal(Number(row.estimated_profit),20);assert.equal(Number(row.frozen_purchase_cost),15);assert.equal(Number(row.frozen_international_shipping),5);
  assert.equal(Number((await q('SELECT estimated_profit FROM order_items WHERE id=101'))[0].estimated_profit),70);
  const revisions=await q('SELECT * FROM order_profit_calc_revisions ORDER BY revision_no');assert.equal(revisions.length,2);assert.equal(revisions[0].source,'legacy_baseline');assert.equal(Number(JSON.parse(revisions[0].outputs_json).estimated_profit),50);assert.equal(revisions[1].source,'user_confirmed_purchase_cost');
  assert.equal((await q('SELECT * FROM inventory_flow_events')).length,8);
 }finally{await f.cleanup();await fs.rm(tmp,{recursive:true,force:true});}
});

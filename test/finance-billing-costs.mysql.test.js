import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('billing cost CRUD preserves source costs, isolates tenants, rejects stale edits and reverses expenses exactly once',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const f=await createTenantMysqlFixture('billing_cost');let pool,close;
 try{
  f.useEnvironment();const q=f.query;const {ensureFinanceCenterSchema,saveFinanceExpense,deleteFinanceExpense}=await import('../src/services/finance-center.js');({closeMysqlPool:close}=await import('../src/mysql-pool.js'));await ensureFinanceCenterSchema();
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
  await q("INSERT INTO people(id,name,role) VALUES(10,'Owner','admin')");
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A','active'),(30,3,'B','active')");
  await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'A'),(30,3,'B')");
  await q("INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(2,20,20,'2026-01-01'),(3,30,30,'2026-01-01')");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(20,20,'A-20','delivered','2026-10-01 16:05:00'),(30,30,'B-30','delivered','2026-10-02')");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,frozen_domestic_shipping,frozen_handling_fee) VALUES(20,20,'sku-a',2,5,2),(30,30,'sku-b',1,50,20)");
  pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,dateStrings:true,connectionLimit:4});const query=async(sql,p=[])=>(await pool.execute(sql,p))[0];
  const {createFinanceBillingCosts}=await import('../src/services/finance-billing-costs.js');const s=createFinanceBillingCosts({query,execute:query,ensureFinance:async()=>{},transaction:async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const r=await fn(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}}});
  const owner={personId:10,tenant:{id:2,slug:'a',role:'owner'}},foreign={...owner,tenant:{id:3,slug:'b',role:'owner'}};
  const body={order_id:20,company_id:20,field:'domestic_shipping_cost',expected_base:10,expected_revision:0,amount:8,reason:'核对实际运费'};
  const first=await s.save(body,owner);assert.equal(first.delta,-2);
  const [expense]=await q("SELECT *,DATE_FORMAT(expense_date,'%Y-%m-%d') date_key FROM finance_expenses WHERE source_type='billing_cost_adjustment'");assert.equal(Number(expense.amount_cny),-2);assert.equal(expense.date_key,'2026-10-02');
  await assert.rejects(s.save(body,owner),{statusCode:409});await assert.rejects(s.save(body,foreign),{statusCode:404});await assert.rejects(s.save({...body,expected_base:9,expected_revision:1},owner),{statusCode:409});
  await assert.rejects(saveFinanceExpense({id:expense.id,company_id:20,expense_date:'2026-10-02',original_amount:3},10,'2'),{statusCode:409});await assert.rejects(deleteFinanceExpense(expense.id,'2'),{statusCode:409});
  const changed=await s.save({...body,expected_revision:1,amount:0,reason:'删除费用'},owner);assert.equal(changed.delta,-10);assert.equal((await q("SELECT COUNT(*) n FROM finance_expenses WHERE source_type='billing_cost_adjustment'"))[0].n,1);
  await s.save({...body,expected_revision:2,action:'restore',reason:'删除更正，恢复来源'},owner);assert.equal((await q("SELECT COUNT(*) n FROM finance_expenses WHERE source_type='billing_cost_adjustment'"))[0].n,0);
  assert.equal((await q('SELECT COUNT(*) n FROM finance_billing_cost_revisions'))[0].n,3);assert.equal(Number((await q('SELECT frozen_domestic_shipping amount FROM order_items WHERE id=20'))[0].amount),5);
  const results=await Promise.allSettled([s.save(body,owner),s.save({...body,amount:7},owner)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  for(const category of ['domestic_shipping','packaging','ai_subscription','rent','utilities','office','bank','withdrawal']){
    const created=await saveFinanceExpense({company_id:20,expense_date:'2026-10-03',category,description:'费用CRUD验证',original_amount:10,amount_cny:10},10,'2');
    await saveFinanceExpense({id:created.id,company_id:20,expense_date:'2026-10-03',category,description:'修改后',original_amount:12,amount_cny:12},10,'2');
    assert.equal(Number((await q('SELECT amount_cny FROM finance_expenses WHERE id=?',[created.id]))[0].amount_cny),12);
    await deleteFinanceExpense(created.id,'2');assert.equal((await q('SELECT COUNT(*) n FROM finance_expenses WHERE id=?',[created.id]))[0].n,0);
  }
  const orderFee=await s.save({...body,field:'other_fee',expected_base:0,amount:2},owner);assert.equal(orderFee.delta,2);
  await s.save({...body,field:'other_fee',expected_base:0,expected_revision:1,action:'restore'},owner);
  await q("UPDATE finance_periods SET status='closed' WHERE company_id=20 AND month_key='2026-10'");await assert.rejects(s.save({...body,field:'packaging_cost',expected_base:4,amount:3},owner),{statusCode:409});
  await assert.rejects(saveFinanceExpense({company_id:20,expense_date:'2026-10-03',category:'rent',original_amount:10},10,'2'),{statusCode:409});
 }finally{await pool?.end();await close?.();await f.cleanup();}
});

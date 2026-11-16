import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createCompanyFinanceDocuments} from '../src/services/company-finance-documents.js';
import {parseFinanceDocument} from '../src/services/finance-document-parser.js';

test('real MySQL reconciliation: source confirmation, A/B isolation, stale preview rollback, explicit atomic confirmation, retry, close and immutable V1', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const fixture=await createTenantMysqlFixture('finance_recon');const q=fixture.query;
 try{
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'a','A','active'),(3,'b','B','active')");
  await q("INSERT INTO finance_companies(id,tenant_id,name,tax_number) VALUES(20,2,'A','91340111MAK9U23Y8K'),(30,3,'B','91340111MAK9U23Y8K')");
  await q("INSERT INTO shops(id,tenant_id,name) VALUES(200,2,'Z'),(300,3,'Foreign')");
  await q("INSERT INTO finance_shop_company_assignments(tenant_id,company_id,shop_id,effective_from) VALUES(2,20,200,'2026-01-01'),(3,30,300,'2026-01-01')");
  await q("INSERT INTO orders(id,shop_id,posting_number,ordered_at,status) VALUES(1001,200,'12345678-0001-1','2026-07-20','delivered'),(1002,200,'12345678-0002-1','2026-08-01','delivered'),(1003,300,'12345678-0001-1','2026-07-20','delivered')");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,frozen_purchase_cost,settlement_state) VALUES(1101,1001,'123456',1,10,2,'pending'),(1102,1002,'123457',1,53,2,'pending'),(1103,1003,'123456',1,999,2,'pending')");
  await q("INSERT INTO order_profit_items(order_item_id,sale_amount_cny,net_profit_cny,profit_status,is_locked,lock_reason) VALUES(1101,10,8,'accrued',1,'finance_accrued'),(1102,53,40,'accrued',1,'finance_accrued')");
  const component=(amount,partner=0)=>({amount,quantity:1,stars:partner,bank_coinvestment:0,pick_up_point_coinvestment:0,bonus:0,standard_fee:1});
  const source={header:{number:'12345',receiver_inn:'91340111MAK9U23Y8K',currency_sys_name:'CNY',start_date:'2026-08-01',stop_date:'2026-08-31'},rows:[{row_number:1,item:{sku:123456},order:{posting_number:'12345678-0001-1'},delivery_commission:component(10),return_commission:component(10)},{row_number:2,item:{sku:123457},order:{posting_number:'12345678-0002-1'},delivery_commission:component(.08,50.27),return_commission:null}]};
  const raw=Buffer.from(JSON.stringify(source)),files=new Map([['/uploads/team-attachments/orders.json',{row:{original_name:'orders.json'},buffer:raw}],['/uploads/team-attachments/monthly.xlsx',{row:{original_name:'monthly.xlsx'},buffer:Buffer.from('monthly fixture')}]]);
  const a={personId:10,roles:['operations'],tenant:{id:2,slug:'a',role:'owner'}},b={...a,tenant:{id:3,slug:'b',role:'owner'}};
  const service=createCompanyFinanceDocuments({query:q,execute:q,authorize:async s=>s,files:{owned:async(url,s)=>{assert.equal(s.tenant.id,2);assert.ok(files.has(url));},read:async url=>files.get(url)},parse:async(buffer,name,options)=>name.endsWith('.json')?parseFinanceDocument(buffer,name,options):{kind:'sales',facts:[{metric:'已确认商品销售额',amount:10.08,currency:'CNY'},{metric:'销售退回冲减额',amount:10,currency:'CNY'},{metric:'合作伙伴补贴收入',amount:50.27,currency:'CNY'}],cash:[],warnings:[],controls:[]},transaction:async worker=>{await fixture.connection.beginTransaction();try{const result=await worker({query:q,execute:q});await fixture.connection.commit();return result;}catch(e){await fixture.connection.rollback();throw e;}}});
  const scope={company_id:20,shop_id:200,month:'2026-08'};
  const supporting=await service.preview({...scope,upload_type:'support',attachment_url:'/uploads/team-attachments/orders.json'},a);await service.confirm({company_id:20,document_id:supporting.document.id},a);
  const upload=await service.preview({...scope,upload_type:'order-sales',attachment_url:'/uploads/team-attachments/orders.json'},a);assert.equal(upload.document.id,supporting.document.id);assert.equal(upload.reclassified,true);assert.equal(upload.document.payload_json.classification_history[0].payload.kind,'support');
  assert.equal((await service.reconcile(scope,a)).rows.length,0);await service.confirm({company_id:20,document_id:upload.document.id},a);
  const monthly=await service.preview({...scope,attachment_url:'/uploads/team-attachments/monthly.xlsx'},a);await service.confirm({company_id:20,document_id:monthly.document.id},a);
  assert.equal((await service.preview({...scope,upload_type:'order-sales',attachment_url:'/uploads/team-attachments/orders.json'},a)).duplicate,true);
  const wrongShared=await service.preview({...scope,shop_id:0,upload_type:'auto',attachment_url:'/uploads/team-attachments/orders.json'},a);assert.equal(wrongShared.document.parse_status,'error');
  const original=await q('SELECT * FROM order_profit_items WHERE order_item_id IN (1101,1102) ORDER BY order_item_id');
  let report=await service.reconcile(scope,a);assert.equal(report.rows.length,2);assert.equal(report.summary.net_revenue,50.35);assert.ok(report.rows.every(r=>r.baseline.order_ids.every(id=>id!==1003)));
  await assert.rejects(service.reconcile(scope,b),{statusCode:404});await assert.rejects(service.reconcile({...scope,shop_id:300},a),{statusCode:403});
  const preview=await service.calibrationPreview({...scope,row_keys:report.rows.map(r=>r.key)},a),rows=preview.rows.map(({key,token})=>({key,token}));
  await assert.rejects(service.calibrationConfirm({...scope,rows,reason:'核对官方报告',acknowledge:false},a),/勾选/);
  // A background calculation changes the second row after the operator previews.
  await q('UPDATE order_profit_items SET sale_amount_cny=54 WHERE order_item_id=1102');
  await assert.rejects(service.calibrationConfirm({...scope,rows,reason:'核对官方报告',acknowledge:true},a),/重新预览/);assert.equal((await q('SELECT * FROM finance_reconciliation_adjustments')).length,0);
  await q('UPDATE order_profit_items SET sale_amount_cny=53 WHERE order_item_id=1102');
  const confirmed=await service.calibrationConfirm({...scope,rows,reason:'已核对月报及官方逐单销售凭证',acknowledge:true},a);assert.equal(confirmed.adjustment_ids.length,2);
  assert.deepEqual(await q('SELECT * FROM order_profit_items WHERE order_item_id IN (1101,1102) ORDER BY order_item_id'),original);
  report=await service.reconcile(scope,a);assert.equal(report.summary.adjusted_rows,2);assert.ok(report.rows.every(r=>!r.can_adjust&&!r.stale));assert.equal(report.history.length,2);
  const retry=await service.calibrationConfirm({...scope,rows,reason:'已核对月报及官方逐单销售凭证',acknowledge:true},a);assert.equal(retry.reused,2);assert.equal((await q('SELECT * FROM finance_reconciliation_adjustments')).length,2);
  const hash=crypto.createHash('sha256').update(raw).digest('hex');assert.ok(report.rows.every(r=>r.sources.some(s=>s.sha256===hash)));
  await q("UPDATE finance_periods SET status='closed' WHERE company_id=20 AND month_key='2026-08'");
  await assert.rejects(service.calibrationConfirm({...scope,rows,reason:'已核对月报及官方逐单销售凭证',acknowledge:true},a),/已关账/);
 }finally{await fixture.cleanup();}
});

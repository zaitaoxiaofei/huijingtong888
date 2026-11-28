import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import {parseFinanceDocument} from '../src/services/finance-document-parser.js';
import {reconcileFinanceOrders} from '../src/services/finance-reconciliation.js';
import {reconcileImportedCash,createCompanyFinanceDocuments} from '../src/services/company-finance-documents.js';
import ExcelJS from 'exceljs';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';

export const component=(amount,quantity=1,partner=0,bonus=0)=>({amount,quantity,stars:partner,bank_coinvestment:0,pick_up_point_coinvestment:0,bonus,standard_fee:2});
export const source=(rows)=>({header:{number:'12345',receiver_inn:'91340111MAK9U23Y8K',currency_sys_name:'CNY',start_date:'2026-08-01',stop_date:'2026-08-31'},rows});
export const sourceRow=(row_number=1,posting_number='12345678-0001-1',sku=123456,sold=component(10),returned=null)=>({row_number,item:{sku},order:{posting_number},delivery_commission:sold,return_commission:returned});
export async function fixtureDocs(){const p=await parseFinanceDocument(Buffer.from(JSON.stringify(source([sourceRow(1,undefined,undefined,component(10),component(10))]))),'official.json',{month:'2026-08'});return [{id:1,shop_key:200,month_key:'2026-08',parse_status:'confirmed',sha256:'a'.repeat(64),original_name:'逐单.json',attachment_url:'/uploads/team-attachments/a.json',payload_json:p},{id:2,shop_key:200,month_key:'2026-08',parse_status:'confirmed',sha256:'b'.repeat(64),original_name:'月报.xlsx',attachment_url:'/uploads/team-attachments/b.xlsx',payload_json:{kind:'sales',facts:[{metric:'已确认商品销售额',amount:10},{metric:'销售退回冲减额',amount:10},{metric:'合作伙伴补贴收入',amount:0}]}}];}
const items=[{order_id:1,item_id:11,posting_number:'12345678-0001-1',ozon_sku:'123456',quantity:1,sale_price:10,sale_amount_cny:10,order_status:'delivered',settlement_state:'pending',ordered_month:'2026-07',frozen_purchase_cost:2}];
test('official CNY parser retains signed sale/refund and separate partner and bonus, rejecting missing values and wrong month/currency',async()=>{
 const s=source([sourceRow(1,undefined,undefined,component(.08,1,50.27,2.65))]);const parsed=await parseFinanceDocument(Buffer.from(JSON.stringify(s)),'official.json',{month:'2026-08'});assert.equal(parsed.kind,'order-sales');assert.equal(parsed.order_rows[0].sold,.08);assert.equal(parsed.order_rows[0].partner,50.27);assert.equal(parsed.order_rows[0].bonus,2.65);assert.deepEqual(parsed.facts,[]);
 for(const mutate of [s=>s.header.currency_sys_name='RUB',s=>s.header.stop_date='2026-09-30',s=>delete s.rows[0].delivery_commission.bank_coinvestment,s=>s.rows.push(s.rows[0])]){const broken=structuredClone(s);mutate(broken);await assert.rejects(parseFinanceDocument(Buffer.from(JSON.stringify(broken)),'bad.json',{month:'2026-08'}));}
});
test('cross-month order matches, full refund becomes zero, monthly controls gate confirmation; overlapping exports do not add amounts',async()=>{
 const docs=await fixtureDocs(),r=reconcileFinanceOrders({documents:docs,items,month:'2026-08'});assert.equal(r.summary.net_revenue,0);assert.equal(r.rows[0].difference,-10);assert.equal(r.rows[0].target.business_outcome,'refunded');assert.equal(r.rows[0].can_adjust,true);assert.equal(r.rows[0].sources[0].document_id,1);
 const duplicate={...docs[0],id:3};const twice=reconcileFinanceOrders({documents:[...docs,duplicate],items,month:'2026-08'});assert.equal(twice.summary.sales,10);assert.equal(twice.duplicates.length,1);assert.equal(twice.rows[0].sources.length,2);
 const conflict=structuredClone(duplicate);conflict.payload_json.order_rows[0].sold=12;const bad=reconcileFinanceOrders({documents:[...docs,conflict],items,month:'2026-08'});assert.equal(bad.conflicts.length,1);assert.equal(bad.rows[0].can_adjust,false);
 const missing=reconcileFinanceOrders({documents:[docs[0]],items,month:'2026-08'});assert.equal(missing.rows[0].can_adjust,false);assert.ok(missing.gaps.some(g=>g.code==='monthly_sales'));
 const unmatched=reconcileFinanceOrders({documents:docs,items:[],month:'2026-08'});assert.equal(unmatched.rows[0].can_adjust,false);assert.equal(unmatched.rows[0].difference,null);
});
test('multiple legitimate SKU lines are summed within one report; missing costs and empty months never become final zero profit',async()=>{
 const docs=await fixtureDocs();docs[0].payload_json.order_rows.push({...docs[0].payload_json.order_rows[0],row_number:2});const r=reconcileFinanceOrders({documents:docs,items,month:'2026-08'});assert.equal(r.summary.sales,20);assert.equal(r.summary.complete_controls,false);
 const empty=reconcileFinanceOrders({documents:[],items:[],month:'2026-08'});assert.equal(empty.summary.sales,null);assert.equal(empty.summary.final_profit,null);
});
test('commission refunds and bonus reduce cost, never inflate sales; a contradictory commission voucher blocks calibration',async()=>{
 const docs=await fixtureDocs();docs.push({id:3,month_key:'2026-08',parse_status:'confirmed',original_name:'佣金.pdf',payload_json:{kind:'platform-invoice',facts:[{metric:'佣金',amount:0,currency:'CNY'}]}});
 let r=reconcileFinanceOrders({documents:docs,items,month:'2026-08'});assert.equal(r.summary.commission,0);assert.equal(r.summary.complete_controls,true);
 docs[2].payload_json.facts[0].amount=1;r=reconcileFinanceOrders({documents:docs,items,month:'2026-08'});assert.equal(r.summary.complete_controls,false);assert.equal(r.rows[0].can_adjust,false);
 const sale=component(.08,1,50.27,2.65);sale.standard_fee=5.83;
 const parsed=await parseFinanceDocument(Buffer.from(JSON.stringify(source([sourceRow(1,undefined,undefined,sale)]))),'official.json',{month:'2026-08'});docs[0].payload_json=parsed;
 r=reconcileFinanceOrders({documents:[docs[0]],items,month:'2026-08'});assert.equal(r.rows[0].target.net_revenue,50.35);assert.equal(r.rows[0].target.commission_fee,3.18);
});
test('calibrated snapshot compares canonically after MySQL JSON key reordering and invalidates a changed baseline',async()=>{
 const docs=await fixtureDocs(),row=reconcileFinanceOrders({documents:docs,items,month:'2026-08'}).rows[0];
 // Confirmed effective values are stable despite database object ordering.
 const after=Object.fromEntries(Object.entries(row.target).reverse());
 const history=[{id:8,row_key:row.key,after_json:after,before_json:{baseline_hash:'obsolete'}}];
 assert.equal(reconcileFinanceOrders({documents:docs,items,history,month:'2026-08'}).rows[0].stale,true);
});
test('overlapping LianLian exports deduplicate by transaction identity; conflicting records leave currency totals unknown',()=>{
 const entry={type:'entry',date:'2026-08-24 18:51',reference:'entry-1',currency:'CNH',amount:100};const withdrawal={type:'withdrawal',date:'2026-08-24 21:33',reference:'withdraw-1',currency:'CNH',amount:100,fee:1,listed_bank_amount:99,listed_bank_currency:'CNY'};
 const doc=(id,cash)=>({id,parse_status:'confirmed',shop_key:0,month_key:'2026-11',payload_json:{cash,facts:[]}});
 const r=reconcileImportedCash([doc(1,[entry,withdrawal]),doc(2,[entry,withdrawal])],{from:'2026-08',to:'2026-08'});assert.equal(r.currencies[0].entries,100);assert.equal(r.currencies[0].fees,1);assert.equal(r.duplicates.length,2);
 const bad=reconcileImportedCash([doc(1,[withdrawal]),doc(2,[{...withdrawal,fee:2}])],{from:'2026-08',to:'2026-08'});assert.equal(bad.conflicts.length,1);assert.equal(bad.currencies[0].fees,null);
 const distinct=reconcileImportedCash([doc(1,[entry,{...entry,reference:'entry-2'}])],{from:'2026-08',to:'2026-08'});assert.equal(distinct.currencies[0].entries,200);
});
test('new reconciliation UI compiles and exposes explicit confirmation, source links and history',()=>{
 const filename='frontend/admin/views/finance/FinanceReconciliation.vue',source=readFileSync(filename,'utf8'),{descriptor}=parse(source,{filename});const script=compileScript(descriptor,{id:'reconciliation'});const template=compileTemplate({source:descriptor.template.content,filename,id:'reconciliation',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);assert.match(source,/确认调整并留存历史/);assert.match(source,/acknowledge/);assert.match(source,/attachment_url/);
});
test('new finance endpoints retain membership and finance role gates',()=>{
 const s={personId:10,role:'admin',roles:['admin'],tenant:{id:2,slug:'customer',role:'owner',plan_code:'pro',subscription_status:'active'}};
 for(const [method,path]of [['GET','document-adjustments'],['GET','document-reconciliation'],['POST','document-calibration'],['POST','order-sales-source']]){
  const parts=['api','finance-center',path];assert.equal(authorizeApiRequest({method,_session:s},parts).allowed,true);assert.equal(tenantIsolationDecision(s,parts,method).allowed,true);
  const member={...s,role:'operations',roles:['operations'],tenant:{...s.tenant,role:'member'}};assert.equal(authorizeApiRequest({method,_session:member},parts).allowed,false);
 }
});
test('reading an official source rechecks owned shop and matching company tax number without exposing API credentials',async()=>{
 const session={personId:10,roles:['operations'],tenant:{id:2,slug:'customer',role:'owner'}};let calls=0,changed=false;
 const query=async(sql,p)=>{
  if(sql.includes('FROM finance_companies'))return p[0]===20&&p[1]===2?[{id:20,tax_number:'91340111MAK9U23Y8K'}]:[];
  if(sql.includes('FROM finance_shop_company_assignments'))return [{id:200}];
  if(sql.includes('FROM shops'))return p[0]===200?[{id:200,name:'Sample',platform:'ozon',ozon_client_id:'client',ozon_api_key:changed?'changed-secret':'private-secret'}]:[];
  throw new Error(sql);
 };
 const read=async(shop,options)=>{calls++;assert.equal(shop.ozon_api_key,'private-secret');await options.beforeRequest();return source([sourceRow()]);};
 const service=createCompanyFinanceDocuments({query,authorize:async s=>s,readMonthlyRealization:read});const input={company_id:20,shop_id:200,month:'2026-08'};
 const result=await service.orderSalesSource(input,session);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('private-secret'));
 await assert.rejects(service.orderSalesSource({...input,company_id:30},session),{statusCode:404});assert.equal(calls,1);
 const revoked=createCompanyFinanceDocuments({query,authorize:async s=>s,readMonthlyRealization:async()=>{changed=true;return source([sourceRow()]);}});
 await assert.rejects(revoked.orderSalesSource(input,session),/授权已变化/);
});
test('missing LianLian fee columns/values are rejected and absent withdrawal data is unknown, not zero',async()=>{
 const w=new ExcelJS.Workbook(),s=w.addWorksheet('cash');s.addRow(['连连跨境支付提现记录查询']);s.addRow(['批次单号','交易日期','提现币种','提现金额','到账币种','到账金额']);s.addRow(['id1','2026-08-24','CNH',100,'CNY',99]);
 await assert.rejects(parseFinanceDocument(Buffer.from(await w.xlsx.writeBuffer()),'cash.xlsx',{month:'2026-08'}),/缺少必需/);
 const doc={id:1,parse_status:'confirmed',payload_json:{cash:[{type:'entry',reference:'e1',date:'2026-08-24',currency:'CNH',amount:100}]}};
 const r=reconcileImportedCash([doc],{from:'2026-08',to:'2026-08'});assert.equal(r.currencies[0].withdrawals,null);assert.equal(r.currencies[0].fees,null);
});

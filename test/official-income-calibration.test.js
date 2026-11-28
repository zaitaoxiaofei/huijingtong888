import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officialIncomePreview,createOfficialIncomeCalibration} from '../src/services/official-income-calibration.js';
import {withApprovedH1,OFFICIAL_INCOME_POLICY} from '../src/services/billing-approved-h1.js';
import {readOfficialIncome,approvedIncomeReport} from '../src/services/billing-official-income.js';

function fixture(){
 const raw={item_id:1,sale_amount_cny:'100.0000',commission_fee_cny:'20.0000',net_profit_cny:'50.0000',costs:{purchase_cost_cny:'30.0000'},profit_status:'accrued',settlement_state:'accrued'};
 const item={order_item_id:1,ozon_sku:'99',quantity:1,sale_price:100,saved_sale:100,saved_commission:20,commission_fee:20,item_revenue:100,sales_revenue:100,billing_revenue:100,compensation_income:0,costs:{purchase_cost:30,commission_fee:20},adjustment_baseline:raw};
 const order={id:1,shop_id:4,month_key:'2026-09',posting_number:'123-45-1',items:[item],billing_revenue:100,sales_revenue:100,costs:{commission_fee:20},deltas:{revenue:0,commission_fee:0}};
 const row={posting_number:'123-45-1',sku:'99',row_number:1,sold:80,returned:0,partner:0,partner_returned:0,standard_fee:20,standard_fee_returned:0,bonus:10,bonus_returned:0,sold_quantity:1,returned_quantity:0};
 const doc=(id,payload)=>({id,shop_key:4,month_key:'2026-09',parse_status:'preview',sha256:String(id).padStart(64,'0'),original_name:'official.json',payload_json:payload});
 const documents=[doc(1,{kind:'order-sales',month:'2026-09',currency:'CNY',buyer_tax_number:'tax',order_rows:[row]}),doc(2,{kind:'sales',facts:[{metric:'已确认商品销售额',currency:'CNY',amount:80},{metric:'销售退回冲减额',currency:'CNY',amount:0},{metric:'合作伙伴补贴收入',currency:'CNY',amount:0}]}),doc(3,{kind:'platform-invoice',facts:[{metric:'佣金',currency:'CNY',amount:10}]})];
 return {order,documents,row,companyTax:'tax'};
}
const preview=f=>officialIncomePreview({...f,orders:[f.order]});
test('uses official CNY income and net commission, retaining original and all other costs',()=>{
 const f=fixture(),before=JSON.stringify(f),r=preview(f).rows[0];
 assert.equal(r.can_adjust,true);assert.equal(r.target.net_revenue,80);assert.equal(r.target.commission_fee,10);assert.equal(r.target.fx_policy,'official_contract_cny_no_reconversion');assert.equal(JSON.stringify(f),before);
 const j={id:9,tenant_id:1,company_id:1,shop_id:4,month_key:'2026-09',posting_number:r.posting_number,sku:r.sku,source_valid:true,before_json:{baseline:r.original_before,effective:r.before,baseline_fingerprint:r.baseline_fingerprint,identity_fingerprint:r.identity_fingerprint,return_fingerprint:r.return_fingerprint},after_json:r.target,sources_json:r.sources};
 const applied=withApprovedH1([f.order],[j])[0];assert.equal(applied.billing_revenue,80);assert.equal(applied.costs.commission_fee,10);assert.equal(applied.items[0].costs.purchase_cost,30);assert.deepEqual(applied.items[0].adjustment_baseline,f.order.items[0].adjustment_baseline);assert.equal(applied.approved_adjustments[0].original_before.revenue,100);assert.equal(withApprovedH1([applied],[j])[0].billing_revenue,80);
 f.order.items[0].adjustment_baseline.costs.purchase_cost_cny='45.0000';f.order.items[0].costs.purchase_cost=45;assert.equal(withApprovedH1([f.order],[j])[0].billing_revenue,80,'later procurement supplementation must not restore old FX income');
 f.order.items[0].official_return_flag=true;f.order.items[0].disposed_return=true;f.order.items[0].return_quantity=1;assert.equal(withApprovedH1([f.order],[j])[0].approved_adjustments[0].status,'stale','new returns must not be overridden by an old official sale');
});
test('explicit report priority accepts invoice commission difference but retains the issue',()=>{
 const f=fixture();f.documents[2].payload_json.facts[0].amount=12;
 assert.equal(preview(f).rows[0].can_adjust,false);
 const r=preview({...f,reportPriority:true}).rows[0];assert.equal(r.can_adjust,true);assert.equal(r.target.commission_fee,10);assert.match(r.notes[0],/佣金凭证/);
 f.documents[1].payload_json.facts[0].amount=81;assert.equal(preview({...f,reportPriority:true}).rows[0].can_adjust,false);
});
test('cross-month full refund clears both income and commission without reversing inventory cost',()=>{
 const f=fixture(),returned={...f.documents[0],id:4,month_key:'2026-10',payload_json:{...f.documents[0].payload_json,month:'2026-10',order_rows:[{...f.row,sold:0,returned:80,standard_fee:0,standard_fee_returned:20,bonus:0,bonus_returned:10,sold_quantity:0,returned_quantity:1}]}};
 f.documents.push(returned,{...f.documents[1],id:5,month_key:'2026-10',payload_json:{kind:'sales',facts:[{metric:'已确认商品销售额',currency:'CNY',amount:0},{metric:'销售退回冲减额',currency:'CNY',amount:80},{metric:'合作伙伴补贴收入',currency:'CNY',amount:0}]}},{...f.documents[2],id:6,month_key:'2026-10',payload_json:{kind:'platform-invoice',facts:[{metric:'佣金',currency:'CNY',amount:-10}]}});
 const r=preview(f).rows[0];assert.equal(r.can_adjust,true);assert.equal(r.target.net_revenue,0);assert.equal(r.target.commission_fee,0);assert.deepEqual(r.sources.map(s=>s.month),['2026-09','2026-10']);assert.equal(f.order.items[0].costs.purchase_cost,30);
});
test('duplicates do not double revenue; conflicts, quantities, foreign tax and unresolved returns still block',()=>{
 const f=fixture();f.documents.push({...f.documents[0],id:4});assert.equal(preview(f).rows[0].target.net_revenue,80);
 for(const mutate of [g=>g.documents[0].payload_json.buyer_tax_number='foreign',g=>g.documents[0].payload_json.currency='RUB',g=>g.order.items[0].quantity=2,g=>g.order.items[0].official_return_flag=true]){const g=fixture();mutate(g);assert.equal(preview({...g,reportPriority:true}).rows[0].can_adjust,false);}
 const g=fixture();g.documents.push({...g.documents[0],id:4,payload_json:{...g.documents[0].payload_json,order_rows:[{...g.row,sold:81}]}});assert.equal(preview(g).rows[0].can_adjust,false);
});
test('missing official SKU is unknown, and changes to costs or effective amounts invalidate the token',()=>{
 const f=fixture(),before=preview(f).rows[0];f.order.items[0].costs.purchase_cost=99;assert.notEqual(preview(f).rows[0].token,before.token);
 f.row.sku='other';const r=preview(f).rows[0];assert.equal(r.target,null);assert.equal(r.can_adjust,false);assert.match(r.holds[0],/不把未知/);
});
function harness(){
 const f=fixture(),saved=[];let rollback=0;
 const query=async(sql,args)=>{
  if(sql.includes('SELECT oi.id,o.id'))return [{id:1,order_id:1}];
  if(sql.includes('SELECT shop_id FROM finance_shop_company_assignments'))return [{shop_id:4}];
  if(sql.includes('SELECT posting_number,order_number'))return [{posting_number:'123-45-1',order_number:'123-45'}];
  if(sql.includes('SELECT * FROM finance_reconciliation_adjustments'))return saved;
  return [];
 };
 const execute=async(sql,args)=>{if(sql.startsWith('INSERT INTO finance_reconciliation_adjustments')){const id=saved.length+1;saved.push({id,row_key:args[4],confirmation_key:args[5],before_json:JSON.parse(args[9]),after_json:JSON.parse(args[10])});return {insertId:id};}assert.match(sql,/CREATE TABLE IF NOT EXISTS/);return {};};
 const service=createOfficialIncomeCalibration({query,execute,getDocs:async()=>f.documents,shopsFor:async()=>[{id:4}],readProjection:async()=>[f.order],writePeriod:async(ctx,month,worker)=>{const snapshot=structuredClone(saved);try{return await worker({query,execute});}catch(e){saved.splice(0,saved.length,...snapshot);rollback++;throw e;}}});
 const ctx={tenantId:1,companyId:1,c:{tax_number:'tax'},s:{personId:7,tenant:{slug:'default'}}},input={month:'2026-09',shop_id:4,item_ids:[1],official_report_priority:true};
 return {f,saved,service,ctx,input,rollbacks:()=>rollback};
}
test('confirmation is append-only, retains raw baseline, and duplicate confirmation reuses its journal',async()=>{
 const h=harness(),p=await h.service.preview(h.input,h.ctx),r=p.rows[0],request={...h.input,acknowledge:true,reason:'按官方CNY报告核准',rows:[{key:r.key,token:r.token}]};
 const first=await h.service.confirm(request,h.ctx);assert.deepEqual(first.adjustment_ids,[1]);assert.equal(h.saved.length,1);assert.equal(h.saved[0].after_json.policy,OFFICIAL_INCOME_POLICY);assert.equal(h.saved[0].before_json.baseline.revenue,100);assert.equal(h.saved[0].after_json.net_profit_cny,undefined);
 assert.equal((await h.service.confirm(request,h.ctx)).reused,1);assert.equal(h.saved.length,1);assert.equal(h.f.order.items[0].saved_sale,100);
});
test('changed preview rolls back the whole confirmation, foreign enterprise and invalid selections cannot write',async()=>{
 const h=harness(),r=(await h.service.preview(h.input,h.ctx)).rows[0];h.f.order.items[0].costs.purchase_cost=31;
 await assert.rejects(h.service.confirm({...h.input,acknowledge:true,reason:'按报告核准',rows:[{key:r.key,token:r.token}]},h.ctx),/已变化/);assert.equal(h.saved.length,0);assert.equal(h.rollbacks(),1);
 await assert.rejects(h.service.preview(h.input,{...h.ctx,tenantId:2}),/仅开放/);await assert.rejects(h.service.preview({...h.input,item_ids:[1,1]},h.ctx),/1—200/);
});
test('new reader does not expose foreign sources or widen historical maintenance authority',async()=>{
 let calls=0;assert.deepEqual(await readOfficialIncome(async()=>{calls++;return [];},{tenantId:2,companyId:1,from:'2026-07',to:'2026-09'}),[]);assert.equal(calls,0);
 const row={id:1,shop_id:4,sources_json:[{document_id:1,sha256:'x'}]};const rs=await readOfficialIncome(async sql=>sql.includes('FROM finance_import_documents')?[{id:1,shop_key:6,sha256:'x',attachment_url:'foreign'}]:[row],{tenantId:1,companyId:1,from:'2026-07',to:'2026-09'});assert.equal(rs[0].source_valid,false);assert.doesNotMatch(rs[0].sources_json,/foreign/);
});
test('new UTC journals convert to Beijing display once; legacy maintenance timestamps keep their reader',async()=>{
 let checked=false;await readOfficialIncome(async sql=>{assert.match(sql,/CONVERT_TZ\(j.created_at,'\+00:00','\+08:00'\)/);checked=true;return [];},{tenantId:1,companyId:1,from:'2026-07',to:'2026-09'});assert(checked);
});
test('new H1 journal supersedes legacy once; report shows both retained original and incremental before values',async()=>{
 const f=fixture();f.order.month_key='2026-04';f.documents.forEach(d=>{d.month_key='2026-04';if(d.payload_json.month)d.payload_json.month='2026-04';});
 const r=preview(f).rows[0],base={tenant_id:1,company_id:1,shop_id:4,month_key:'2026-04',posting_number:r.posting_number,sku:r.sku,sources_json:r.sources};
 const old={...base,id:1,before_json:{baseline:{...r.original_before,profit:50}},after_json:{policy:'official-cny-approved-h1-v1',currency:'CNY',net_revenue:80,commission_fee:10,net_profit_cny:40}};
 const next={...base,id:2,before_json:{baseline:r.original_before,effective:{revenue:80,commission:10},identity_fingerprint:r.identity_fingerprint,return_fingerprint:r.return_fingerprint},after_json:{...r.target,net_revenue:75,commission_fee:5}};
 const source=f.order.items[0].adjustment_baseline;
 const query=async sql=>{
  if(sql.includes('FROM finance_import_documents'))return [{id:1,shop_key:4,sha256:f.documents[0].sha256}];
  if(sql.includes('FROM ozon_return_observations'))return [];
  if(sql.includes('FROM order_items oi'))return [{order_item_id:1,order_id:1,shop_id:4,posting_number:r.posting_number,ordered_month:'2026-04',ozon_sku:'99',quantity:1,saved_sale:source.sale_amount_cny,saved_commission:source.commission_fee_cny,saved_profit:source.net_profit_cny,saved_status:source.profit_status,saved_settlement:source.settlement_state}];
  return sql.includes("JSON_UNQUOTE(JSON_EXTRACT(j.after_json,'$.policy'))")?[next]:[old,next];
 };
 const out=await approvedIncomeReport(query,{tenantId:1,companyId:1,from:'2026-04',to:'2026-04'});
 assert.equal(out.summary.count,2);assert.equal(out.summary.applied,1);assert.equal(out.summary.superseded,1);assert.equal(out.summary.revenue_delta,-25);assert.equal(out.summary.commission_delta,-15);assert.equal(out.summary.conditional_profit_delta,-10);assert.equal(out.rows[1].before.revenue,80);assert.equal(out.rows[1].original_before.revenue,100);
});

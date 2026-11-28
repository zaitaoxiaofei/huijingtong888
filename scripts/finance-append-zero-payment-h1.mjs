import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const POLICY='official-cny-zero-payment-h1-v1';
export const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const cents=x=>Math.round(Number(x)*100);
const costs=['purchase_cost_cny','domestic_shipping_cny','international_shipping_cny','packaging_cost_cny','ozon_service_fee_cny','other_fee_cny','advertising_cost_cny','return_loss_cny'];
export function fingerprint(items){return hash(items.map(i=>({item_id:i.item_id,sale_amount_cny:i.sale_amount_cny,commission_fee_cny:i.commission_fee_cny,net_profit_cny:i.net_profit_cny,costs:Object.fromEntries(costs.map(f=>[f,i[f]])),profit_status:i.profit_status,settlement_state:i.settlement_state})));}
export function validateCandidate(c,items){
 if(![4,5,6].includes(Number(c.shop_id))||!/^2026-0[1-6]$/.test(c.month))throw Error('Outside approved shop/month scope');
 if(!items.length||new Set(items.map(i=>Number(i.order_id))).size!==1||items.length!==c.item_ids.length||items.some(i=>Number(i.shop_id)!==Number(c.shop_id)||i.ordered_month!==c.month))throw Error('Order membership changed');
 if(items.some(i=>i.profit_status!=='estimated'||i.settlement_state==='accrued'))throw Error('Settlement changed');
 if(fingerprint(items)!==c.before_fingerprint)throw Error('Before fingerprint changed');
 const b=c.before,a=c.after;
 for(const v of [b.revenue,b.commission,b.profit,b.other_costs,a.revenue,a.commission,a.profit,a.other_costs,c.profit_delta])if(!Number.isFinite(Number(v)))throw Error('Missing amount');
 if(cents(a.other_costs)!==cents(b.other_costs)||cents(a.profit)-cents(b.profit)!==cents(c.profit_delta)||cents(a.revenue)-cents(b.revenue)-cents(a.commission)+cents(b.commission)!==cents(c.profit_delta))throw Error('Profit/cost invariant failed');
 if(cents(b.revenue)-cents(b.commission)-cents(b.other_costs)!==cents(b.profit))throw Error('Baseline profit invariant failed');
 return {row_key:hash([POLICY,c.month,items[0].posting_number,String(items[0].ozon_sku)]),posting_number:items[0].posting_number,sku:String(items[0].ozon_sku)};
}
export function validateOriginal(c,documents,items){
 let sold=0,returned=0,partner=0,fee=0,total=0,soldQty=0,returnQty=0;
 for(let n=0;n<c.document_ids.length;n++){
  const d=documents.get(Number(c.document_ids[n]));if(!d||d.sha256!==c.source_document_sha256[n]||Number(d.shop_key)!==Number(c.shop_id))throw Error('Source identity changed');
  for(const r of d.original.rows.filter(r=>r.order.posting_number===items[0].posting_number&&String(r.item.sku)===String(items[0].ozon_sku))){
   for(const [field,sign]of [['delivery_commission',1],['return_commission',-1]]){const p=r[field];if(!p)continue;if(sign===1){sold+=Number(p.amount);soldQty+=Number(p.quantity);}else{returned+=Number(p.amount);returnQty+=Number(p.quantity);}partner+=sign*(Number(p.stars)+Number(p.bank_coinvestment)+Number(p.pick_up_point_coinvestment));fee+=sign*(Number(p.standard_fee)-Number(p.bonus));total+=sign*Number(p.total);}
  }
 }
 if(returnQty!==0||soldQty!==items.reduce((n,i)=>n+Number(i.quantity),0))throw Error('Official quantity/refund changed');
 if(cents(sold-returned+partner)!==cents(c.after.revenue)||cents(fee)!==cents(c.after.commission)||cents(total)!==cents(c.after.revenue)-cents(c.after.commission))throw Error('Official amount changed');
}
export function validatePayment(finance,expectedFingerprint){
const evidence=finance.map(r=>Object.fromEntries(['operation_id','posting_number','operation_type','service_type','amount_cny','service_name'].map(k=>[k,r[k]])));
if(hash(evidence)!==expectedFingerprint)throw Error('Finance evidence changed');
const payment=evidence.filter(r=>/acquiring/i.test([r.operation_type,r.service_type,r.service_name].join(' ')));
if(!payment.length||cents(payment.reduce((n,r)=>n+Number(r.amount_cny),0))!==0)throw Error('Missing or nonzero payment evidence');
return true;
}
function args(){const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];return {file:get('--manifest'),sha:get('--expected-sha'),actor:Number(get('--actor-id')),apply:a.includes('--apply')};}
async function main(){
 const opt=args();if(!opt.file||!/^\w{64}$/.test(opt.sha||'')||!Number.isSafeInteger(opt.actor))throw Error('Manifest, SHA256 and actor required');
 const bytes=await fs.readFile(opt.file);if(hash(bytes.toString())!==opt.sha)throw Error('Approved manifest SHA mismatch');const manifest=JSON.parse(bytes),batch='zero-payment-h1-20261128-'+opt.sha.slice(0,16);
 if(manifest.first_batch_candidates.length!==64||manifest.first_batch_excluded.length!==146)throw Error('Unexpected approval population');
 const candidates=manifest.first_batch_candidates.filter(c=>c.changed);if(candidates.length!==64||new Set(candidates.flatMap(c=>c.item_ids)).size!==candidates.reduce((n,c)=>n+c.item_ids.length,0))throw Error('Unexpected or duplicated approved items');
 for(const line of (await fs.readFile('/etc/ozon-erp/ozon-erp.env','utf8')).split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&!line.trim().startsWith('#'))process.env[line.slice(0,i).trim()]??=line.slice(i+1);}
 const root='/opt/ozon-erp/current',url=f=>pathToFileURL(path.join(root,f)).href;
 const {config}=await import(url('src/config.js'));const mysql=(await import(url('node_modules/mysql2/promise.js'))).default;
 const {resolveUploadSubdirRoots}=await import(url('src/runtime-uploads.js'));
 const db=await mysql.createConnection({host:config.dbHost,port:config.dbPort,user:config.dbUser,password:config.dbPassword,database:config.dbName,timezone:'Z',supportBigNumbers:true});
 let committed=false;
 try{
  await db.query('SET SESSION MAX_EXECUTION_TIME=20000');if(!opt.apply)await db.query('SET TRANSACTION READ ONLY');await db.query('START TRANSACTION');
  const [actors]=await db.query("SELECT p.id,p.name,m.role FROM people p JOIN tenant_members m ON m.person_id=p.id AND m.tenant_id=1 WHERE p.id=? AND p.active=1 AND m.role IN ('owner','admin') AND m.active=1",[opt.actor]);if(actors.length!==1)throw Error('Actor is not an active authorized member');
  const [closed]=await db.query("SELECT id FROM finance_periods WHERE company_id=1 AND month_key BETWEEN '2026-01' AND '2026-06' AND (tenant_id=1 OR tenant_id IS NULL) AND status='closed'"+(opt.apply?' FOR SHARE':''));if(closed.length)throw Error('Closed accounting period');
  const ids=[...new Set(candidates.flatMap(c=>c.item_ids))].sort((a,b)=>a-b),byId=new Map();
  for(let n=0;n<ids.length;n+=200){const part=ids.slice(n,n+200),[rows]=await db.query(`SELECT o.id order_id,o.shop_id,o.posting_number,DATE_FORMAT(CONVERT_TZ(o.ordered_at,'+00:00','+08:00'),'%Y-%m') ordered_month,oi.id item_id,oi.ozon_sku,oi.quantity,oi.settlement_state,opi.sale_amount_cny,opi.commission_fee_cny,opi.net_profit_cny,opi.profit_status,${costs.map(f=>'opi.'+f).join(',')} FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_items oi ON oi.order_id=o.id JOIN order_profit_items opi ON opi.order_item_id=oi.id WHERE oi.id IN (${part.map(()=>'?')}) AND (s.tenant_id=1 OR s.tenant_id IS NULL)${opt.apply?' FOR UPDATE':''}`,part);for(const r of rows)byId.set(Number(r.item_id),r);}
  const docIds=[...new Set(candidates.flatMap(c=>c.document_ids))], [docs]=await db.query(`SELECT id,shop_key,month_key,sha256,original_name,attachment_url FROM finance_import_documents WHERE tenant_id=1 AND company_id=1 AND id IN (${docIds.map(()=>'?')})${opt.apply?' FOR SHARE':''}`,docIds),documents=new Map();
  for(const d of docs){const name=d.attachment_url.split('/').pop(),[owned]=await db.query("SELECT storage_name FROM tenant_private_files WHERE tenant_id=1 AND purpose='finance' AND storage_name=?",[name]);if(owned.length!==1)throw Error('Source ownership');let original;
   for(const dir of resolveUploadSubdirRoots('team-attachments')){try{const b=await fs.readFile(path.join(dir,name));if(hash(b.toString())!==d.sha256)throw Error('Original SHA256 mismatch');original=JSON.parse(b);break;}catch(e){if(e.code!=='ENOENT')throw e;}}
   if(original?.header?.currency_sys_name!=='CNY')throw Error('Original CNY source unavailable');documents.set(Number(d.id),{...d,original});
  }
  const [prior]=await db.query("SELECT id,row_key,confirmation_key,after_json FROM finance_reconciliation_adjustments WHERE tenant_id=1 AND company_id=1 AND shop_id IN (4,5,6) AND month_key BETWEEN '2026-01' AND '2026-06'"+(opt.apply?' FOR UPDATE':''));
  const rows=[],reused=[],stale=[];
  for(const c of candidates){const items=c.item_ids.map(id=>byId.get(Number(id)));try{if(items.some(i=>!i))throw Error('Missing item');const identity=validateCandidate(c,items);validateOriginal(c,documents,items);
   const [finance]=await db.query(`SELECT operation_id,posting_number,operation_type,service_type,amount_cny,service_name FROM ozon_finance_items WHERE shop_id=? AND posting_number IN (?,?) ORDER BY operation_id,service_type,posting_number`,[c.shop_id,items[0].posting_number,c.parent_posting]);
   validatePayment(finance,c.finance_fingerprint);
   if(items.some(i=>!(Number(i.purchase_cost_cny)>.005)))throw Error('Missing retained purchase cost');

   const [assignments]=await db.query("SELECT shop_id FROM finance_shop_company_assignments WHERE company_id=1 AND shop_id=? AND (tenant_id=1 OR tenant_id IS NULL) AND effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (effective_to IS NULL OR effective_to>=CONCAT(?,'-01')) LIMIT 1",[c.shop_id,c.month,c.month]);if(!assignments.length)throw Error('Company membership changed');
   const confirmation=hash([batch,identity.row_key,c.before_fingerprint,c.after]);const existing=prior.find(p=>p.row_key===identity.row_key);
   if(existing){if(existing.confirmation_key!==confirmation)throw Error('Different adjustment already exists');reused.push(Number(existing.id));continue;}
   const after={policy:POLICY,approval_batch:batch,currency:'CNY',net_revenue:c.after.revenue,commission_fee:c.after.commission,net_profit_cny:c.after.profit,other_costs_cny:c.after.other_costs,business_outcome:'sale',ordered_month:c.month,fx_policy:'official_contract_cny_no_reconversion',scope:'income_and_commission_only_other_costs_frozen',payment_basis:{status:'verified_zero',amount_cny:0,source_fingerprint:c.finance_fingerprint,operation_ids:c.payment_operation_ids},settlement_review:'other_fees_and_compensation_pending',original_settlement_preserved:true,other_fee_cny_unchanged:c.other_fee_cny};
   rows.push({candidate:c,identity,values:[1,1,c.shop_id,c.month,identity.row_key,confirmation,null,identity.posting_number,identity.sku,JSON.stringify({baseline:{revenue:c.before.revenue,commission:c.before.commission,profit:c.before.profit,other_costs:c.before.other_costs,item_ids:c.item_ids},baseline_fingerprint:c.before_fingerprint,approved_manifest_sha256:opt.sha,finance_fingerprint:c.finance_fingerprint}),JSON.stringify(after),JSON.stringify(c.document_ids.map(id=>{const d=documents.get(id);return {document_id:d.id,sha256:d.sha256,original_name:d.original_name,attachment_url:d.attachment_url,month:d.month_key,currency:'CNY'};})),'用户批准Q1/Q2这64项支付费净额0：追加零支付费依据及收入佣金CNY校准；原账和其他费用不覆盖，部分补偿费用仍待核；'+batch,opt.actor]});
  }catch(e){stale.push({item_ids:c.item_ids,reason:e.message});}}
  if(stale.length){await db.rollback();throw Error('Preflight changed candidates: '+JSON.stringify(stale.slice(0,12))+' total='+stale.length);}
  const totals={};for(const {candidate:c}of rows){const t=totals[c.shop_id]||{rows:0,revenue_delta:0,commission_delta:0,profit_delta:0};t.rows++;t.revenue_delta+=cents(c.after.revenue)-cents(c.before.revenue);t.commission_delta+=cents(c.after.commission)-cents(c.before.commission);t.profit_delta+=cents(c.profit_delta);totals[c.shop_id]=t;}
  for(const t of Object.values(totals))for(const k of ['revenue_delta','commission_delta','profit_delta'])t[k]/=100;
  if(opt.apply){for(let n=0;n<rows.length;n+=100){const part=rows.slice(n,n+100);await db.query(`INSERT INTO finance_reconciliation_adjustments (tenant_id,company_id,shop_id,month_key,row_key,confirmation_key,previous_id,posting_number,sku,before_json,after_json,sources_json,reason,created_by) VALUES ${part.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,part.flatMap(r=>r.values));}
   const [saved]=await db.query("SELECT id FROM finance_reconciliation_adjustments WHERE tenant_id=1 AND company_id=1 AND JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.approval_batch'))=?",[batch]);if(saved.length!==64)throw Error('Journal population mismatch');
   for(const c of candidates){const a=c.item_ids.map(id=>byId.get(Number(id)));if(fingerprint(a)!==c.before_fingerprint)throw Error('Original unexpectedly changed');}
   await db.commit();committed=true;
  }else await db.rollback();
  console.log(JSON.stringify({mode:opt.apply?'apply':'dry-run',committed,batch,policy:POLICY,manifest_sha256:opt.sha,actor_id:opt.actor,actor_name:actors[0].name,inserted:opt.apply?rows.length:0,would_insert:rows.length,reused:reused.length,missing_cost_excluded:146,original_orders_unchanged:true,final_settlement_approved:false,totals,at:new Date().toISOString()}));
 }catch(e){if(!committed)await db.rollback().catch(()=>{});throw e;}finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();

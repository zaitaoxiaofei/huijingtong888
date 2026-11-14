import fs from 'node:fs';
import {mysqlQuery,closeMysqlPool} from '../src/mysql-pool.js';
import {settleLegacyDailyAccrualOrderMysql,refreshOrderProfitDetailSnapshotsMysql} from '../src/services/mysql-cutover.js';
import {profitCalculationFingerprint} from '../src/services/order-profit-calculation-versions.js';
const args=process.argv.slice(2),option=name=>args.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
const tenantId=Number(option('--tenant-id'));if(!Number.isSafeInteger(tenantId)||tenantId<=0)throw Error('必须明确指定 --tenant-id');
const output=option('--output');if(!output)throw Error('必须指定 --output 保存可复核的补算计划或执行记录');
const apply=args.includes('--apply'),input=option('--approved-plan');
try{
 const [tenant]=await mysqlQuery('SELECT id,slug FROM tenants WHERE id=?',[tenantId]);if(!tenant)throw Error('企业不存在');
 if(apply){
  if(!input||!option('--approved-hash'))throw Error('写入需要 --approved-plan 和 --approved-hash');
  const plan=JSON.parse(fs.readFileSync(input));const {hash,...body}=plan;
  if(hash!==option('--approved-hash')||hash!==profitCalculationFingerprint(body)||plan.tenant_id!==tenantId)throw Error('计划、企业或确认哈希不匹配');
  const result={tenant_id:tenantId,plan_hash:hash,updated:[],blocked:[],errors:[]};
  for(const row of plan.rows.filter(row=>row.ok)){
   try{const saved=await settleLegacyDailyAccrualOrderMysql(row.order_id,{preview:false,preview_token:row.preview_token,legacy_currency_evidence:plan.currency_evidence||[],command_id:`legacy-daily:${hash}:${row.order_id}`},tenantId);
    (saved.ok?result.updated:result.blocked).push({order_id:row.order_id,...(saved.ok?{items:saved.updated}:{code:saved.code})});
   }catch(error){result.errors.push({order_id:row.order_id,code:error.code||'',message:error.message});}
   fs.writeFileSync(output,JSON.stringify(result,null,2));
  }
  result.snapshot_refresh_errors=[];
  for(let n=0;n<result.updated.length;n+=100){
    try{await refreshOrderProfitDetailSnapshotsMysql({order_ids:result.updated.slice(n,n+100).map(row=>row.order_id),final_only:0},tenantId);}
    catch(error){result.snapshot_refresh_errors.push(error.message);}
  }
  fs.writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({updated:result.updated.length,blocked:result.blocked.length,errors:result.errors.length,snapshot_refresh_errors:result.snapshot_refresh_errors,output}));
 }else{
  const limit=Math.min(20000,Math.max(1,Number(option('--limit'))||20000));
  const manifestFile=option('--order-manifest');
  const manifest=manifestFile?JSON.parse(fs.readFileSync(manifestFile)):null;
  if(manifest&&(manifest.tenant_id!==tenantId||!Array.isArray(manifest.order_ids)||manifest.order_ids.some(id=>!Number.isSafeInteger(id)||id<=0)))throw Error('订单确认清单或企业无效');
  const orders=manifest?manifest.order_ids.map(id=>({id})):await mysqlQuery(`SELECT o.id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE (s.tenant_id=?${tenant.slug==='default'?' OR s.tenant_id IS NULL':''}) AND s.platform='ozon' AND o.status='delivered'
   AND EXISTS(SELECT 1 FROM ozon_finance_items f WHERE f.shop_id=o.shop_id AND f.operation_id LIKE 'accrual_by_day:%' AND f.posting_number IN(o.posting_number,COALESCE(NULLIF(o.order_number,''),REGEXP_REPLACE(o.posting_number,'-[0-9]+$',''))))
   AND EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.quantity>0)
   AND NOT EXISTS(SELECT 1 FROM order_items oi JOIN order_profit_items opi ON opi.order_item_id=oi.id WHERE oi.order_id=o.id AND oi.quantity>0 AND oi.settlement_state='accrued' AND opi.profit_status='accrued' AND opi.is_locked=1)
   ORDER BY o.id LIMIT ?`,[tenantId,limit]);
  const evidenceFile=option('--currency-evidence');
  const currencyEvidence=evidenceFile?JSON.parse(fs.readFileSync(evidenceFile)).rows:[];
  if(!Array.isArray(currencyEvidence))throw Error('币种依据文件必须包含明确的 rows 清单');
  const plan={currency_evidence:currencyEvidence,tenant_id:tenantId,created_at:new Date().toISOString(),mode:'preview',formula_version:'V5',rows:[]};
  for(const order of orders)plan.rows.push(await settleLegacyDailyAccrualOrderMysql(order.id,{preview:true,legacy_currency_evidence:currencyEvidence},tenantId));
  plan.hash=profitCalculationFingerprint(plan);fs.writeFileSync(output,JSON.stringify(plan,null,2));console.log(JSON.stringify({selected:orders.length,ready:plan.rows.filter(row=>row.ok).length,hash:plan.hash,output}));
 }
}finally{await closeMysqlPool();}

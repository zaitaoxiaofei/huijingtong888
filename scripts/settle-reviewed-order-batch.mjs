import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
const option=n=>process.argv.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
const root=option('--output-dir'),policy=JSON.parse(fs.readFileSync(option('--policy'))).review;
if(!root||!policy?.reference||new Set(policy.order_ids).size!==310)throw Error('Explicit reviewed 310-order scope required');
const cwd=process.cwd();
const {getMysqlPool,withMysqlTransaction,closeMysqlPool}=await import(cwd+'/src/mysql-pool.js');
const {settleLegacyDailyOrder}=await import(cwd+'/src/services/legacy-daily-accrual-settlement.js');
const {withVersionedOrderProfitWrite}=await import(cwd+'/src/services/mysql-order-profit-version-write.js');
const {refreshOrderProfitDetailSnapshotsMysql}=await import(cwd+'/src/services/mysql-cutover.js');
const evidence=JSON.parse(fs.readFileSync(option('--currency-evidence'))).rows;
const pool=getMysqlPool(),query=async(s,a=[])=>(await pool.query(s,a))[0];
const source=fs.readFileSync(cwd+'/src/services/mysql-cutover.js','utf8'),classify=runInNewContext('('+source.match(/^function ozonFinanceCategoryMysql\([^]*?^}/m)[0]+')');
const authorize=async()=>{
 const [tenant]=await query('SELECT slug FROM tenants WHERE id=1');
 const [owned]=await query('SELECT COUNT(*) n FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id IN (?) AND (s.tenant_id=1 OR s.tenant_id IS NULL)',[policy.order_ids]);
 if(tenant?.slug!=='default'||Number(owned.n)!==310)throw Error('Reviewed scope ownership changed');
};
const deps={query,transaction:withMysqlTransaction,shopPredicate:'(s.tenant_id=1 OR s.tenant_id IS NULL)',assertAuthorized:authorize,classifyCategory:classify,packagingFeeForSaleAmount:async()=>{throw Error('Saved costs required');},writeVersioned:withVersionedOrderProfitWrite};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
try{
 await authorize();
 if(!process.argv.includes('--apply')){
  const plan={created_at:new Date().toISOString(),policy,rows:[]};
  for(const id of policy.order_ids)plan.rows.push(await settleLegacyDailyOrder(deps,id,{preview:true,reviewed_settlement_policy:policy,legacy_currency_evidence:evidence}));
  plan.hash=hash(plan);fs.writeFileSync(root+'/reviewed-live-preview.json',JSON.stringify(plan),{mode:0o600});
  console.log(JSON.stringify({ready:plan.rows.filter(x=>x.ok).length,blocked:plan.rows.filter(x=>!x.ok).map(x=>({id:x.order_id,code:x.code})),hash:plan.hash}));
 }else{
  const {hash:approved,...body}=JSON.parse(fs.readFileSync(root+'/reviewed-live-preview.json'));
  if(approved!==option('--approved-hash')||hash(body)!==approved||JSON.stringify(body.policy)!==JSON.stringify(policy))throw Error('Current reviewed plan hash required');
  const ids=body.rows.filter(x=>x.ok).map(x=>x.order_id);
  if(ids.some(id=>!policy.order_ids.includes(id))||new Set(ids).size!==ids.length)throw Error('Plan outside reviewed scope');
  const prefix=root+'/reviewed-'+approved.slice(0,12);
  fs.writeFileSync(prefix+'-before.json',JSON.stringify({items:await query('SELECT * FROM order_items WHERE order_id IN (?)',[ids]),profits:await query('SELECT p.* FROM order_profit_items p JOIN order_items i ON i.id=p.order_item_id WHERE i.order_id IN (?)',[ids]),states:await query('SELECT * FROM order_profit_calc_state WHERE order_id IN (?)',[ids])}),{mode:0o600,flag:'wx'});
  const result={updated:[],blocked:[],errors:[]};
  for(const row of body.rows.filter(x=>x.ok)){
   try{
    const saved=await settleLegacyDailyOrder(deps,row.order_id,{preview:false,preview_token:row.preview_token,reviewed_settlement_policy:policy,legacy_currency_evidence:evidence,command_id:`reviewed:${approved.slice(0,20)}:${row.order_id}`});
    (saved.ok?result.updated:result.blocked).push({order_id:row.order_id,quality:saved.quality,code:saved.code,items:saved.updated});
   }catch(e){result.errors.push({order_id:row.order_id,code:e.code,message:e.message});}
   fs.writeFileSync(prefix+'-result.json',JSON.stringify(result));
  }
  if(result.updated.length)await refreshOrderProfitDetailSnapshotsMysql({order_ids:result.updated.map(x=>x.order_id),final_only:0},1);
  if(process.argv.includes('--release-reviewed-holds')){
   if(result.errors.length||result.blocked.length)throw Error('Inspect partial result before changing automatic settlement scope');
   await withMysqlTransaction(async connection=>{
    const [rows]=await connection.query('SELECT value_json FROM system_settings WHERE `key`=? FOR UPDATE',['profit.legacy_daily_settlement_batch:1']);
    if(rows.length!==1)throw Error('Original batch policy required');
    const previous=typeof rows[0].value_json==='string'?JSON.parse(rows[0].value_json):rows[0].value_json;
    if(previous.mode!=='allowlist'||!Array.isArray(previous.held_order_ids)||!Array.isArray(previous.allowed_order_ids))throw Error('Batch policy changed');
    const released=result.updated.map(x=>x.order_id);
    if(released.some(id=>!previous.held_order_ids.includes(id)))throw Error('Reviewed hold scope changed');
    fs.writeFileSync(prefix+'-hold-policy-before.json',JSON.stringify(previous),{mode:0o600,flag:'wx'});
    const next={...previous,allowed_order_ids:[...new Set([...previous.allowed_order_ids,...released])],held_order_ids:previous.held_order_ids.filter(id=>!released.includes(id)),reviewed_release:{reference:policy.reference,plan_hash:approved,order_ids:released}};
    await connection.execute('UPDATE system_settings SET value_json=? WHERE `key`=?',[JSON.stringify(next),'profit.legacy_daily_settlement_batch:1']);
   });
  }
  console.log(JSON.stringify(result));
 }
}finally{await closeMysqlPool();}

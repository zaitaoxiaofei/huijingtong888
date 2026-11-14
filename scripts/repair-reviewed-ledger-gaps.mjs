import fs from 'node:fs';import {createHash} from 'node:crypto';import {runInNewContext} from 'node:vm';
const option=n=>process.argv.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
const root=option('--output-dir'),scope=JSON.parse(fs.readFileSync(option('--scope')));
if(!root||scope.tenant_id!==1||scope.operations.length!==94||new Set(scope.order_ids).size!==95)throw Error('Reviewed 95-order / 94-operation scope required');
const cwd=process.cwd(),{getMysqlPool,withMysqlTransaction,closeMysqlPool}=await import(cwd+'/src/mysql-pool.js');
const {fetchOzonFinanceTransactions}=await import(cwd+'/src/ozonClient.js');
const {writeOrderFinanceAccrual}=await import(cwd+'/src/services/order-finance-accrual-write.js');
const {getOrderProfitDailyFx}=await import(cwd+'/src/services/order-profit-daily-fx.js');
const {createReviewedBoundaryProof,reviewedBoundaryUnits}=await import(cwd+'/src/services/reviewed-finance-boundary.js');
const source=fs.readFileSync(cwd+'/src/services/mysql-cutover.js','utf8');
const category=runInNewContext('('+source.match(/^function ozonFinanceCategoryMysql\([^]*?^}/m)[0]+')');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const authorize=async(query,id)=>{const [t]=await query('SELECT slug FROM tenants WHERE id=1');if(t?.slug!=='default')throw Error('Verified default enterprise required');const [s]=await query("SELECT * FROM shops WHERE id=? AND (tenant_id=1 OR tenant_id IS NULL) AND platform='ozon' AND status='active'",[id]);if(!s)throw Error('Shop ownership changed');return s;};
const legacyRows=(query,id,op)=>{const {parent}=reviewedBoundaryUnits(op);return query("SELECT id,shop_id,operation_id,posting_number,service_type,service_name,operation_type,amount,accruals_for_sale FROM ozon_finance_items WHERE shop_id=? AND (posting_number=? OR posting_number LIKE ?) AND LEFT(operation_id,15)<>'accrual_by_day:' ORDER BY id",[id,parent,parent+'-%']);};
async function overlap(query,id,op){
 const unit=op.posting_number||op.unit_number;
 const rows=await query("SELECT id,operation_id,posting_number,service_type,service_name,operation_type,operation_type_name,amount,accruals_for_sale FROM ozon_finance_items WHERE shop_id=? AND (posting_number=? OR posting_number LIKE ?) AND LEFT(operation_id,15)<>'accrual_by_day:'",[id,unit,unit+'-%']);
 const cats=new Set(op.rows.map(r=>r.normalized_category));
 const possible=rows.filter(r=>(cats.has('income')&&Math.abs(Number(r.accruals_for_sale))>.0001)||(cats.has(category(r))&&Math.abs(Number(r.amount))>.0001));
 return possible.map(r=>r.id);
}
try{
 if(!process.argv.includes('--apply')){
  const c=await getMysqlPool().getConnection(),q=async(s,a=[])=>(await c.query(s,a))[0];
  try{await c.query('SET SESSION TRANSACTION READ ONLY');await c.beginTransaction();const fx=await getOrderProfitDailyFx({query:q},'2026-09-08');if(!fx)throw Error('Archived FX required');
   const [owned]=await q('SELECT COUNT(*) n FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id IN (?) AND (s.tenant_id=1 OR s.tenant_id IS NULL)',[scope.order_ids]);if(Number(owned.n)!==95)throw Error('Order scope changed');
   const plan={created_at:new Date().toISOString(),scope,fx,operations:[],blocked:[],related_orders:[]};
   for(const id of [...new Set(scope.operations.map(o=>o.shop_id))]){
    const shop=await authorize(q,id),wanted=new Set(scope.operations.filter(o=>o.shop_id===id).map(o=>o.operation_id));
    const source=await fetchOzonFinanceTransactions(shop,{from:'2026-09-08',to:'2026-09-08',beforeRequest:()=>authorize(q,id),signal:AbortSignal.timeout(120000)});
    const found=source.operations.filter(o=>wanted.has(o.operation_id));if(found.length!==wanted.size)throw Error('Official operation missing on reread');
    for(const op of found){
     const expected=scope.operations.find(x=>x.shop_id===id&&x.operation_id===op.operation_id);
     const before=await q('SELECT * FROM ozon_finance_items WHERE shop_id=? AND operation_id=?',[id,op.operation_id]);
     const conflicts=await overlap(q,id,op);
     const identity=op.rows.map(r=>({category:r.normalized_category,name:r.service_name,amount:r.amount,currency:r.currency_code})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
     const reviewed=[...expected.rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
     if(!op.reconciliation.ok||conflicts.length||JSON.stringify(identity)!==JSON.stringify(reviewed))plan.blocked.push({shop_id:id,operation_id:op.operation_id,conflicts,official_changed:JSON.stringify(identity)!==JSON.stringify(reviewed),reconciliation:op.reconciliation});
     let boundaryReview=null;try{boundaryReview=createReviewedBoundaryProof({shopId:id,tenantKey:Number(shop.tenant_id)>0?String(shop.tenant_id):'admin',operation:op,businessDate:fx.business_date,legacyRows:await legacyRows(q,id,op),reference:scope.reference});}catch(e){plan.blocked.push({shop_id:id,operation_id:op.operation_id,code:e.code,message:e.message});}
     plan.operations.push({shop_id:id,operation:op,before,boundaryReview});
     const unit=op.posting_number||op.unit_number;
     const related=await q('SELECT id,shop_id,posting_number,status FROM orders WHERE shop_id=? AND (posting_number=? OR order_number=?)',[id,unit,unit]);plan.related_orders.push(...related);
    }
   }
   plan.related_orders=[...new Map(plan.related_orders.map(x=>[x.id,x])).values()];plan.hash=hash(plan);fs.writeFileSync(root+'/ledger-preview.json',JSON.stringify(plan),{mode:0o600});await c.rollback();
   console.log(JSON.stringify({operations:plan.operations.length,rows:plan.operations.reduce((n,x)=>n+x.operation.rows.length,0),blocked:plan.blocked,existing:plan.operations.filter(x=>x.before.length).length,related_orders:plan.related_orders.length,hash:plan.hash}));
  }finally{c.release();}
 }else{
  const plan=JSON.parse(fs.readFileSync(root+'/ledger-preview.json')), {hash:approved,...body}=plan;
  if(approved!==option('--approved-hash')||hash(body)!==approved||plan.blocked.length)throw Error('Reviewed unblocked plan hash required');
  const backup=root+`/ledger-before-${approved.slice(0,12)}.json`;if(fs.existsSync(backup))throw Error('Backup exists; inspect instead of rerunning');fs.writeFileSync(backup,JSON.stringify({captured_at:new Date().toISOString(),scope:plan.scope,before:plan.operations.map(x=>({shop_id:x.shop_id,operation_id:x.operation.operation_id,rows:x.before}))}),{mode:0o600});
  const result={operations:0,rows:0,skipped:0,errors:[]};
  for(const x of plan.operations){try{
   if(x.before.length){result.skipped++;continue;}
   const q=async(s,a=[])=>(await getMysqlPool().query(s,a))[0];const shop=await authorize(q,x.shop_id);
   if((await q('SELECT id FROM ozon_finance_items WHERE shop_id=? AND operation_id=?',[x.shop_id,x.operation.operation_id])).length)throw Error('Ledger changed after preview');
   if((await overlap(q,x.shop_id,x.operation)).length)throw Error('Legacy overlap appeared after preview');
   const saved=await writeOrderFinanceAccrual({transaction:withMysqlTransaction,shop,operation:x.operation,fx:plan.fx,legacyBoundaryReview:x.boundaryReview,assertAuthorized:({connection})=>authorize(async(s,a)=>(await connection.query(s,a))[0],x.shop_id)});
   result.operations++;result.rows+=saved.rows;
  }catch(e){result.errors.push({shop_id:x.shop_id,operation_id:x.operation.operation_id,message:e.message});}fs.writeFileSync(root+`/ledger-apply-${approved.slice(0,12)}.json`,JSON.stringify(result));}
  console.log(JSON.stringify(result));
 }
}finally{await closeMysqlPool();}

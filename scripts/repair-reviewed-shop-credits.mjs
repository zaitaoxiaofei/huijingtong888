import fs from 'node:fs';import {createHash} from 'node:crypto';
const option=n=>process.argv.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
const root=option('--output-dir'),scope=JSON.parse(fs.readFileSync(option('--scope')));
if(!root||scope.operations?.length!==76)throw Error('Explicit 76-operation shop credit review required');
const cwd=process.cwd(),{getMysqlPool,withMysqlTransaction,closeMysqlPool}=await import(cwd+'/src/mysql-pool.js');
const {fetchOzonFinanceTransactions}=await import(cwd+'/src/ozonClient.js');
const {getOrderProfitDailyFx}=await import(cwd+'/src/services/order-profit-daily-fx.js');
const {writeOrderFinanceAccrual}=await import(cwd+'/src/services/order-finance-accrual-write.js');
const query=async(s,a=[])=>(await getMysqlPool().query(s,a))[0];
const authorize=async(id,q=query)=>{const [t]=await q('SELECT slug FROM tenants WHERE id=1');const [s]=await q("SELECT * FROM shops WHERE id=? AND (tenant_id=1 OR tenant_id IS NULL) AND platform='ozon' AND status='active'",[id]);if(t?.slug!=='default'||!s)throw Error('Reviewed default enterprise ownership required');return s;};
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
try{
 if(!process.argv.includes('--apply')){
  const plan={reference:'user:2026-11-14:resolve official bill exceptions',rows:[],blocked:[]},cache=new Map();
  for(const expected of scope.operations){
   const date=String(expected.operation_date).slice(0,10),key=expected.shop_id+':'+date,shop=await authorize(expected.shop_id);
   if(!cache.has(key))cache.set(key,await fetchOzonFinanceTransactions(shop,{from:date,to:date,beforeRequest:()=>authorize(shop.id),signal:AbortSignal.timeout(120000)}));
   const op=cache.get(key).operations.find(x=>x.operation_id===expected.operation_id);
   const before=await query('SELECT * FROM ozon_finance_items WHERE shop_id=? AND operation_id=? ORDER BY id',[shop.id,expected.operation_id]);
   if(!op||!op.reconciliation.ok||op.currency_code!==expected.currency||Math.abs(op.amount-Number(expected.official_net))>.0001||op.rows.some(r=>!['PayPerClick','ItemCompensation'].includes(r.service_name))||op.posting_number||op.unit_scope!=='unallocated'||before.length!==expected.ledger_rows){plan.blocked.push({shop_id:shop.id,operation_id:expected.operation_id});continue;}
   const fx=await getOrderProfitDailyFx({query},date);if(!fx)throw Error('Archived daily FX required');
   plan.rows.push({shop_id:shop.id,operation:op,fx,before});
  }
  plan.hash=digest(plan);fs.writeFileSync(root+'/shop-credits-preview.json',JSON.stringify(plan),{mode:0o600});console.log(JSON.stringify({operations:plan.rows.length,blocked:plan.blocked,hash:plan.hash}));
 }else{
  const {hash,...plan}=JSON.parse(fs.readFileSync(root+'/shop-credits-preview.json'));
  if(hash!==option('--approved-hash')||digest(plan)!==hash||plan.blocked.length||plan.rows.length!==76)throw Error('Reviewed complete plan hash required');
  const prefix=root+'/shop-credits-'+hash.slice(0,12);fs.writeFileSync(prefix+'-before.json',JSON.stringify(plan.rows.map(x=>({shop_id:x.shop_id,operation_id:x.operation.operation_id,rows:x.before}))),{mode:0o600,flag:'wx'});
  const result={updated:[],errors:[]};
  for(const x of plan.rows){try{
   const current=await query('SELECT * FROM ozon_finance_items WHERE shop_id=? AND operation_id=? ORDER BY id',[x.shop_id,x.operation.operation_id]);if(digest(current)!==digest(x.before))throw Error('Ledger changed since preview');
   const shop=await authorize(x.shop_id);await writeOrderFinanceAccrual({transaction:withMysqlTransaction,shop,operation:x.operation,fx:x.fx,assertAuthorized:({connection})=>authorize(x.shop_id,async(s,a)=>(await connection.query(s,a))[0])});
   result.updated.push({shop_id:x.shop_id,operation_id:x.operation.operation_id});
  }catch(e){result.errors.push({shop_id:x.shop_id,operation_id:x.operation.operation_id,code:e.code,message:e.message});}
  fs.writeFileSync(prefix+'-result.json',JSON.stringify(result));}
  console.log(JSON.stringify(result));
 }
}finally{await closeMysqlPool();}

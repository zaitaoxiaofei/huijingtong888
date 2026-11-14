import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const CONFIRMED_COSTS=Object.freeze({229:15,837:25,844:8,845:48,847:20,848:21,859:13,881:8});
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const fail=message=>{throw Error(message);};
export function planCostRepair(products,items,scope){
 if(scope.tenant_id!==1||!Array.isArray(scope.order_ids)||new Set(scope.order_ids).size!==scope.order_ids.length)fail('Invalid reviewed scope');
 const ids=new Set(scope.order_ids),productIds=Object.keys(CONFIRMED_COSTS).map(Number);
 if(products.length!==8||new Set(products.map(x=>Number(x.id))).size!==8)fail('Eight reviewed inventory records required');
 const owned=value=>Number(value)===1||(value==null&&scope.default_tenant===true);
 for(const p of products)if(!productIds.includes(Number(p.id))||!owned(p.tenant_id)||!Number(p.active))fail(`Inventory ownership or identity changed: ${p.id}, tenant ${p.tenant_id}, active ${p.active}`);
 const seen=new Set(),history=[];
 for(const i of items){
  if(!ids.has(Number(i.order_id))||!owned(i.tenant_id)||!productIds.includes(Number(i.product_id))||seen.has(Number(i.id)))fail('Order ownership, mapping or scope changed');
  seen.add(Number(i.id));
  if(i.settlement_state==='accrued'||i.profit_status==='accrued'||Number(i.is_locked))fail('Confirmed actuals are protected');
  if(!Number.isFinite(Number(i.quantity))||Number(i.quantity)<=0)fail('Quantity missing');
  const unit=CONFIRMED_COSTS[i.product_id],total=round(unit*Number(i.quantity));
  const previous=Number(i.purchase_cost_cny),frozen=Number(i.frozen_purchase_cost);
  if(![0,total].includes(previous)||![0,unit].includes(frozen))fail('Historical cost changed; review required');
  if(![i.estimated_profit,i.net_profit_cny,i.gross_profit_cny].every(x=>x!=null&&Number.isFinite(Number(x))))fail('Historical estimate breakdown missing');
  const delta=round(total-previous);
  history.push({id:Number(i.id),order_id:Number(i.order_id),product_id:Number(i.product_id),before:i,
   unit,total,delta,estimated_profit:round(Number(i.estimated_profit)-delta),
   net_profit_cny:round(Number(i.net_profit_cny)-delta),gross_profit_cny:round(Number(i.gross_profit_cny)-delta)});
 }
 if(new Set(history.map(x=>x.order_id)).size!==ids.size)fail('Reviewed order items missing');
 const plan={tenant_id:1,reference:scope.reference,confirmations:CONFIRMED_COSTS,
  products:[...products].sort((a,b)=>a.id-b.id),items:history.sort((a,b)=>a.id-b.id)};
 return {...plan,hash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}
async function main(){
 const option=n=>process.argv.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
 const scope=JSON.parse(fs.readFileSync(option('--scope'))),root=option('--output-dir');if(!root)fail('Output directory required');
 const cwd=process.cwd(),{getMysqlPool,withMysqlTransaction,closeMysqlPool}=await import(cwd+'/src/mysql-pool.js');
 const {withVersionedOrderProfitWrite}=await import(cwd+'/src/services/mysql-order-profit-version-write.js');
 const productIds=Object.keys(CONFIRMED_COSTS).map(Number);
 const read=async(c,lock=false)=>{
  const q=async(s,a=[])=>(await c.query(s,a))[0];
  const [tenant]=await q('SELECT id,slug FROM tenants WHERE id=1');if(!tenant)fail('Tenant missing');
  const effectiveScope={...scope,default_tenant:tenant.slug==='default'};
  const products=await q(`SELECT id,tenant_id,name,purchase_cost,active,updated_at FROM products WHERE id IN (?) ORDER BY id${lock?' FOR UPDATE':''}`,[productIds]);
  const items=await q(`SELECT oi.id,oi.order_id,oi.quantity,oi.sale_price,oi.sku_mapping_id,oi.frozen_purchase_cost,
   oi.estimated_profit,oi.settlement_state,sm.product_id,s.tenant_id,opi.purchase_cost_cny,opi.net_profit_cny,
   opi.gross_profit_cny,opi.profit_status,opi.is_locked
   FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id
   JOIN sku_mappings sm ON sm.id=oi.sku_mapping_id AND sm.shop_id=o.shop_id
   JOIN order_profit_items opi ON opi.order_item_id=oi.id
   WHERE oi.order_id IN (?) AND oi.quantity>0 ORDER BY oi.id${lock?' FOR UPDATE':''}`,[scope.order_ids]);
  return planCostRepair(products,items,effectiveScope);
 };
 try{
  if(!process.argv.includes('--apply')){
   const c=await getMysqlPool().getConnection();try{await c.query('SET SESSION TRANSACTION READ ONLY');await c.beginTransaction();
    const plan=await read(c);fs.writeFileSync(root+'/cost-preview.json',JSON.stringify(plan,null,2));await c.rollback();
    console.log(JSON.stringify({inventory:plan.products.length,orders:scope.order_ids.length,items:plan.items.length,hash:plan.hash}));
   }finally{c.release();}return;
  }
  const reviewed=JSON.parse(fs.readFileSync(root+'/cost-preview.json'));
  if(reviewed.hash!==option('--approved-hash'))fail('Reviewed preview hash required');
  const result=await withMysqlTransaction(async c=>{
   const plan=await read(c,true);if(plan.hash!==reviewed.hash)fail('Inventory or order changed; preview again');
   const q=async(s,a=[])=>(await c.query(s,a))[0];
   const before={captured_at:new Date().toISOString(),plan,
    products:await q('SELECT * FROM products WHERE id IN (?)',[productIds]),
    items:await q('SELECT * FROM order_items WHERE order_id IN (?)',[scope.order_ids]),
    profits:await q('SELECT p.* FROM order_profit_items p JOIN order_items i ON i.id=p.order_item_id WHERE i.order_id IN (?)',[scope.order_ids]),
    states:await q('SELECT * FROM order_profit_calc_state WHERE order_id IN (?)',[scope.order_ids])};
   const backup=root+'/cost-before.json';if(fs.existsSync(backup))fail('Existing backup; inspect rather than overwrite');fs.writeFileSync(backup,JSON.stringify(before),{mode:0o600});
   let inventoryUpdated=0;
   for(const p of plan.products){const next=CONFIRMED_COSTS[p.id];if(Number(p.purchase_cost)===next)continue;
    await c.execute('UPDATE products SET purchase_cost=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id <=> ?',[next,p.id,p.tenant_id]);
    await c.execute("INSERT INTO inventory_flow_events(tenant_id,product_id,action,detail_json) VALUES(1,?,'purchase_cost_confirmation',?)",[p.id,JSON.stringify({source:'user_confirmation',reference:scope.reference,previous_cost:p.purchase_cost,new_cost:next,scope_order_ids:scope.order_ids,plan_hash:plan.hash})]);inventoryUpdated++;
   }
   let itemsUpdated=0;
   for(const x of plan.items){if(x.delta===0&&Number(x.before.frozen_purchase_cost)===x.unit)continue;
    await withVersionedOrderProfitWrite(x.id,{connection:c,layer:'estimate',expectedFormulaVersion:'V1',
     expectedProjection:{quantity:x.before.quantity,estimated_profit:x.before.estimated_profit,frozen_purchase_cost:x.before.frozen_purchase_cost},
     source:'user_confirmed_purchase_cost',reason:'用户确认8款库存成本；仅修复已列明的缺成本订单，保留原运价与历史预估',
     inputs:{repair:'purchase_cost_only',reference:scope.reference,inventory_id:x.product_id,unit_cost_cny:x.unit,quantity:x.before.quantity},
     costVersion:{reference:scope.reference,inventory_id:x.product_id,unit_cost_cny:x.unit},commandId:`confirmed-cost:${plan.hash.slice(0,20)}:${x.id}`},async()=>{
      await c.execute('UPDATE order_items SET frozen_purchase_cost=?,estimated_profit=? WHERE id=?',[x.unit,x.estimated_profit,x.id]);
      await c.execute('UPDATE order_profit_items SET purchase_cost_cny=?,net_profit_cny=?,gross_profit_cny=? WHERE order_item_id=?',[x.total,x.net_profit_cny,x.gross_profit_cny,x.id]);
     });itemsUpdated++;
   }
   return {inventory_confirmed:8,inventory_updated:inventoryUpdated,orders:scope.order_ids.length,items_updated:itemsUpdated,plan_hash:plan.hash};
  });fs.writeFileSync(root+'/cost-apply-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await closeMysqlPool();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await main();

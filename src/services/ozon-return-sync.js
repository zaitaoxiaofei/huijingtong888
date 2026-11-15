import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {resolveInventoryTenantScope,inventoryTenantSql} from './inventory-tenant-scope.js';
import {fetchOzonReturnObservations} from '../ozonClient.js';
const date=value=>{if(!value)return null;const d=new Date(value);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,19).replace('T',' ');};
const decode=value=>typeof value==='string'?JSON.parse(value):value;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
// No profit, inventory or original posting status writes belong to this reader.
export async function storeOzonReturnObservations(connection,scope,shopId,rows) {
  const q=async(s,p=[])=>(await connection.query(s,p))[0];
  const [shop]=await q(`SELECT s.id FROM shops s JOIN tenants t ON t.id=? AND t.status='active' AND t.subscription_status IN ('active','trial') AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at>UTC_TIMESTAMP()) WHERE s.id=? AND s.status='active' AND s.platform='ozon' AND ${inventoryTenantSql(scope,'s')} FOR UPDATE`,[scope.id,shopId]);
  if(!shop)throw new Error('店铺不属于当前有效企业，停止退货同步');
  let changed=0,matched=0;
  for(const row of rows){
    const [order]=await q('SELECT id FROM orders WHERE shop_id=? AND posting_number=? LIMIT 1',[shopId,row.posting_number]);
    const json=JSON.stringify(row);
    const [old]=await q('SELECT id,state_json,order_id,posting_number FROM ozon_return_observations WHERE tenant_id=? AND shop_id=? AND source_endpoint=? AND return_id=? FOR UPDATE',[scope.id,shopId,row.source_endpoint,row.return_id]);
    if(old && old.posting_number !== row.posting_number) throw new Error("同一官方退货编号关联的订单发生冲突，需人工核对");
    if(order)matched++;
    if(old&&canonical(decode(old.state_json))===canonical(row)&&Number(old.order_id||0)===Number(order?.id||0)){
      await q('UPDATE ozon_return_observations SET observed_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=?',[old.id,scope.id]);continue;
    }
    await q(`INSERT INTO ozon_return_observations(tenant_id,shop_id,order_id,source_endpoint,return_id,posting_number,official_state,state_json,request_created_at,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id),posting_number=VALUES(posting_number),official_state=VALUES(official_state),state_json=VALUES(state_json),request_created_at=VALUES(request_created_at),observed_at=VALUES(observed_at)`,
      [scope.id,shopId,order?.id||null,row.source_endpoint,row.return_id,row.posting_number,String(row.state?.state||''),json,date(row.created_at)]);
    const [saved]=await q('SELECT id FROM ozon_return_observations WHERE tenant_id=? AND shop_id=? AND source_endpoint=? AND return_id=?',[scope.id,shopId,row.source_endpoint,row.return_id]);
    await q('INSERT INTO ozon_return_history(tenant_id,shop_id,observation_id,official_state,state_json,observed_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())',[scope.id,shopId,saved.id,String(row.state?.state||''),json]);changed++;
  }
  return {changed,matched,observations:rows.length};
}
export async function syncTenantOzonReturns(tenantId) {
  const scope=await resolveInventoryTenantScope(tenantId);
  const shops=await mysqlQuery(`SELECT * FROM shops WHERE ${inventoryTenantSql(scope)} AND platform='ozon' AND status='active' ORDER BY id`);
  const result={shops:[],errors:[],changed:0,matched:0,requests:0};
  for(const shop of shops){try{
    const beforeRequest=async()=>{const [current]=await mysqlQuery(`SELECT s.* FROM shops s JOIN tenants t ON t.id=? AND t.status='active' AND t.subscription_status IN ('active','trial') AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at>UTC_TIMESTAMP()) WHERE s.id=? AND ${inventoryTenantSql(scope,'s')} AND s.platform='ozon' AND s.status='active'`,[scope.id,shop.id]);if(!current)throw new Error('企业或店铺已停用');return current;};
    const fetched=await fetchOzonReturnObservations(shop,{beforeRequest});
    const saved=await withMysqlTransaction(c=>storeOzonReturnObservations(c,scope,shop.id,fetched.rows));
    result.shops.push({shop_id:shop.id,...saved,complete:true});result.changed+=saved.changed;result.matched+=saved.matched;result.requests+=fetched.requests;
  }catch(e){result.errors.push(`店铺 #${shop.id} 退货同步失败：${e.message}`);result.shops.push({shop_id:shop.id,error:e.message,complete:false});}}
  return result;
}
export {enrichOrdersWithOzonReturns} from './ozon-return-reader.js';

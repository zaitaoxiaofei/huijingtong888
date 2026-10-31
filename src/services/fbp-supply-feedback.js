import {inventoryTenantSql,resolveInventoryTenantScope,assertInventoryRecord} from './inventory-tenant-scope.js';
import {randomUUID} from 'node:crypto';
import {fbpSupplyProductIds} from './fbp-supply-products.js';
import {createInventoryWorkflowService} from './inventory-workflow.js';
import {inventorySupplyFeedback} from './inventory-supply-feedback.js';
import {broadcastGlobalEvent} from '../server/notifications.js';
// The same transactional hook serves both SKU drafting and existing FBP submit.
export function createFbpSupplyFeedback(session){
 const result={notified:0,products:[]};
 return{
  async afterSubmit(connection,rows){
   const q=async(sql,args=[])=>(await connection.query(sql,args))[0];
   const affected=await fbpSupplyProductIds(q,rows,session.tenant.id),reader=createInventoryWorkflowService({query:q});
   for(let i=0;i<affected.length;i+=40)for(const state of await reader.batch(affected.slice(i,i+40),session.tenant.id,{fresh:true,cache:false})){
    const scope=await resolveInventoryTenantScope(session.tenant.id,q);
    await assertInventoryRecord(scope,'product',Number(state.product_id),q,{lock:true});
    // Only unpurchased new forecast requests are reduced. Historical purchases
    // and committed orders are immutable; they already supply the shared pool.
    const forecasts=await q(`SELECT id,quantity FROM procurement_requests WHERE product_id=? AND ${inventoryTenantSql(scope)} AND request_reason_code='flow_fbp_forecast' AND status IN('submitted','pending','suggested') AND purchase_order_id IS NULL ORDER BY id FOR UPDATE`,[state.product_id]);
    if(state.supply_plan.known&&state.supply_plan.fbp_forecast_known){let remaining=Number(state.supply_plan.optional_fbp||0);for(const r of forecasts){const keep=Math.min(remaining,Number(r.quantity));remaining-=keep;if(keep===Number(r.quantity))continue;
      await connection.execute(`UPDATE procurement_requests SET quantity=?,status=?,approval_status=?,updated_at=UTC_TIMESTAMP(),note=CONCAT(COALESCE(note,''),'；预测已由正式FBP申请或现有货源覆盖') WHERE id=? AND ${inventoryTenantSql(scope)}`,[keep||Number(r.quantity),keep?'submitted':'cancelled',keep?'submitted':'cancelled',r.id]);
      await connection.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,state.product_id,session.personId,'fbp_forecast_confirmed',JSON.stringify({request_id:r.id,previous_quantity:Number(r.quantity),remaining_quantity:keep,submitted_fbp_quantity:state.requested})]);
    }}
    const notice=await inventorySupplyFeedback({product_id:state.product_id,note:'运营已正式提交同库存SKU备货申请，请按共用库存缺口安排采购。',request_key:randomUUID()},session,{connection,automatic:true,stateSnapshot:state});
    result.notified+=notice.notified;result.products.push({product_id:state.product_id,notified:notice.notified});
   }
  },
  committed(){if(result.notified)try{broadcastGlobalEvent('system-notification',{refresh:true},{tenantId:session.tenant.id});}catch{}return result;}
 };
}

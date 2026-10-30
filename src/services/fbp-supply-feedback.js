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
    const notice=await inventorySupplyFeedback({product_id:state.product_id,note:'运营已正式提交同库存SKU备货申请，请按共用库存缺口安排采购。',request_key:randomUUID()},session,{connection,automatic:true,stateSnapshot:state});
    result.notified+=notice.notified;result.products.push({product_id:state.product_id,notified:notice.notified});
   }
  },
  committed(){if(result.notified)try{broadcastGlobalEvent('system-notification',{refresh:true},{tenantId:session.tenant.id});}catch{}return result;}
 };
}

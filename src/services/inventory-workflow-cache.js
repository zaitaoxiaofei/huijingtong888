let revision=0;
const changes=[];
export const workflowCache=new Map();
export const workflowRevision=()=>revision;
export function invalidateInventoryWorkflow(change){
 revision++;workflowCache.clear();
 const ids=change?.productIds,tenantId=Number(change?.tenantId);
 const scoped=Number.isSafeInteger(tenantId)&&tenantId>0&&Array.isArray(ids)&&ids.length>0&&ids.length<=1000&&ids.every(id=>Number.isSafeInteger(Number(id))&&Number(id)>0);
 changes.push({revision,tenantId:scoped?tenantId:null,productIds:scoped?[...new Set(ids.map(Number))]:null});
 if(changes.length>256)changes.shift();
}
// Null means the complete impact is unknown; callers must rebuild the tenant.
export function inventoryWorkflowChanges(since,tenantId){
 if(!Number.isSafeInteger(since)||since<0||since>revision||since<(changes[0]?.revision??revision+1)-1)return null;
 const ids=new Set();
 for(const change of changes)if(change.revision>since){if(!change.productIds)return null;if(change.tenantId===Number(tenantId))for(const id of change.productIds)ids.add(id);}
 return [...ids];
}

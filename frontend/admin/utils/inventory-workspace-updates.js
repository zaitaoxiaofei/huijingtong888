import {inventoryWorkspacePage} from '../../../src/shared/inventory-workspace.js';

// Retain a confirmed live read until a completed, newer calculation replaces it.
export function applyInventoryWorkspaceUpdates(result,updates,criteria){
 const stable=result.snapshot?.available!==false&&!result.snapshot?.stale&&!result.snapshot?.refreshing;
 const at=Date.parse(result.snapshot?.calculated_at);
 for(const [id,update] of updates)if(stable&&Number.isFinite(at)&&at>=Date.parse(update.workflow.calculated_at))updates.delete(id);
 if(!updates.size)return result;
 const meta={...result.meta};let total=Number(result.total)||0;
 for(const [id,update] of updates){
  const base=(result.rows||[]).find(r=>Number(r.product_id)===id);
  if(!base)continue;
  const next={...base,workflow:update.workflow};
  for(const task of ['all','required','advisory','incoming','review'])if(meta[task]!=null)meta[task]=Math.max(0,Number(meta[task])+inventoryWorkspacePage([next],{...criteria,task}).total-inventoryWorkspacePage([base],{...criteria,task}).total);
  total+=inventoryWorkspacePage([next],criteria).total-inventoryWorkspacePage([base],criteria).total;
 }
 const patched=(result.rows||[]).map(row=>updates.has(Number(row.product_id))?{...row,workflow:updates.get(Number(row.product_id)).workflow}:row);
 const rows=inventoryWorkspacePage(patched,{...criteria,page:1,pageSize:100}).rows;
 return{...result,rows,total:Math.max(0,total),meta};
}

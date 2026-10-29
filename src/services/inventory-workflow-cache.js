let revision=0;
export const workflowCache=new Map();
export const workflowRevision=()=>revision;
export function invalidateInventoryWorkflow(){revision++;workflowCache.clear();}

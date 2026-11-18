export function pddInvoiceStorageManifest(rows,tenantId,now=new Date()){
 if(!Number.isSafeInteger(tenantId)||tenantId<=0)throw Error('Explicit tenant ID required');
 const accounts=rows.map(row=>{
  if(Number(row.tenant_id)!==tenantId)throw Error('Manifest tenant mismatch');
  const data=typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json;
  return {accountId:row.account_id,revision:Number(row.revision),files:(data.orders||[]).flatMap(order=>(order.cloudFiles||[]).map(file=>({orderId:order.id,fileId:file.id,size:file.size,sha256:file.sha256,ext:file.ext,
    storage:file.storage?{driver:file.storage.driver,bucket:file.storage.bucket,region:file.storage.region,objectKey:file.storage.objectKey,versionId:file.storage.versionId||''}:{driver:'legacy-local'}})))};
 });
 return {schema:1,tenantId,createdAt:now.toISOString(),accountCount:accounts.length,fileCount:accounts.reduce((n,a)=>n+a.files.length,0),accounts};
}

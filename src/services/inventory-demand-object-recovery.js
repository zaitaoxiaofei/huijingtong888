import {readScopedJson} from './scoped-json-object.js';
import {archivePrivateJson} from './private-json-archive.js';

// Invoked only by the explicit offline rollback CLI. Normal read-model refresh
// remains in inventory-demand-snapshot and never rewrites business stock/costs.
export async function restoreDemandSnapshotObject({query,tenantId,read=readScopedJson,archive=archivePrivateJson}){
 if(!Number.isSafeInteger(Number(tenantId))||Number(tenantId)<1)throw Error('Explicit enterprise required');const id=Number(tenantId);
 const [row]=await query('SELECT payload_json,calculated_at FROM inventory_demand_snapshots WHERE tenant_id=?',[id]);if(!row)return {restored:0,reason:'absent'};
 let parsed;try{parsed=JSON.parse(row.payload_json);}catch{return {restored:0,reason:'legacy_json'};}
 if(!parsed?._erp_oss_json_v1)return {restored:0,reason:'already_inline'};
 const original=await read(row.payload_json,{kind:'inventory-demand',tenantId:id});
 const recovery=await archive(JSON.stringify({tenant_id:id,pointer:parsed,calculated_at:row.calculated_at}),{namespace:`inventory-demand/${id}`});
 const result=await query('UPDATE inventory_demand_snapshots SET payload_json=?,calculated_at=calculated_at WHERE tenant_id=? AND BINARY payload_json=BINARY ?',[original,id,row.payload_json]);
 if(Number(result.affectedRows)!==1)throw Error('Read model changed; rollback refused');const [restored]=await query('SELECT payload_json,calculated_at FROM inventory_demand_snapshots WHERE tenant_id=?',[id]);if(restored.payload_json!==original||String(restored.calculated_at)!==String(row.calculated_at))throw Error('Read-model rollback verification failed');return {restored:1,bytes:Buffer.byteLength(original),recovery};
}

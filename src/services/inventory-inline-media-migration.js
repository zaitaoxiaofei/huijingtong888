import assert from 'node:assert/strict';
import {jsonArchiveHash,archivePrivateJson,readPrivateJson} from './private-json-archive.js';
import {prepareInventoryInlineMedia} from './database-inline-media.js';

const text=row=>JSON.stringify({image_url:row.image_url,detail_image_urls:row.detail_image_urls});
async function scope(query,tenant){
 if(!/^(?:admin|[1-9][0-9]*)$/.test(String(tenant||'')))throw Error('Explicit inventory tenant required');
 if(tenant==='admin'){
  const [row]=await query("SELECT id FROM tenants WHERE slug='default' AND status='active' LIMIT 1");if(!row)throw Error('Default enterprise unavailable');
  return {sql:'(tenant_id=? OR tenant_id IS NULL)',params:[Number(row.id)]};
 }return {sql:'tenant_id=?',params:[Number(tenant)]};
}
async function identity(query,plan){const [r]=await query('SELECT DATABASE() AS db,@@server_uuid AS uuid');if(plan&&(plan.database!==r.db||plan.server_uuid!==r.uuid))throw Error('Inventory media database identity changed');return r;}
export const inventoryInlinePlanHash=plan=>jsonArchiveHash(JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='sha256'))));

export async function auditInventoryInlineMedia(query,{tenantId,afterId=0,limit=10}={}){
 if(!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid inventory media audit bounds');
 const filter=await scope(query,tenantId),id=await identity(query);
 const rows=await query(`SELECT id,OCTET_LENGTH(COALESCE(image_url,''))+OCTET_LENGTH(COALESCE(detail_image_urls,'')) AS original_bytes,
  IF(OCTET_LENGTH(COALESCE(image_url,''))+OCTET_LENGTH(COALESCE(detail_image_urls,''))<=62914560,image_url,NULL) AS image_url,
  IF(OCTET_LENGTH(COALESCE(image_url,''))+OCTET_LENGTH(COALESCE(detail_image_urls,''))<=62914560,detail_image_urls,NULL) AS detail_image_urls
  FROM products WHERE ${filter.sql} AND id>? AND (image_url LIKE 'data:%' OR detail_image_urls LIKE '%data:%') ORDER BY id LIMIT ?`,[...filter.params,afterId,limit]);
 const items=[],retained=[];
 for(const row of rows){if(Number(row.original_bytes)>60*1024**2){retained.push({id:Number(row.id),reason:'over_60_mib_original_preserved'});continue;}items.push({id:Number(row.id),original_sha256:jsonArchiveHash(text(row)),old_bytes:Buffer.byteLength(text(row))});}
 const plan={format:'inventory-inline-media-review-v1',tenant_id:tenantId,database:id.db,server_uuid:id.uuid,after_id:afterId,next_after_id:Number(rows.at(-1)?.id||afterId),has_more:rows.length===limit,items,retained};return {...plan,sha256:inventoryInlinePlanHash(plan)};
}

export async function applyInventoryInlineMedia({query,transaction,plan,prepare=prepareInventoryInlineMedia,archive=archivePrivateJson,beforeUpdate=async()=>{},afterUpdate=async()=>{}}){
 if(plan.format!=='inventory-inline-media-review-v1'||plan.sha256!==inventoryInlinePlanHash(plan))throw Error('Invalid reviewed inventory media plan');
 await identity(query,plan);const filter=await scope(query,plan.tenant_id),report={format:'inventory-inline-media-result-v1',tenant_id:plan.tenant_id,database:plan.database,server_uuid:plan.server_uuid,updated:[],retained:[]};
 try{for(const item of plan.items){
  if(!Number.isSafeInteger(item.id)||item.id<=0)throw Error('Invalid inventory media row');
  const load=(q,lock='')=>q(`SELECT image_url,detail_image_urls FROM products WHERE ${filter.sql} AND id=?${lock}`,[...filter.params,item.id]);
  const [old]=await load(query);if(!old||jsonArchiveHash(text(old))!==item.original_sha256){report.retained.push({id:item.id,reason:'source_changed'});continue;}
  const result=await prepare(old),next={image_url:result.image_url,detail_image_urls:Array.isArray(result.detail_image_urls)?JSON.stringify(result.detail_image_urls):result.detail_image_urls};
  if(/^data:/i.test(next.image_url||'')||/data:(?:image|video)\//i.test(next.detail_image_urls||''))throw Error('Inline binary media remains; refuse database write');
  const backup=await archive(text(old),{namespace:`inventory-media/${plan.tenant_id}`});
  const proof={...item,new_sha256:jsonArchiveHash(text(next)),archive:backup};await beforeUpdate(proof);
  const applied=await transaction(async q=>{
   const [locked]=await load(q,' FOR UPDATE');if(!locked||jsonArchiveHash(text(locked))!==item.original_sha256)return false;
   const changed=await q(`UPDATE products SET image_url=?,detail_image_urls=?,updated_at=updated_at WHERE ${filter.sql} AND id=?`,[next.image_url,next.detail_image_urls,...filter.params,item.id]);if(Number(changed.affectedRows)!==1)throw Error('Inventory media update count mismatch');
   const [persisted]=await load(q);assert.equal(jsonArchiveHash(text(persisted)),proof.new_sha256);return true;
  });
  if(applied){report.updated.push(proof);await afterUpdate(proof);}else report.retained.push({id:item.id,reason:'source_changed_after_archive'});
 }}catch(error){error.partialReport=report;throw error;}return report;
}

export async function restoreInventoryInlineMedia({query,transaction,report,read=readPrivateJson}){
 if(report.format!=='inventory-inline-media-result-v1')throw Error('Invalid inventory media recovery report');await identity(query,report);const filter=await scope(query,report.tenant_id);let restored=0;
 for(const item of report.updated){
  if(!Number.isSafeInteger(item.id)||item.id<=0||!item.archive.objectKey.startsWith(`database-archives/inventory-media/${report.tenant_id}/`))throw Error('Inventory recovery tenant mismatch');
  const original=await read(item.archive);assert.equal(jsonArchiveHash(original),item.original_sha256);const data=JSON.parse(original);
  restored+=await transaction(async q=>{
   const [row]=await q(`SELECT image_url,detail_image_urls FROM products WHERE ${filter.sql} AND id=? FOR UPDATE`,[...filter.params,item.id]);if(!row||jsonArchiveHash(text(row))!==item.new_sha256)throw Error('Product media edited since migration; restore refused');
   const changed=await q(`UPDATE products SET image_url=?,detail_image_urls=?,updated_at=updated_at WHERE ${filter.sql} AND id=?`,[data.image_url,data.detail_image_urls,...filter.params,item.id]);if(Number(changed.affectedRows)!==1)throw Error('Inventory media restore count mismatch');return 1;
  });
 }return {restored};
}

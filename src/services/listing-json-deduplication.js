import assert from "node:assert/strict";
import {jsonArchiveHash,archivePrivateJson,readPrivateJson} from "./private-json-archive.js";
import {encodeFrozenContentStorage} from "./listing-frozen-codec.js";
import {assertListingFrozenContentReady,freezeListingCategoryDefinition,freezeEnterpriseListingMaster,encodeFrozenListingDraftPayload,assembleFrozenListingDraftPayload} from "./listing-frozen-content.js";

export const LISTING_JSON_REVIEW_FORMAT="listing-json-dedup-v1";
const tenantPredicate=tenant=>tenant==="admin"?"(tenant_id='admin' OR tenant_id IS NULL)":"tenant_id=?";
const tenantParams=tenant=>tenant==="admin"?[]:[tenant];
export const listingJsonReviewHash=plan=>jsonArchiveHash(JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=="sha256"))));
function owner(value){if(!/^(?:admin|[1-9][0-9]*)$/.test(String(value||"")))throw new Error("Explicit enterprise storage ID required");return String(value);}
function category(payload){
  const editable=payload.editable_payload||{},key=String(payload.ozon_category_id||editable.ozon_category_id||"").split(":");
  const descriptionCategoryId=Number(payload.description_category_id||editable.description_category_id||key[0]);
  const typeId=Number(payload.type_id||editable.type_id||key[1]);
  if(!Number.isSafeInteger(descriptionCategoryId)||descriptionCategoryId<=0||!Number.isSafeInteger(typeId)||typeId<=0)throw new Error("Frozen category identity unavailable; retain legacy row");
  return {descriptionCategoryId,typeId};
}
export async function auditListingJsonDuplicates(query,{tenantId,afterId=0,limit=200}={}){
  const tenant=owner(tenantId);
  if(!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(limit)||limit<2||limit>1000)throw new Error("Invalid JSON audit bounds");
  const [identity]=await query("SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid");
  const rows=await query(`SELECT id,SHA2(template_payload_json,256) AS payload_sha256,OCTET_LENGTH(template_payload_json) AS payload_bytes
    FROM listing_drafts WHERE ${tenantPredicate(tenant)} AND id>? AND status<>'deleted'
      AND template_payload_json IS NOT NULL AND OCTET_LENGTH(template_payload_json)<=8388608 ORDER BY id LIMIT ?`,[...tenantParams(tenant),afterId,limit]);
  const groups=new Map();
  for(const row of rows){const key=row.payload_sha256;if(!key)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({id:Number(row.id),bytes:Number(row.payload_bytes)});}
  const duplicates=[];
  for(const [sha256,items]of groups){
    if(items.length===1&&items[0].bytes<32768)continue;
    const [row]=await query(`SELECT template_payload_json FROM listing_drafts WHERE ${tenantPredicate(tenant)} AND id=? AND SHA2(template_payload_json,256)=?`,[...tenantParams(tenant),items[0].id,sha256]);
    if(!row)continue;
    let payload;try{payload=JSON.parse(row.template_payload_json);category(payload);}catch{continue;}
    if(payload._listing_frozen_content_v1)continue;
    const compressedBytes=Buffer.byteLength(JSON.stringify(encodeFrozenContentStorage({category_hash:"0".repeat(64),payload})))+1024;
    const maximum_saving_bytes=items.reduce((s,x)=>s+x.bytes,0)-compressedBytes;
    if(maximum_saving_bytes>0)duplicates.push({sha256,items,compressed_master_estimate_bytes:compressedBytes,maximum_saving_bytes});
  }
  const plan={format:LISTING_JSON_REVIEW_FORMAT,database:identity.database_name,server_uuid:identity.server_uuid,tenant_id:tenant,
    sampled_rows:rows.length,after_id:afterId,next_after_id:Number(rows.at(-1)?.id||afterId),has_more:rows.length===limit,groups:duplicates,
    maximum_saving_bytes:duplicates.reduce((sum,g)=>sum+g.maximum_saving_bytes,0),financial_history_rows_changed:0};
  return {...plan,sha256:listingJsonReviewHash(plan)};
}
export async function applyListingJsonDuplicates({query,transaction,plan,archive=archivePrivateJson}){
  if(plan.format!==LISTING_JSON_REVIEW_FORMAT||listingJsonReviewHash(plan)!==plan.sha256)throw new Error("Invalid reviewed JSON deduplication plan");
  const tenant=owner(plan.tenant_id),[identity]=await query("SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid");
  if(identity.database_name!==plan.database||identity.server_uuid!==plan.server_uuid)throw new Error("JSON deduplication database identity changed");
  await assertListingFrozenContentReady(query,{required:true});
  const report={format:"listing-json-dedup-result-v1",database:plan.database,server_uuid:plan.server_uuid,tenant_id:tenant,plan_sha256:plan.sha256,updated:[],retained:[],financial_history_rows_changed:0};
  try { for(const group of plan.groups){
    if(!/^[a-f0-9]{64}$/.test(group.sha256)||group.items.length<1||group.items.some(x=>!Number.isSafeInteger(x.id)||x.id<=0))throw new Error("Invalid duplicate group");
    const ids=group.items.map(x=>x.id),placeholders=ids.map(()=>"?").join(",");
    const load=q=>q(`SELECT id,tenant_id,template_payload_json FROM listing_drafts WHERE ${tenantPredicate(tenant)} AND id IN (${placeholders}) AND status<>'deleted' ORDER BY id`,[...tenantParams(tenant),...ids]);
    const rows=await load(query);
    if(rows.length!==ids.length||rows.some(r=>jsonArchiveHash(r.template_payload_json)!==group.sha256)){report.retained.push({ids,reason:"source_changed"});continue;}
    const original=rows[0].template_payload_json,payload=JSON.parse(original);
    if(payload._listing_frozen_content_v1){report.retained.push({ids,reason:"already_frozen"});continue;}
    let official;try{official=category(payload);}catch(error){report.retained.push({ids,reason:error.message});continue;}
    // Exact original bytes are privately archived and read back before any MySQL mutation.
    const archived=await archive(original,{namespace:`listing-drafts/${tenant}`});
    const applied=await transaction(async q=>{
      const locked=await q(`SELECT id,tenant_id,template_payload_json FROM listing_drafts WHERE ${tenantPredicate(tenant)} AND id IN (${placeholders}) AND status<>'deleted' ORDER BY id FOR UPDATE`,[...tenantParams(tenant),...ids]);
      if(locked.length!==ids.length||locked.some(r=>jsonArchiveHash(r.template_payload_json)!==group.sha256))return null;
      const frozenCategory=await freezeListingCategoryDefinition(q,official);
      const master=await freezeEnterpriseListingMaster(q,{tenantId:tenant,categoryHash:frozenCategory.hash,payload,compressed:true});
      const stored=await encodeFrozenListingDraftPayload(q,{tenantId:tenant,masterHash:master.hash,payload});
      assert.deepEqual(await assembleFrozenListingDraftPayload(q,{tenantId:tenant,storedPayload:stored}),payload);
      const text=JSON.stringify(stored);
      // Account for the one retained immutable master; do not expand small JSON.
      const [masterRow]=await q("SELECT OCTET_LENGTH(payload_json) AS bytes FROM listing_frozen_content WHERE tenant_id=? AND content_kind='product_master' AND content_hash=?",[tenant,master.hash]);
      const masterBytes=Number(masterRow.bytes);
      if(Buffer.byteLength(text)*locked.length+masterBytes>=Buffer.byteLength(original)*locked.length)throw new Error("Draft group has no net storage saving");
      const result=await q(`UPDATE listing_drafts SET template_payload_json=? WHERE ${tenantPredicate(tenant)} AND id IN (${placeholders}) AND SHA2(template_payload_json,256)=?`,[text,...tenantParams(tenant),...ids,group.sha256]);
      if(Number(result.affectedRows)!==locked.length)throw new Error("Draft JSON compare-and-swap count mismatch");
      const persisted=await load(q);
      for(const row of persisted)assert.deepEqual(await assembleFrozenListingDraftPayload(q,{tenantId:tenant,storedPayload:JSON.parse(row.template_payload_json)}),payload);
      return {ids,archive:archived,stored_sha256:jsonArchiveHash(text),old_bytes:Buffer.byteLength(original)*locked.length,new_row_bytes:Buffer.byteLength(text)*locked.length,immutable_master_bytes:masterBytes};
    });
    if(applied)report.updated.push(applied);else report.retained.push({ids,reason:"source_changed_after_archive"});
  } } catch(error) { error.partialReport=report;throw error; }
  return report;
}
export async function restoreListingJsonDuplicates({query,transaction,report,read=readPrivateJson}){
  const tenant=owner(report.tenant_id),[identity]=await query("SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid");
  if(report.format!=="listing-json-dedup-result-v1"||identity.database_name!==report.database||identity.server_uuid!==report.server_uuid)throw new Error("Invalid JSON restore identity");
  let restored=0;
  for(const group of report.updated){
    if(!group.archive.objectKey.startsWith(`database-archives/listing-drafts/${tenant}/`))throw new Error("Archive tenant differs from restore tenant");
    const original=await read(group.archive);
    restored+=await transaction(async q=>{
      const ids=group.ids;if(ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error("Invalid restore IDs");
      const placeholders=ids.map(()=>"?").join(",");
      const rows=await q(`SELECT id,template_payload_json FROM listing_drafts WHERE ${tenantPredicate(tenant)} AND id IN (${placeholders}) ORDER BY id FOR UPDATE`,[...tenantParams(tenant),...ids]);
      if(rows.length!==ids.length||rows.some(r=>jsonArchiveHash(r.template_payload_json)!==group.stored_sha256))throw new Error("Draft changed since compaction; restore refused");
      const result=await q(`UPDATE listing_drafts SET template_payload_json=? WHERE ${tenantPredicate(tenant)} AND id IN (${placeholders}) AND SHA2(template_payload_json,256)=?`,[original,...tenantParams(tenant),...ids,group.stored_sha256]);
      if(Number(result.affectedRows)!==ids.length)throw new Error("JSON restore count mismatch");return ids.length;
    });
  }
  return {restored};
}

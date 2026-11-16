import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeListingJsonSections,decodeListingJsonSections} from './listing-json-sections.js';
import {archivePrivateJson,readPrivateJson} from './private-json-archive.js';

const RULES={listing_drafts:['manual_facts_json','ai_payload_json'],listing_category_templates:['editable_payload_json','attributes_json']};
const digest=text=>createHash('sha256').update(text).digest('hex');
export const listingSectionPlanHash=plan=>digest(JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='sha256'))));
function scope(tenant){if(!/^(?:admin|[1-9][0-9]*)$/.test(String(tenant||'')))throw Error('Explicit tenant required');return tenant==='admin'?{sql:"(tenant_id='admin' OR tenant_id IS NULL)",params:[]}:{sql:'tenant_id=?',params:[tenant]};}
function validate(plan){if(plan.format!=='listing-section-review-v1'||listingSectionPlanHash(plan)!==plan.sha256||!Object.hasOwn(RULES,plan.table))throw Error('Invalid reviewed listing section plan');return scope(plan.tenant_id);}
async function identity(query,plan){const [id]=await query('SELECT DATABASE() AS db,@@server_uuid AS uuid');if(plan&&(id.db!==plan.database||id.uuid!==plan.server_uuid))throw Error('Database identity changed');return id;}
function namespace(table,tenant){return `${table==='listing_drafts'?'listing-drafts':'listing-templates'}/${tenant}`;}

export async function auditListingSections(query,{tenantId,table,afterId=0,limit=10}={}){
 const filter=scope(tenantId);if(!Object.hasOwn(RULES,table)||!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid bounded listing section audit');
 const id=await identity(query),fields=RULES[table];
 const rows=await query(`SELECT id,${fields.map(field=>`OCTET_LENGTH(${field}) AS ${field}_bytes,IF(OCTET_LENGTH(${field})<=67108864,${field},NULL) AS ${field}`).join(',')} FROM ${table} WHERE ${filter.sql} AND id>? AND status<>'deleted' ORDER BY id LIMIT ?`,[...filter.params,afterId,limit]);
 const items=[],retained=[];
 for(const row of rows)for(const field of fields){
  const original=row[field];if(!original){if(Number(row[field+'_bytes'])>67108864)retained.push({id:Number(row.id),field,reason:'over_64_mib_original_preserved'});continue;}
  const encoded=encodeListingJsonSections(original);
  if(encoded!==original){assert.deepEqual(JSON.parse(decodeListingJsonSections(encoded)),JSON.parse(original));items.push({id:Number(row.id),field,original_sha256:digest(original),stored_sha256:digest(encoded),old_bytes:Buffer.byteLength(original),new_bytes:Buffer.byteLength(encoded)});}
 }
 const plan={format:'listing-section-review-v1',database:id.db,server_uuid:id.uuid,tenant_id:tenantId,table,after_id:afterId,next_after_id:Number(rows.at(-1)?.id||afterId),has_more:rows.length===limit,rows:rows.length,items,retained,old_bytes:items.reduce((n,x)=>n+x.old_bytes,0),new_bytes:items.reduce((n,x)=>n+x.new_bytes,0)};
 return {...plan,sha256:listingSectionPlanHash(plan)};
}

export async function applyListingSections({query,transaction,plan,archive=archivePrivateJson,beforeUpdate=async()=>{},afterUpdate=async()=>{}}){
 const filter=validate(plan);await identity(query,plan);
 const report={format:'listing-section-result-v1',database:plan.database,server_uuid:plan.server_uuid,tenant_id:plan.tenant_id,table:plan.table,plan_sha256:plan.sha256,updated:[],retained:[]};
 try{for(const item of plan.items){
  if(!RULES[plan.table].includes(item.field)||!Number.isSafeInteger(item.id)||item.id<=0)throw Error('Invalid reviewed listing field');
  const load=(q,lock='')=>q(`SELECT ${item.field} AS original FROM ${plan.table} WHERE ${filter.sql} AND id=? AND status<>'deleted'${lock}`,[...filter.params,item.id]);
  const [row]=await load(query);if(!row||digest(row.original)!==item.original_sha256){report.retained.push({id:item.id,field:item.field,reason:'source_changed'});continue;}
  const stored=encodeListingJsonSections(row.original);if(digest(stored)!==item.stored_sha256)throw Error('Compactor changed since review');
  const backup=await archive(row.original,{namespace:namespace(plan.table,plan.tenant_id)});
  // Persist the recovery mapping before the commit. An interrupted process can
  // restore from this durable journal even before a whole-page report exists.
  const proof={...item,archive:backup};await beforeUpdate(proof);
  const applied=await transaction(async q=>{
   const [locked]=await load(q,' FOR UPDATE');if(!locked||digest(locked.original)!==item.original_sha256)return false;
   assert.deepEqual(JSON.parse(decodeListingJsonSections(stored)),JSON.parse(locked.original));
   const update=await q(`UPDATE ${plan.table} SET ${item.field}=?,updated_at=updated_at WHERE ${filter.sql} AND id=? AND SHA2(${item.field},256)=?`,[stored,...filter.params,item.id,item.original_sha256]);
   if(Number(update.affectedRows)!==1)throw Error('Listing section compare-and-swap mismatch');
   const [persisted]=await load(q);assert.equal(digest(persisted.original),item.stored_sha256);assert.deepEqual(JSON.parse(decodeListingJsonSections(persisted.original)),JSON.parse(locked.original));return true;
  });
  if(applied){report.updated.push(proof);await afterUpdate(proof);}else report.retained.push({id:item.id,field:item.field,reason:'source_changed_after_archive'});
 }}catch(error){error.partialReport=report;throw error;}
 return report;
}

export async function restoreListingSections({query,transaction,report,read=readPrivateJson}){
 if(report.format!=='listing-section-result-v1'||!Object.hasOwn(RULES,report.table))throw Error('Invalid listing section restore report');
 const filter=scope(report.tenant_id);await identity(query,report);let restored=0;
 for(const item of report.updated){
  if(!RULES[report.table].includes(item.field)||!Number.isSafeInteger(item.id)||item.id<=0||!item.archive.objectKey.startsWith(`database-archives/${namespace(report.table,report.tenant_id)}/`))throw Error('Invalid listing section recovery mapping');
  const original=await read(item.archive);if(digest(original)!==item.original_sha256)throw Error('Recovery original checksum mismatch');
  restored+=await transaction(async q=>{
   const [row]=await q(`SELECT ${item.field} AS stored_value FROM ${report.table} WHERE ${filter.sql} AND id=? FOR UPDATE`,[...filter.params,item.id]);
   if(!row||digest(row.stored_value)!==item.stored_sha256)throw Error('Draft/template edited since compression; restore refused');
   const changed=await q(`UPDATE ${report.table} SET ${item.field}=?,updated_at=updated_at WHERE ${filter.sql} AND id=? AND SHA2(${item.field},256)=?`,[original,...filter.params,item.id,item.stored_sha256]);
   if(Number(changed.affectedRows)!==1)throw Error('Listing section recovery compare-and-swap mismatch');return 1;
  });
 }
 return {restored};
}

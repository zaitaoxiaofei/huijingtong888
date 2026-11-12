import {restoreReviewedSingleFissionVariant} from '../../src/shared/reviewed-single-fission-variant.js';
import {reviewedCopyHash} from './reviewed-ai-fission-copy.mjs';
import {writeAiFissionCleanupBackup} from './ai-fission-variant-cleanup.mjs';
import {retargetVariantVehicleAttributes} from '../../src/shared/variant-vehicle-attributes.js';
import {variantCopyContainsIdentity,variantVehicleIdentity} from '../../src/shared/variant-copy-identity.js';
import {vehicleMetaFromTarget} from '../../src/services/product-development-meta.js';
const fail=message=>{throw Object.assign(new Error(message),{safe:true});};
const hash=row=>reviewedCopyHash({...row,updated_at:null});
const query=async(db,sql,params)=>(await db.query(sql,params))[0];
const jsonColumns={listing_drafts:['template_payload_json','manual_facts_json'],listing_category_templates:['editable_payload_json','attributes_json']};
const normalize=updates=>Object.fromEntries(Object.entries(updates).map(([k,v])=>[k,k.endsWith('_json')?JSON.parse(v):v]));
export async function inspectReviewedVariantCompatibility(db,manifest,{lock=false}={}) {
 if(manifest?.version!==1||!/^(admin|[1-9][0-9]*)$/.test(manifest.tenant_id)||!Array.isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>100)fail('Explicit reviewed compatibility manifest required');
 const suffix=lock?' FOR UPDATE':'',rows=[],seen=new Set();
 for(const entry of manifest.entries){
  if(!jsonColumns[entry.table]||!Number.isSafeInteger(entry.id)||entry.id<=0||!Number.isSafeInteger(entry.draft_id)||entry.draft_id<=0||entry.tenant_id!==manifest.tenant_id||seen.has(`${entry.table}:${entry.id}`))fail('Invalid reviewed compatibility identity');
  seen.add(`${entry.table}:${entry.id}`);
  const [before]=await query(db,`SELECT * FROM ${entry.table} WHERE id = ?${suffix}`,[entry.id]);
  if(!before||String(before.tenant_id??'admin')!==manifest.tenant_id||before.status==='deleted')fail('Reviewed compatibility ownership changed');
  if(hash(before)===entry.after_sha){rows.push({entry,before,already_applied:true});continue;}
  if(hash(before)!==entry.expected_sha)fail('Reviewed row changed after copy recovery plan');
  const vehicle=vehicleMetaFromTarget(entry.target);if(!vehicle)fail('Unrecognized reviewed vehicle');
  let draft=before;
  if(entry.table==='listing_category_templates'){
   const refs=await query(db,`SELECT id, tenant_id FROM listing_drafts WHERE template_id = ?${suffix}`,[entry.id]);
   if(refs.length!==1||Number(refs[0].id)!==entry.draft_id||String(refs[0].tenant_id??'admin')!==manifest.tenant_id)fail('Reviewed template is shared');
   [draft]=await query(db,`SELECT * FROM listing_drafts WHERE id = ?${suffix}`,[entry.draft_id]);
  }
  if(!draft||draft.status!=='draft'||String(draft.tenant_id??'admin')!==manifest.tenant_id||!variantCopyContainsIdentity(draft.product_name,entry.target))fail('Reviewed target does not match the draft');
  const savedTarget=JSON.parse(draft.ai_payload_json||'{}').ai_optimization?.target_variant_value;
  if(savedTarget&&variantVehicleIdentity(savedTarget).toLowerCase()!==variantVehicleIdentity(entry.target).toLowerCase())fail('Reviewed target differs from saved target');
  const template=JSON.parse(draft.template_payload_json||'{}')||{},editable=template.editable_payload||template;
  const options={};
  for(const[id,value]of [[7204,vehicle.vehicle_brand],[7212,vehicle.vehicle_model]])options[id]=await query(db,"SELECT dictionary_value_id, value, display_value_zh AS label FROM ozon_attribute_values WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND status = 'active' AND (value = ? OR display_value_zh = ?)",[Number(editable.description_category_id||0),Number(editable.type_id||0),id,value,value]);
  const computed=entry.table==='listing_drafts'?Object.fromEntries(Object.entries(vehicle).filter(([k,v])=>before[k]!==v)):{};
  if(entry.metadata_only && entry.table!=='listing_drafts')fail('Metadata-only mode requires a draft');
  for(const column of entry.metadata_only ? [] : jsonColumns[entry.table]){
   const old=JSON.parse(before[column]);let next=retargetVariantVehicleAttributes(old,vehicle,options);
   if(entry.single_variant===true&&column!=='attributes_json'){
     const canonical=retargetVariantVehicleAttributes(editable,vehicle,options);
     next=restoreReviewedSingleFissionVariant(next,{offerId:draft.internal_code,title:draft.product_name,canonical,images:JSON.parse(draft.source_images_json||'[]')});
   }
   if(reviewedCopyHash(old)!==reviewedCopyHash(next))computed[column]=JSON.stringify(next);
  }
  if(reviewedCopyHash(normalize(computed))!==reviewedCopyHash(normalize(entry.updates)))fail(`Reviewed updates are not the exact dictionary/identity repair: ${entry.table} #${entry.id}`);
  if(hash({...before,...entry.updates})!==entry.after_sha)fail('Reviewed result hash mismatch');
  rows.push({entry,before,already_applied:false});
 }
 return {rows,changed_rows:rows.filter(x=>!x.already_applied).length};
}
export async function applyReviewedVariantCompatibility(db,manifest,directory,{backup=writeAiFissionCleanupBackup}={}) {
 const before=await inspectReviewedVariantCompatibility(db,manifest);
 const backupFile=before.changed_rows?await backup(directory,{version:1,manifest,before:before.rows.map(x=>({table:x.entry.table,row:x.before}))}):null;
 await db.beginTransaction();
 try{
  const plan=await inspectReviewedVariantCompatibility(db,manifest,{lock:true});
  for(const {entry,already_applied}of plan.rows){
   if(already_applied)continue;
   const columns=Object.keys(entry.updates);
   const result=await query(db,`UPDATE ${entry.table} SET ${columns.map(k=>`${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id, 'admin') = ?`,[...columns.map(k=>entry.updates[k]),entry.id,manifest.tenant_id]);
   if(Number(result.affectedRows)!==1)fail('Reviewed compatibility row was not updated');
  }
  const verified=await inspectReviewedVariantCompatibility(db,manifest,{lock:true});if(verified.changed_rows)fail('Compatibility repair verification failed');
  await db.commit();return {changed_rows:plan.changed_rows,backup:backupFile};
 }catch(error){await db.rollback();throw error;}
}

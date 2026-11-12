import test from 'node:test';
import {restoreReviewedSingleFissionVariant} from '../src/shared/reviewed-single-fission-variant.js';
import assert from 'node:assert/strict';
import {reviewedCopyHash} from '../scripts/lib/reviewed-ai-fission-copy.mjs';
import {inspectReviewedVariantCompatibility,applyReviewedVariantCompatibility} from '../scripts/lib/reviewed-variant-compatibility.mjs';
import {retargetVariantVehicleAttributes} from '../src/shared/variant-vehicle-attributes.js';
const hash=row=>reviewedCopyHash({...row,updated_at:null});
function fixture(){
 const value={description_category_id:17028749,type_id:97381,price:456,images:['original.png'],attributes:[{attribute_id:7204,value:['Tenet'],values:[{dictionary_value_id:1,value:'Tenet'}]}]};
 let row={id:1,tenant_id:'admin',status:'draft',product_name:'Чехол VOLKSWAGEN Golf',vehicle_brand:'VAR',vehicle_model:'VOLKSWAGEN',vehicle_model_key:'VAR:VOLKSWAGEN',template_payload_json:JSON.stringify(value),manual_facts_json:JSON.stringify(value),ai_payload_json:JSON.stringify({ai_optimization:{target_variant_value:'VOLKSWAGEN Golf'}}),updated_at:'before'};
 const vehicle={vehicle_brand:'VOLKSWAGEN',vehicle_model:'Golf',vehicle_model_key:'volkswagen-golf'},options={7204:[{dictionary_value_id:58175,value:'Volkswagen',label:'Volkswagen'}]};
 const updates={...vehicle,template_payload_json:JSON.stringify(retargetVariantVehicleAttributes(value,vehicle,options)),manual_facts_json:JSON.stringify(retargetVariantVehicleAttributes(value,vehicle,options))};
 const manifest={version:1,tenant_id:'admin',entries:[{table:'listing_drafts',id:1,draft_id:1,tenant_id:'admin',target:'VOLKSWAGEN Golf',expected_sha:hash(row),updates,after_sha:hash({...row,...updates})}]};
 let saved,writes=0;
 const db={beginTransaction:async()=>{saved=structuredClone(row);},commit:async()=>{},rollback:async()=>{if(saved)row=saved;},query:async(sql,params)=>{
  if(sql.startsWith('SELECT * FROM listing_drafts'))return [[structuredClone(row)]];
  if(sql.includes('FROM ozon_attribute_values'))return [params[2]===7204?options[7204]:[]];
  if(sql.startsWith('UPDATE listing_drafts')){writes++;Object.keys(updates).forEach((k,i)=>row[k]=params[i]);row.updated_at='after';return[{affectedRows:1}];}
  throw Error('unexpected SQL');
 }};
 return {db,manifest,get row(){return row;},get writes(){return writes;}};
}
test('compatibility repair only uses official dictionary options and preserves unrelated price/media',async()=>{
 const f=fixture(); const planned=await inspectReviewedVariantCompatibility(f.db,f.manifest);assert.equal(planned.changed_rows,1);
 const result=await applyReviewedVariantCompatibility(f.db,f.manifest,'/private/backups',{backup:async()=>'/private/backups/original.json'});
 assert.equal(result.changed_rows,1);assert.equal(f.row.vehicle_brand,'VOLKSWAGEN');assert.equal(JSON.parse(f.row.template_payload_json).price,456);assert.deepEqual(JSON.parse(f.row.template_payload_json).images,['original.png']);
 assert.equal((await applyReviewedVariantCompatibility(f.db,f.manifest,'/private/backups',{backup:async()=>{throw Error('no second backup needed');}})).changed_rows,0);
});
test('stale rows, changed prices and forged dictionary selections fail before writes',async()=>{
 for(const kind of ['stale','price','dictionary']){
  const f=fixture(),entry=f.manifest.entries[0];
  if(kind==='stale')entry.expected_sha='0'.repeat(64);
  else {const json=JSON.parse(entry.updates.template_payload_json);if(kind==='price')json.price=1;else json.attributes[0].values[0].dictionary_value_id=999;entry.updates.template_payload_json=JSON.stringify(json);}
  await assert.rejects(applyReviewedVariantCompatibility(f.db,f.manifest,'/private/backups',{backup:async()=>'/private/backup'}));assert.equal(f.writes,0);
 }
});
test('backup failure prevents any compatibility write',async()=>{
 const f=fixture();await assert.rejects(applyReviewedVariantCompatibility(f.db,f.manifest,'/private/backups',{backup:async()=>{throw Error('backup unavailable');}}));assert.equal(f.writes,0);
});

test('reviewed single-product compatibility plan reconstructs current media and rejects forged source price',async()=>{
 const f=fixture(),entry=f.manifest.entries[0];
 f.row.internal_code='AI-GOLF';f.row.source_images_json=JSON.stringify(['current.png']);
 for(const column of ['template_payload_json','manual_facts_json']){const value=JSON.parse(f.row[column]);value.price={value:361,old_price:1379,currency_code:'CNY'};value.variants=[{sku:'old1',offer_id:'old1',price:1},{sku:'old2',offer_id:'old2'}];f.row[column]=JSON.stringify(value);}
 entry.single_variant=true;entry.expected_sha=hash(f.row);
 for(const column of ['template_payload_json','manual_facts_json']){const corrected=JSON.parse(entry.updates[column]);corrected.price={value:361,old_price:1379,currency_code:'CNY'};entry.updates[column]=JSON.stringify(restoreReviewedSingleFissionVariant(corrected,{offerId:'AI-GOLF',title:f.row.product_name,canonical:corrected,images:['current.png']}));}
 entry.after_sha=hash({...f.row,...entry.updates});
 assert.equal((await inspectReviewedVariantCompatibility(f.db,f.manifest)).changed_rows,1);
 const forged=structuredClone(f.manifest),value=JSON.parse(forged.entries[0].updates.template_payload_json);value.variants[0].price=1;forged.entries[0].updates.template_payload_json=JSON.stringify(value);
 await assert.rejects(inspectReviewedVariantCompatibility(f.db,forged));assert.equal(f.writes,0);
});

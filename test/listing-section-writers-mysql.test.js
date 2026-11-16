import test from 'node:test';import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('enabled real template/draft writers persist compact sections and API edits retain values and manual empty images',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const f=await createTenantMysqlFixture('section_writers');let close;
 const previous=process.env.LISTING_SECTION_STORAGE_ENABLED,oldFetch=globalThis.fetch;
 try{
  f.useEnvironment();process.env.LISTING_SECTION_STORAGE_ENABLED='1';globalThis.fetch=async()=>{throw Error('External network forbidden in storage writer test');};
  ({closeMysqlPool:close}=await import('../src/mysql-pool.js'));const listing=await import('../src/services/listing-automation.js');await listing.ensureListingAutomationSchema();
  const q=async(sql,p=[])=>(await f.connection.query(sql,p))[0];
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'two','A'),(3,'three','B')");await q("INSERT INTO people(id,name,role) VALUES(7,'Operator','operations')");await q("INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
  const session={personId:7,tenant:{id:2,slug:'two'}},attributes=Array.from({length:40},(_,i)=>({attribute_id:i+1,name:'Attribute '+i,value:'Selected',raw:{definition:{name:'Original'},options:'Original candidate details '.repeat(300)}}));
  const body={ozon_category_id:'100:200',category_name:'Category',template_name:'Storage template',title:'Storage template',attributes,images:[],editable_payload:{title:'Storage template',attributes,variants:[{offer_id:'SECTION-1',images:[],images_manually_edited:true,price:7000,attributes}]}};
  const template=await listing.createListingCategoryTemplate(body,session);assert(template.id);
  const [stored]=await q('SELECT editable_payload_json,attributes_json FROM listing_category_templates WHERE id=?',[template.id]);assert(stored.editable_payload_json.includes('_erp_listing_sections_v1'));assert(stored.attributes_json.includes('_erp_listing_leaf_gzip_v1'));assert.equal(template.attributes[0].raw.options,attributes[0].raw.options);
  const draft=await listing.createListingDraft({template_id:template.id,product_name:'Storage child',internal_code:'SECTION-1',template_payload:{...template,editable_payload:body.editable_payload},manual_facts:{}},session);
  const [facts]=await q('SELECT manual_facts_json FROM listing_drafts WHERE id=?',[draft.id]);assert(facts.manual_facts_json.includes('_erp_listing_sections_v1'));assert.equal(draft.manual_facts.attributes[0].raw.options,attributes[0].raw.options);
  const edited=await listing.updateListingDraft(draft.id,{template_id:template.id,product_name:'Edited child',internal_code:'SECTION-1',template_payload:{...draft.template_payload,editable_payload:{...draft.template_payload.editable_payload,variants:[{...draft.template_payload.editable_payload.variants[0],images:[],images_manually_edited:true,price:8000}]}}},session);
  assert.deepEqual(edited.effective_images,[]);assert.equal(edited.manual_facts.attributes[0].value,'Selected');
  for(const lightweight of ['0','1']){const rows=await listing.listingDrafts({ids:String(draft.id),paged:'1',lightweight},session);assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].id,draft.id);}
  const foreign=await listing.listingDrafts({ids:String(draft.id),paged:'1',lightweight:'0'},{personId:7,tenant:{id:3,slug:'three'}});assert.equal(foreign.rows.length,0);
 }finally{
  globalThis.fetch=oldFetch;if(previous===undefined)delete process.env.LISTING_SECTION_STORAGE_ENABLED;else process.env.LISTING_SECTION_STORAGE_ENABLED=previous;
  await close?.();await f.cleanup();
 }
});

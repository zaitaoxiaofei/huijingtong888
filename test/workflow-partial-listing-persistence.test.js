import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {DatabaseSync} from 'node:sqlite';

const source=fs.readFileSync(new URL('../src/services/listing-automation.js',import.meta.url),'utf8');
const declarations=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.flatMap(node=>{
  const declaration=node.type==='ExportNamedDeclaration'?node.declaration:node;
  return declaration?.type==='FunctionDeclaration'?[source.slice(declaration.start,declaration.end)]:[];
}).join('\n');
const session={personId:7,tenant:{id:2,slug:'fixture-enterprise'}};
const partial={source:'product_workflow',workflow_run_id:'fixture-run',completion_review:{mode:'partial',confirmedBy:7,ignoredNodes:[{variantId:'a',nodeId:'words',taskId:'original-copy'}]}};

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const columns=['tenant_id','template_id','product_name','internal_code','source_urls_json','source_images_json','cost_price','sale_price','length_cm','width_cm','height_cm','weight_g','color','spec','quantity','template_payload_json','manual_facts_json','ai_payload_json','created_by_person_id','development_type','vehicle_brand','vehicle_model','vehicle_model_key','source_product_id','parent_draft_id','creation_method','updated_at'];
  db.exec(`CREATE TABLE listing_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT 'draft', ${columns.map(name=>`${name} TEXT`).join(',')})`);
  const mother={id:23,title:'Old category title',description:'Old category description',attributes:[{attribute_id:501,name:'Old material',value:'Old category material'}],images:['https://fixture.invalid/old-category.png'],editable_payload:{title:'Old editable title',description:'Old editable description',tags:['#old'],source_raw:{old_product:'old product facts'},images:['https://fixture.invalid/old-category.png']}};
  const context=vm.createContext({Buffer,console,URL,URLSearchParams,Date,Set,Map,process});
  vm.runInContext(declarations,context);
  const raw=id=>db.prepare('SELECT * FROM listing_drafts WHERE id=?').get(id);
  const read=id=>{const value=raw(id);return {...value,template_id:Number(value.template_id),template_payload:JSON.parse(value.template_payload_json),manual_facts:JSON.parse(value.manual_facts_json),ai_payload:JSON.parse(value.ai_payload_json)};};
  let inserts=0,accessChecks=0;
  // Run the production create/update assembly, draft normalization, field/media
  // sanitizers and actual INSERT/UPDATE SQL; replace only external boundaries.
  Object.assign(context,{
    aiVariantSaveTraceId:()=>'',logAiVariantSavePerf:()=>{},ensureListingAutomationSchema:async()=>{},
    externalizeInlineMedia:async value=>value,materializeAiOptimizationDraftMedia:async value=>value,materializeListingDraftMediaForDraftSafety:async value=>value,rewriteDraftPayloadToRegisteredPublicMedia:async value=>value,
    assertDraftMediaIsPublishable:()=>{},authorizeBusinessTaskSession:async actor=>actor,
    resolveDraftDevelopmentMeta:()=>({development_type:'new',vehicle_brand:'',vehicle_model:'',vehicle_model_key:''}),resolveDevelopmentMeta:()=>({development_type:'new',vehicle_brand:'',vehicle_model:'',vehicle_model_key:''}),
    listingTenantId:actor=>String(actor.tenant.id),assertDraftSourceProductTenant:async(id,tenant)=>{assert.equal(id,0);assert.equal(tenant,'2');},
    row:async(sql,params)=>{assert.match(sql,/FROM listing_category_templates/);assert.deepEqual(Array.from(params),[23,'2']);return mother;},normalizeTemplateRow:value=>value,
    applyDraftSalePriceToTemplatePayload:value=>value,ensurePersistedDraftVariantIds:()=>{},serializeListingDraftTemplate:async value=>JSON.stringify(value),compactListingPersistencePayload:value=>value,encodeListingJsonForWrite:value=>value,
    insert:async(sql,params)=>{assert.match(sql,/INSERT INTO listing_drafts/);inserts++;return Number(db.prepare(sql).run(...params).lastInsertRowid);},listingDraft:async id=>read(id),
    assertDraftAccess:async(id,actor)=>{accessChecks++;assert.equal(actor.tenant.id,2);return read(id);}
  });
  return {context,raw,read,db,mother,get inserts(){return inserts;},get accessChecks(){return accessChecks;}};
}

function input(aiPayload=partial){return {template_id:23,product_name:'Internal workflow product',internal_code:'WF-fixture-run',source_images:[],template_payload:{title:'',name:'',description:'',attributes:[],primary_image:'',images:[],editable_payload:{title:'',name:'',description:'',attributes:[],images:[],variants:[{title:'',description:'',images:[],images_manually_edited:true,image_edit_intent:'manual'}]}},manual_facts:{workflow_run_id:'fixture-run'},ai_payload:structuredClone(aiPayload)};}

test('real partial-workflow draft INSERT preserves explicitly empty public facts and never restores category content',async t=>{
  const f=fixture(t),body=input();
  const result=await f.context.createListingDraft(body,session),stored=f.raw(result.id);
  const facts=JSON.parse(stored.manual_facts_json),template=JSON.parse(stored.template_payload_json);
  assert.equal(stored.product_name,'Internal workflow product');assert.equal(facts.title,'');assert.equal(facts.name,'');assert.equal(facts.description,'');
  assert.deepEqual(facts.attributes,[]);assert.deepEqual(facts.images,[]);assert.equal(facts.source_raw,undefined);assert.equal(facts.tags,undefined);
  assert.equal(template.title,'');assert.equal(template.editable_payload.title,'');assert.deepEqual(template.editable_payload.variants[0].images,[]);
  assert.equal(facts.user_facts.workflow_run_id,'fixture-run');assert.equal(f.inserts,1);
  assert.ok(!stored.manual_facts_json.includes('Old category'));assert.ok(!stored.manual_facts_json.includes('old-category.png'));
  assert.deepEqual(JSON.parse(stored.ai_payload_json).completion_review,partial.completion_review);
});

test('the partial-facts branch requires both workflow source and partial review while ordinary drafts retain existing behavior',async t=>{
  for(const aiPayload of [{source:'listing_draft'},{source:'product_workflow'},{source:'listing_draft',completion_review:{mode:'partial'}}]){
    const f=fixture(t),result=await f.context.createListingDraft(input(aiPayload),session),facts=JSON.parse(f.raw(result.id).manual_facts_json);
    assert.equal(facts.title,'Internal workflow product');assert.equal(facts.description,'Old category description');assert.equal(facts.attributes[0].attribute_id,501);
  }
});

test('server-loaded partial review survives a later editor save without overwriting the operators new public values',async t=>{
  const f=fixture(t),created=await f.context.createListingDraft(input(),session);
  const body=input({source:'listing_draft',workflow_run_id:'forged-run',completion_review:{mode:'partial',confirmedBy:999}});body.product_name='Renamed internal product';
  body.template_payload.title='Root title';body.template_payload.description='Root description';
  Object.assign(body.template_payload.editable_payload,{title:'Новый заголовок',name:'Новый заголовок',description:'Новое описание',attributes:[{attribute_id:502,name:'Current material',value:'Current confirmed material'}]});
  const prepared=await f.context.prepareListingDraftUpdate(created.id,body,session);
  await f.context.writeListingDraftUpdate(prepared,async(sql,params)=>({affectedRows:Number(f.db.prepare(sql).run(...params).changes)}));
  const stored=f.raw(created.id),facts=JSON.parse(stored.manual_facts_json),ai=JSON.parse(stored.ai_payload_json);
  assert.equal(facts.title,'Новый заголовок');assert.equal(facts.description,'Новое описание');assert.equal(facts.attributes[0].attribute_id,502);
  assert.deepEqual(facts.images,[]);assert.equal(facts.source_raw,undefined);assert.deepEqual(ai.completion_review,partial.completion_review);assert.equal(ai.source,'product_workflow');assert.equal(ai.workflow_run_id,'fixture-run');assert.equal(f.accessChecks,1);
});

test('a sparse partial editor update preserves the saved public facts rather than clearing them or reading the category',async t=>{
  const f=fixture(t),body=input();
  Object.assign(body.template_payload.editable_payload,{title:'Сохраненный заголовок',name:'Сохраненный заголовок',description:'Сохраненное описание',attributes:[{attribute_id:502,name:'Current material',value:'Current confirmed material'}]});
  const created=await f.context.createListingDraft(body,session);
  const prepared=await f.context.prepareListingDraftUpdate(created.id,{product_name:'Only internal name changed',source_images:[]},session);
  await f.context.writeListingDraftUpdate(prepared,async(sql,params)=>({affectedRows:Number(f.db.prepare(sql).run(...params).changes)}));
  const stored=f.raw(created.id),facts=JSON.parse(stored.manual_facts_json),template=JSON.parse(stored.template_payload_json);
  assert.equal(facts.title,'Сохраненный заголовок');assert.equal(facts.description,'Сохраненное описание');assert.equal(facts.attributes[0].attribute_id,502);
  assert.equal(template.editable_payload.title,'Сохраненный заголовок');assert.equal(template.editable_payload.description,'Сохраненное описание');
  assert.deepEqual(template.editable_payload.variants[0].images,[]);assert.equal(template.editable_payload.variants[0].image_edit_intent,'manual');assert.deepEqual(facts.images,[]);
  assert.ok(!stored.manual_facts_json.includes('Old category'));assert.deepEqual(JSON.parse(stored.ai_payload_json).completion_review,partial.completion_review);
});

test('an explicitly empty edited partial draft stays empty and body-provided fake existing metadata is ignored',async t=>{
  const f=fixture(t),created=await f.context.createListingDraft(input(),session),body=input({});
  body.existingAiPayload={source:'listing_draft'};
  const prepared=await f.context.prepareListingDraftUpdate(created.id,body,session);
  assert.equal(prepared.manualFacts.title,'');assert.equal(prepared.manualFacts.description,'');assert.equal(prepared.manualFacts.attributes.length,0);assert.equal(prepared.manualFacts.images.length,0);
  const ordinary=fixture(t),old=await ordinary.context.createListingDraft(input({source:'listing_draft'}),session);
  const fake=input({});fake.existingAiPayload=partial;
  const unchanged=await ordinary.context.prepareListingDraftUpdate(old.id,fake,session);
  assert.equal(unchanged.manualFacts.description,'Old category description');assert.equal(unchanged.manualFacts.attributes[0].attribute_id,501);
});

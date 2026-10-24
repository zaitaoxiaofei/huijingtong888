import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "acorn";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import {
  freezeListingCategoryDefinition, freezeEnterpriseListingMaster,
  encodeFrozenListingDraftPayload, assembleFrozenListingDraftPayload, assembleListingDraftStoredRow, createListingFrozenReadScope, assertListingFrozenContentReady
} from "../src/services/listing-frozen-content.js";
import { migrateListingFrozenContent } from "../scripts/migrate-listing-frozen-content.mjs";

test("draft row assembly accepts only explicit ownership or legacy default NULL",async()=>{
  const query=()=>{throw new Error("Legacy assembly must not access immutable versions");};
  for(const tenantId of ["",0,"0","2"]){
    await assert.rejects(assembleListingDraftStoredRow(query,{tenantId:"admin",row:{tenant_id:tenantId,template_payload_json:"{}"}}),error=>error.statusCode===404);
  }
  for(const tenantId of [null,"admin"]){
    const row={tenant_id:tenantId,template_payload_json:"{}"};
    assert.equal(await assembleListingDraftStoredRow(query,{tenantId:"admin",row}),row);
  }
});

test("frozen category/private master references are immutable, scoped and lossless in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async (t) => {
  const fixture=await createTenantMysqlFixture("listing_frozen");
  let closeMysqlPool;
  const oldOptIn=process.env.LISTING_FROZEN_DRAFT_TENANTS,oldFetch=globalThis.fetch;
  try {
    fixture.useEnvironment();
    ({closeMysqlPool}=await import("../src/mysql-pool.js"));
    const listing=await import("../src/services/listing-automation.js");
    await listing.ensureListingAutomationSchema();
    const q=async(sql,params=[])=>(await fixture.connection.query(sql,params))[0];
    await q("DROP TABLE listing_frozen_content");
    assert.equal((await assertListingFrozenContentReady(q,{required:false})).exists,false);
    process.env.LISTING_FROZEN_DRAFT_TENANTS="2";
    await assert.rejects(assertListingFrozenContentReady(q),error=>error.statusCode===503);
    process.env.LISTING_FROZEN_DRAFT_TENANTS="*";
    await assert.rejects(assertListingFrozenContentReady(q),error=>error.statusCode===503);
    process.env.LISTING_FROZEN_DRAFT_TENANTS="";
    const plan=await migrateListingFrozenContent(q,{database:fixture.database});
    assert.equal(plan.changes_database,false);
    await migrateListingFrozenContent(q,{database:fixture.database,apply:true});
    assert.equal((await assertListingFrozenContentReady(q,{required:true})).reader_version,1);
    assert.equal((await migrateListingFrozenContent(q,{database:fixture.database,apply:true})).changes_database,false);
    await t.test("readiness rejects extra global or incomplete unique keys and allows ordinary indexes",async()=>{
      for(const columns of ["content_hash","tenant_id,content_kind"]){
        await q(`ALTER TABLE listing_frozen_content ADD UNIQUE KEY fixture_bad_unique (${columns})`);
        try{
          await assert.rejects(assertListingFrozenContentReady(q,{required:true}),error=>error.statusCode===503);
          await assert.rejects(migrateListingFrozenContent(q,{database:fixture.database,apply:true}),error=>error.statusCode===503);
        }finally{await q("ALTER TABLE listing_frozen_content DROP INDEX fixture_bad_unique");}
      }
      await q("ALTER TABLE listing_frozen_content ADD INDEX fixture_normal_index (content_kind,created_at)");
      assert.equal((await assertListingFrozenContentReady(q,{required:true})).ready,true);
      await q("ALTER TABLE listing_frozen_content DROP INDEX fixture_normal_index");
    });
    await q("INSERT INTO ozon_category_attributes (description_category_id,type_id,attribute_id,name,name_zh,attribute_type,dictionary_id,raw_json) VALUES (100,200,7,'Material','材质','String',10,'{\"title\":\"must never be public\",\"images\":[\"private.png\"]}')");
    const category=await freezeListingCategoryDefinition(q,{descriptionCategoryId:100,typeId:200,payload:{title:"ignored private title"}});
    const definitions=Array.from({length:64},(_,id)=>({attribute_id:id+1,name:`Field ${id}`,values:Array.from({length:30},(_,value)=>({value:`Option ${value} ${"x".repeat(50)}`}))}));
    const base={ozon_category_id:"100:200",title:"Private mother",attributes:definitions,images:["https://example.invalid/mother.jpg"],editable_payload:{description_category_id:100,type_id:200,title:"Private mother",attributes:definitions,variants:[{id:"one",images:["https://example.invalid/mother.jpg"],images_manually_edited:true,price:15,attributes:definitions}]},remove_me:"obsolete"};
    const master=await freezeEnterpriseListingMaster(q,{tenantId:"2",categoryHash:category.hash,payload:base});
    await t.test("public versions contain only official schema fields and private masters deduplicate only within their enterprise",async()=>{
      const rows=await q("SELECT tenant_id,content_kind,payload_json FROM listing_frozen_content ORDER BY tenant_id");
      assert.doesNotMatch(rows.find(r=>r.tenant_id==="public").payload_json,/must never|private.png|ignored private|Private mother|Option 1/);
      assert.equal((await freezeEnterpriseListingMaster(q,{tenantId:"2",categoryHash:category.hash,payload:base})).hash,master.hash);
      assert.equal(Number((await q("SELECT COUNT(*) n FROM listing_frozen_content WHERE tenant_id='2'"))[0].n),1);
      await assert.rejects(encodeFrozenListingDraftPayload(q,{tenantId:"3",masterHash:master.hash,payload:base}),error=>error.statusCode===404);
      const other=await freezeEnterpriseListingMaster(q,{tenantId:"3",categoryHash:category.hash,payload:base});
      assert.equal(other.hash,master.hash);
      assert.equal(Number((await q("SELECT COUNT(*) n FROM listing_frozen_content WHERE content_kind='product_master'"))[0].n),2);
    });
    await t.test("one-level patches preserve independent generated images, explicit manual empty and removal",async()=>{
      const target=structuredClone(base);
      target.title="Private child";target.editable_payload.title="Private child";
      target.images=["https://example.invalid/child.jpg"];
      target.editable_payload.variants[0].images=[];
      delete target.remove_me;
      const stored=await encodeFrozenListingDraftPayload(q,{tenantId:"2",masterHash:master.hash,payload:target});
      assert.deepEqual(stored.editable_payload.variants[0].images,[]);
      assert.equal(stored.editable_payload.variants[0].images_manually_edited,true);
      assert.deepEqual(await assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:stored}),target);
      let versionReads=0;
      const scope=createListingFrozenReadScope(async(sql,params)=>{versionReads++;return q(sql,params);});
      await Promise.all([1,2,3].map(()=>assembleFrozenListingDraftPayload(scope,{tenantId:"2",storedPayload:stored})));
      assert.equal(versionReads,2,"one review request loads the shared private master and public definition once");
      assert.ok(Buffer.byteLength(JSON.stringify(stored)) < Buffer.byteLength(JSON.stringify(target))/5,"same schema/options must not be copied into every child payload");
      await assert.rejects(assembleFrozenListingDraftPayload(q,{tenantId:"admin",storedPayload:stored}),error=>error.statusCode===404);
      const tampered=structuredClone(stored);tampered.editable_payload.variants[0].images=["https://example.invalid/wrong.jpg"];
      await assert.rejects(assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:tampered}),/projection mismatch/);
    });
    await t.test("updating official cache or changing the live master never mutates old referenced versions",async()=>{
      const stored=await encodeFrozenListingDraftPayload(q,{tenantId:"2",masterHash:master.hash,payload:base});
      await q("UPDATE ozon_category_attributes SET name_zh='新定义' WHERE attribute_id=7");
      const nextCategory=await freezeListingCategoryDefinition(q,{descriptionCategoryId:100,typeId:200});
      assert.notEqual(nextCategory.hash,category.hash);
      const nextBase={...base,title:"Changed later"};
      assert.notEqual((await freezeEnterpriseListingMaster(q,{tenantId:"2",categoryHash:nextCategory.hash,payload:nextBase})).hash,master.hash);
      assert.deepEqual(await assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:stored}),base);
      await assert.rejects(encodeFrozenListingDraftPayload(q,{tenantId:"2",masterHash:master.hash,payload:{...base,ozon_category_id:"100:999",editable_payload:{...base.editable_payload,type_id:999}}}),/differs from/);
    });
    await t.test("opt-in service writes, detail, full review lists, edits and deletion keep a frozen draft independent of its live template",async()=>{
      process.env.LISTING_FROZEN_DRAFT_TENANTS="2";
      globalThis.fetch=async()=>{throw new Error("External network forbidden in frozen draft test");};
      await q("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
      await q("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
      await q("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
      const session={personId:7,tenant:{id:2,slug:"a"}};
      const mother=structuredClone(base);mother.images=[];mother.editable_payload.variants[0].images=[];
      const created=await q("INSERT INTO listing_category_templates (tenant_id,ozon_category_id,category_name,template_name,title,editable_payload_json,attributes_json,images_json,required_attributes_json,ai_rules_json,title_prompt,description_prompt,image_rules_json) VALUES ('2','100:200','Category','Mother','Private mother',?,?,'[]','[]','{}','','','{}')",[JSON.stringify(mother.editable_payload),JSON.stringify(definitions)]);
      const templateId=created.insertId;
      const child={...mother,title:"Child one",editable_payload:{...mother.editable_payload,title:"Child one"}};
      const draft=await listing.createListingDraft({template_id:templateId,product_name:"Child one",internal_code:"FROZEN-1",template_payload:child,manual_facts:{source_product_id:"source-one"}},session);
      const [stored]=await q("SELECT template_payload_json FROM listing_drafts WHERE id=?",[draft.id]);
      assert.ok(JSON.parse(stored.template_payload_json)._listing_frozen_content_v1);
      assert.ok(stored.template_payload_json.startsWith('{"_listing_frozen_content_v1":'));
      assert.ok(draft.frozen_content_version);
      assert.equal(draft.template_payload.title,"Child one");
      assert.equal(draft.category_name,"Category");
      assert.equal(draft.template_name,"Mother");
      const [privateVersion]=await q("SELECT payload_json FROM listing_frozen_content WHERE tenant_id='2' AND content_hash=?",[draft.frozen_content_version.master_hash]);
      assert.equal(Object.hasOwn(JSON.parse(privateVersion.payload_json).payload,"attributes_json"),false,"private content must not duplicate the source database row's encoded fields");
      assert.equal(Object.hasOwn(JSON.parse(privateVersion.payload_json).payload,"source_raw_json"),false);
      assert.deepEqual(draft.effective_images,[]);
      assert.equal(draft.template_payload.editable_payload.attributes.length,64);
      t.diagnostic(`Synthetic template payload only: frozen=${Buffer.byteLength(stored.template_payload_json)} bytes; assembled=${Buffer.byteLength(JSON.stringify(await assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:JSON.parse(stored.template_payload_json)})))} bytes. Manual/AI facts are unchanged and excluded from this comparison.`);
      const detailed=await listing.listingDrafts({paged:"1",lightweight:"0",ids:String(draft.id)},session);
      assert.equal(detailed.rows[0].template_payload.title,"Child one");
      const templatesBefore=Number((await q("SELECT COUNT(*) n FROM listing_category_templates WHERE tenant_id='2'"))[0].n);
      const aiChild=await listing.createAiVariantListingDraftLightweight({source_draft_id:draft.id,template_id:templateId,clone_source_draft:true,offer_id:"FROZEN-AI-1",product_name:"Generated child",patch:{title:"Generated child",images:[]},ai_optimization:{source:"ai_product_material_optimizer",result_id:"frozen-fixture-one"}},session);
      assert.equal(aiChild.template_id,templateId,"AI children reuse the enterprise master instead of cloning full local templates");
      assert.ok(aiChild.frozen_content_version);
      assert.equal(aiChild.frozen_content_version.master_hash,draft.frozen_content_version.master_hash);
      assert.equal(Number((await q("SELECT COUNT(*) n FROM listing_category_templates WHERE tenant_id='2'"))[0].n),templatesBefore);
      assert.deepEqual(aiChild.effective_images,[]);
      assert.ok(aiChild.template_payload.editable_payload.attributes.length>0);
      // Run the production publish assembly and durable receipt SQL. Only media
      // I/O is substituted; no real Ozon or paid AI request is issued.
      const sourceUrl=new URL("../src/services/listing-automation.js",import.meta.url);
      let source=readFileSync(sourceUrl,"utf8");
      const imports=parse(source,{ecmaVersion:"latest",sourceType:"module"}).body.filter(node=>node.type==="ImportDeclaration");
      const globals={console,process,Buffer,URL,URLSearchParams,Date,Set,Map,WeakMap,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout};
      for(const declaration of imports){
        const specifier=declaration.source.value,module=await import(specifier.startsWith(".")?new URL(specifier,sourceUrl).href:specifier);
        for(const binding of declaration.specifiers)globals[binding.local.name]=binding.type==="ImportDefaultSpecifier"?module.default:binding.type==="ImportNamespaceSpecifier"?module:module[binding.imported.name];
      }
      for(const declaration of imports.reverse())source=source.slice(0,declaration.start)+source.slice(declaration.end);
      const context=vm.createContext(globals);
      vm.runInContext(source.replaceAll("export ","")+"\nmysqlSchemaReady=true;",context);
      context.materializeAiOptimizationDraftMedia=async value=>value;
      context.materializeListingDraftMediaForDraftSafety=async value=>value;
      context.rewriteDraftPayloadToRegisteredPublicMedia=async value=>value;
      const snapshot=await context.buildPublishTemplateFromListingDraft(aiChild,session);
      assert.ok(snapshot.attributes.length>0);
      assert.deepEqual(Array.from(snapshot.images),[]);
      assert.doesNotMatch(JSON.stringify(snapshot),/_listing_frozen_content_v1/);
      await q("INSERT INTO shops (id,tenant_id,name) VALUES (2,2,'A shop')");
      const recordId=await context.preparePublishRecordForSubmit({shop:{id:2},shopPayload:{items:[{offer_id:"FROZEN-AI-1",name:aiChild.product_name,images:[],price:"15"}]},session,templateSnapshot:snapshot,draftId:aiChild.id});
      const [record]=await q("SELECT tenant_id,request_json,template_snapshot_json FROM listing_publish_records WHERE id=?",[recordId]);
      assert.equal(record.tenant_id,"2");
      assert.equal(JSON.parse(record.request_json).items[0].offer_id,"FROZEN-AI-1");
      assert.doesNotMatch(record.template_snapshot_json || "",/_listing_frozen_content_v1/);
      const [afterPublish]=await q("SELECT template_payload_json FROM listing_drafts WHERE id=?",[aiChild.id]);
      assert.ok(JSON.parse(afterPublish.template_payload_json)._listing_frozen_content_v1,"variant linkage CAS must not silently unfold a frozen draft");
      await q("UPDATE listing_category_templates SET title='Wrong later title',category_name='Wrong category',template_name='Wrong name',attributes_json='[]',editable_payload_json='{}' WHERE id=?",[templateId]);
      const edit=structuredClone(child);edit.title="Child edited";edit.editable_payload.title="Child edited";
      const updated=await listing.updateListingDraft(draft.id,{template_id:templateId,product_name:"Child edited",internal_code:"FROZEN-1",template_payload:edit},session);
      assert.equal(updated.template_payload.editable_payload.attributes.length,64);
      assert.equal(updated.manual_facts.attributes.length,64,"editing a frozen draft cannot inherit newly changed live template facts");
      assert.equal(updated.category_name,"Category");
      assert.equal(updated.template_name,"Mother");
      assert.equal(updated.frozen_content_version.master_hash,draft.frozen_content_version.master_hash);
      await q("DELETE FROM listing_category_templates WHERE id=?",[templateId]);
      assert.equal((await listing.listingDraftDetail(draft.id,session)).template_payload.title,"Child edited");
      for(const lightweight of ["0","1"]){
        const list=await listing.listingDrafts({paged:"1",lightweight,ids:String(draft.id),category:"category"},session);
        assert.equal(list.total,1,"category search uses the frozen label after its local template is deleted");
        assert.equal(list.rows[0].category_name,"Category");
        assert.equal(list.rows[0].template_name,"Mother");
      }
      const afterDeletion=await listing.updateListingDraft(draft.id,{product_name:"Edited after master deletion",internal_code:"FROZEN-1",template_payload:edit},session);
      assert.equal(afterDeletion.template_payload.editable_payload.attributes.length,64);
      const aiSource=readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js",import.meta.url),"utf8");
      const loader=parse(aiSource,{ecmaVersion:"latest",sourceType:"module"}).body.find(node=>node.type==="FunctionDeclaration" && node.id.name==="loadListingDraftForCopyTest");
      let loaderPermissionChecks=0;
      const loaderContext=vm.createContext({
        assertCurrentAiTenantPermission:async()=>{loaderPermissionChecks++;},aiTenantId:()=>"2",mysqlQuery:q,assembleListingDraftStoredRow
      });
      vm.runInContext(aiSource.slice(loader.start,loader.end),loaderContext);
      const copySource=await loaderContext.loadListingDraftForCopyTest(draft.id);
      assert.equal(JSON.parse(copySource.template_payload_json).editable_payload.attributes.length,64);
      assert.equal(loaderPermissionChecks,1);
      loaderContext.aiTenantId=()=>"3";
      assert.equal(await loaderContext.loadListingDraftForCopyTest(draft.id),null,"copy source loading cannot assemble another enterprise's draft");
      await assert.rejects(listing.listingDraftDetail(draft.id,{personId:7,tenant:{id:3,slug:"b"}}));
      await listing.deleteListingDraft(draft.id,session);
      assert.equal(Number((await q("SELECT COUNT(*) n FROM listing_frozen_content WHERE tenant_id='2' AND content_hash=?",[draft.frozen_content_version.master_hash]))[0].n),1,"deleting a draft cannot garbage-collect a version referenced by other drafts");
      process.env.LISTING_FROZEN_DRAFT_TENANTS="";
    });
    await t.test("legacy reads require no new-table query and malformed or tampered references fail closed",async()=>{
      const query=()=>{throw new Error("Legacy payload must not query versions");};
      assert.deepEqual(await assembleFrozenListingDraftPayload(query,{tenantId:"admin",storedPayload:{legacy:true}}),{legacy:true});
      assert.equal(await assembleFrozenListingDraftPayload(query,{tenantId:"admin",storedPayload:null}),null);
      await assert.rejects(freezeEnterpriseListingMaster(q,{tenantId:"2",categoryHash:category.hash,payload:JSON.parse('{"constructor":{"polluted":true}}')}),/Unsafe|differs from/);
      const stored=await encodeFrozenListingDraftPayload(q,{tenantId:"2",masterHash:master.hash,payload:base});
      stored._listing_frozen_content_v1.operations=[{set:["__proto__","polluted"],value:true}];
      await assert.rejects(assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:stored}),/Invalid frozen listing patch path/);
      await q("UPDATE listing_frozen_content SET payload_json='{}' WHERE tenant_id='2' AND content_hash=?",[master.hash]);
      await assert.rejects(assembleFrozenListingDraftPayload(q,{tenantId:"2",storedPayload:await encodeFrozenListingDraftPayload(q,{tenantId:"3",masterHash:master.hash,payload:base})}),/checksum mismatch/);
      assert.equal({}.polluted,undefined);
    });
  } finally {
    if(oldOptIn===undefined)delete process.env.LISTING_FROZEN_DRAFT_TENANTS;else process.env.LISTING_FROZEN_DRAFT_TENANTS=oldOptIn;
    globalThis.fetch=oldFetch;
    if(closeMysqlPool)await closeMysqlPool();
    await fixture.cleanup();
  }
});

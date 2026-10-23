import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "acorn";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session = id=>({personId:7,tenant:{id,slug:id===1?"default":`enterprise-${id}`}});
const sourceUrl = new URL("../src/services/listing-automation.js",import.meta.url);

test("AI lightweight draft save validates references and atomically writes template/draft under original enterprise",{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&"Requires isolated MySQL socket"},async t=>{
  const fixture = await createTenantMysqlFixture("ai_light_save");
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    for(const id of [1,2,3]) await query("INSERT INTO tenants (id,slug,name) VALUES (?,?,?)",[id,id===1?"default":`enterprise-${id}`,`Enterprise ${id}`]);
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    for(const id of [1,2,3]) await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (?,7,JSON_ARRAY('operations'))",[id]);
    const mysqlModule = await import("../src/mysql-pool.js"); closeMysqlPool = mysqlModule.closeMysqlPool;
    const actual = await import(sourceUrl.href); await actual.ensureListingAutomationSchema();
    let text = readFileSync(sourceUrl,"utf8");
    const imports = parse(text,{ecmaVersion:"latest",sourceType:"module"}).body.filter(node=>node.type==="ImportDeclaration");
    const globals = {console,process,Buffer,URL,URLSearchParams,Date,Set,Map,WeakMap,TextDecoder,TextEncoder,AbortController,AbortSignal,setTimeout,clearTimeout};
    for(const declaration of imports) {
      const specifier = declaration.source.value;
      const module = await import(specifier.startsWith(".")?new URL(specifier,sourceUrl).href:specifier);
      for(const binding of declaration.specifiers) globals[binding.local.name] = binding.type==="ImportDefaultSpecifier"?module.default:binding.type==="ImportNamespaceSpecifier"?module:module[binding.imported.name];
    }
    let mediaCalls = 0, mediaHook = null, copyMediaHook = null, failDraftWrite = false, lockHook = null, sourceLockHook = null;
    const transaction = globals.withMysqlTransaction;
    globals.withMysqlTransaction = action=>transaction(async connection=>{
      const wrapped = {execute:async(sql,params=[])=>{
        if(lockHook && sql.startsWith("SELECT id FROM tenants WHERE")) await lockHook();
        if(sourceLockHook && /SELECT id,template_id,source_product_id,template_payload_json FROM listing_drafts/.test(sql) && sql.includes("FOR UPDATE")) await sourceLockHook();
        if(failDraftWrite && /INSERT INTO listing_drafts/.test(sql)) throw Object.assign(new Error("Injected draft insert failure"),{code:"FIXTURE_WRITE_FAILED"});
        return connection.execute(sql,params);
      }};
      return action(wrapped);
    });
    for(const declaration of imports.reverse()) text=text.slice(0,declaration.start)+text.slice(declaration.end);
    const context=vm.createContext(globals);
    vm.runInContext(text.replaceAll("export ","")+"\nmysqlSchemaReady=true;",context);
    // Replace only media/network boundaries; the save, references, transaction,
    // template normalization and all SQL use the production implementations.
    context.materializeAiOptimizationDraftMedia=async payload=>{mediaCalls++;if(mediaHook)await mediaHook();return payload;};
    context.rewriteDraftPayloadToRegisteredPublicMedia=async payload=>payload;
    context.generateWatermarkedListingImages=async images=>{if(copyMediaHook)await copyMediaHook();return images.map(url=>({url,status:"watermark_skipped"}));};
    context.resolveShopTailImageUrl=async()=>"";
    await query("INSERT INTO shops (id,tenant_id,name) VALUES (20,2,'Own Shop'),(30,3,'Foreign Shop')");
    const templates=new Map(),drafts=new Map(),products=new Map();
    for(const id of [1,2,3]) {
      const key=id===1?"admin":String(id);
      const template=await query("INSERT INTO listing_category_templates (tenant_id,ozon_category_id,category_name,template_name,title,editable_payload_json,images_json,attributes_json,source_raw_json,required_attributes_json,ai_rules_json,title_prompt,description_prompt,image_rules_json) VALUES (?,'111','Fixture',?,?,'{}','[]','[]','{}','[]','{}','','','{}')",[key,`Template ${id}`,`Product ${id}`]);
      templates.set(id,template.insertId);
      const product=await query("INSERT INTO products (tenant_id,name) VALUES (?,?)",[id,`Inventory ${id}`]);products.set(id,product.insertId);
      const payload={title:`Product ${id}`,editable_payload:{title:`Product ${id}`,variants:[{images:["https://fixture.invalid/current.png","https://fixture.invalid/detail.png"]}]}};
      const draft=await query("INSERT INTO listing_drafts (tenant_id,template_id,product_name,internal_code,source_product_id,template_payload_json,source_images_json,manual_facts_json,ai_payload_json,source_urls_json) VALUES (?,?,?,?,?,?,?,'{}','{}','[]')",[key,template.insertId,`Product ${id}`,`BASE-${id}`,product.insertId,JSON.stringify(payload),JSON.stringify(["https://fixture.invalid/current.png","https://fixture.invalid/detail.png"])]);
      drafts.set(id,draft.insertId);
    }
    let sequence=0;
    const body=(id,extra={})=>({source_draft_id:drafts.get(id),template_id:templates.get(id),source_product_id:products.get(id),clone_source_draft:true,offer_id:`OPT-${++sequence}`,product_name:`Product ${id}`,source_images:["https://fixture.invalid/new.png"],patch:{images:["https://fixture.invalid/new.png"]},ai_optimization:{source:"ai_product_material_optimizer"},...extra});
    const counts=async()=>[Number((await query("SELECT COUNT(*) n FROM listing_drafts"))[0].n),Number((await query("SELECT COUNT(*) n FROM listing_category_templates"))[0].n)];

    await t.test("ordinary default/A/B save owns both rows and ignores forged tenant/actor fields",async()=>{
      for(const id of [1,2,3]) {
        const saved=await context.createAiVariantListingDraftLightweight(body(id,{tenant_id:"other",created_by_person_id:999}),session(id),{summaryOnly:true});
        const [draft]=await query("SELECT tenant_id,created_by_person_id,parent_draft_id,source_product_id,source_images_json FROM listing_drafts WHERE id=?",[saved.id]);
        const [template]=await query("SELECT tenant_id,created_by_person_id FROM listing_category_templates WHERE id=?",[saved.template_id]);
        assert.equal(draft.tenant_id,id===1?"admin":String(id));assert.equal(template.tenant_id,draft.tenant_id);assert.equal(draft.created_by_person_id,7);assert.equal(template.created_by_person_id,7);
        assert.equal(Number(draft.parent_draft_id),drafts.get(id));assert.equal(Number(draft.source_product_id),products.get(id));
        assert.deepEqual(JSON.parse(draft.source_images_json),["https://fixture.invalid/new.png","https://fixture.invalid/detail.png"]);
      }
    });
    await t.test("the actual HTTP-shaped detail response returns the saved owned draft without extra template writes",async()=>{
      const before=await counts();
      const detail=await context.createAiVariantListingDraftLightweight(body(2),session(2));
      assert.ok(detail.id>0);assert.equal(detail.tenant_id,"2");assert.equal(detail.parent_draft_id,drafts.get(2));
      const after=await counts();assert.deepEqual(after,[before[0]+1,before[1]+1]);
    });
    await t.test("cross-enterprise source/template/product/parent references fail before media or either row write",async()=>{
      const before=await counts(),mediaBefore=mediaCalls;
      for(const forged of [
        {source_draft_id:drafts.get(3)}, {base_draft_id:drafts.get(3)}, {parent_draft_id:drafts.get(3)},
        {template_id:templates.get(3),template_payload:{title:"Inline must not mask foreign local ID"}},
        {source_product_id:products.get(3)}, {shop_ids:[30]}, {template_payload:{source_raw:{source_product_id:products.get(3)},title:"Forged source"}}
      ]) await assert.rejects(context.createAiVariantListingDraftLightweight(body(2,forged),session(2),{summaryOnly:true}),{status:404});
      assert.deepEqual(await counts(),before);assert.equal(mediaCalls,mediaBefore);
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2,{source_draft_id:"wrong"}),session(2)),{status:400});
    });
    await t.test("inline uploaded snapshots without a local source reference remain usable",async()=>{
      const saved=await context.createAiVariantListingDraftLightweight({offer_id:`UPLOAD-${++sequence}`,product_name:"Uploaded product",template_payload:{title:"Uploaded product",editable_payload:{title:"Uploaded product",variants:[{images:["https://fixture.invalid/upload.png"]}]}},source_images:["https://fixture.invalid/upload.png"],ai_optimization:{source:"ai_product_material_optimizer"}},session(2),{summaryOnly:true});
      const [draft]=await query("SELECT parent_draft_id,source_product_id,tenant_id FROM listing_drafts WHERE id=?",[saved.id]);
      assert.equal(draft.tenant_id,"2");assert.equal(draft.parent_draft_id,null);assert.equal(draft.source_product_id,null);
    });
    await t.test("owned saved source snapshots survive a missing local template without authorizing a foreign template",async()=>{
      await query("UPDATE listing_drafts SET template_id=999999 WHERE id=?",[drafts.get(2)]);
      const saved=await context.createAiVariantListingDraftLightweight(body(2,{template_id:999999}),session(2),{summaryOnly:true});
      assert.ok(saved.template_id>0);assert.notEqual(saved.template_id,999999);
      await query("UPDATE listing_drafts SET template_id=? WHERE id=?",[templates.get(3),drafts.get(2)]);
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2,{template_id:templates.get(3)}),session(2),{summaryOnly:true}),{status:404});
      await query("UPDATE listing_drafts SET template_id=? WHERE id=?",[templates.get(2),drafts.get(2)]);
    });
    await t.test("revocation or source reassignment after media work prevents both template and draft writes",async()=>{
      const before=await counts();
      mediaHook=()=>query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2),session(2),{summaryOnly:true}),{statusCode:403});
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
      mediaHook=()=>query("UPDATE listing_drafts SET tenant_id='3' WHERE id=?",[drafts.get(2)]);
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2),session(2),{summaryOnly:true}),{status:404});
      await query("UPDATE listing_drafts SET tenant_id='2' WHERE id=?",[drafts.get(2)]);mediaHook=null;
      assert.deepEqual(await counts(),before);
    });
    await t.test("lock-wait revocation is checked in the transaction before creating a template",async()=>{
      const before=await counts();
      const blocker=await mysqlModule.getMysqlPool().getConnection();
      await blocker.beginTransaction();await blocker.execute("SELECT id FROM tenants WHERE id=2 FOR UPDATE");
      let entered;const started=new Promise(resolve=>{entered=resolve;});
      lockHook=async()=>{lockHook=null;entered();};
      const pending=context.createAiVariantListingDraftLightweight(body(2),session(2),{summaryOnly:true});
      await started;
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await blocker.commit();blocker.release();
      await assert.rejects(pending,{statusCode:403});
      assert.deepEqual(await counts(),before);await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("source row lock wait cannot use an earlier membership snapshot after revocation",async()=>{
      const before=await counts();
      const blocker=await mysqlModule.getMysqlPool().getConnection();
      await blocker.beginTransaction();await blocker.execute("SELECT id FROM listing_drafts WHERE id=? FOR UPDATE",[drafts.get(2)]);
      let entered;const started=new Promise(resolve=>{entered=resolve;});
      sourceLockHook=async()=>{sourceLockHook=null;entered();};
      const pending=context.createAiVariantListingDraftLightweight(body(2),session(2),{summaryOnly:true});
      await started;
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await blocker.commit();blocker.release();
      await assert.rejects(pending,{statusCode:403});assert.deepEqual(await counts(),before);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("human validation errors return actionable 400 without creating template rows",async()=>{
      const before=await counts();
      for(const invalid of [{},null,[],{product_name:"Missing template",offer_id:"NO-TEMPLATE"}]) await assert.rejects(context.createAiVariantListingDraftLightweight(invalid,session(2)),{status:400});
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2,{offer_id:""}),session(2)),{status:400});
      assert.deepEqual(await counts(),before);
    });
    await t.test("a draft SQL failure rolls its newly inserted template back atomically",async()=>{
      const before=await counts();failDraftWrite=true;
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2),session(2),{summaryOnly:true}),{code:"FIXTURE_WRITE_FAILED"});
      failDraftWrite=false;assert.deepEqual(await counts(),before);
    });
    await t.test("optional shop copies retain ordinary behavior and recheck revocation after media before copy writes",async()=>{
      const own=await context.createAiVariantListingDraftLightweight(body(2,{shop_ids:[20]}),session(2),{summaryOnly:true});
      assert.equal(own.shop_copy_count,1);
      const [savedCopy]=await query("SELECT tenant_id,shop_id FROM listing_shop_copies WHERE draft_id=?",[own.id]);
      assert.equal(savedCopy.tenant_id,"2");assert.equal(savedCopy.shop_id,20);
      const before=Number((await query("SELECT COUNT(*) n FROM listing_shop_copies"))[0].n);
      copyMediaHook=()=>query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2,{shop_ids:[20]}),session(2),{summaryOnly:true}),{statusCode:403});
      assert.equal(Number((await query("SELECT COUNT(*) n FROM listing_shop_copies"))[0].n),before);
      copyMediaHook=null;await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });
    await t.test("revoked or missing enterprise context cannot use the final save boundary",async()=>{
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2),null),{statusCode:403});
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7");
      await assert.rejects(context.createAiVariantListingDraftLightweight(body(2),session(2)),{statusCode:403});
    });
  } finally {if(closeMysqlPool)await closeMysqlPool();await fixture.cleanup();}
});

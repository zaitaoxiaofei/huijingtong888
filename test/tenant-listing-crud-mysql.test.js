import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "acorn";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session=id=>({personId:7,tenant:{id,slug:id===1?"default":`enterprise-${id}`}});
test("real collector-to-template-to-draft CRUD and publish records isolate A/B/default",{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&"Requires the isolated TENANT_TEST_MYSQL_SOCKET"
},async t=>{
  const fixture=await createTenantMysqlFixture("listing_crud");
  const originalFetch=globalThis.fetch;
  let closeMysqlPool;
  try{
    fixture.useEnvironment();
    globalThis.fetch=async()=>{throw new Error("External network disabled in CRUD isolation test");};
    const query=fixture.query;
    await query("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name) VALUES (10,NULL,'Legacy'),(11,1,'Default'),(20,2,'A'),(30,3,'B')");
    ({closeMysqlPool}=await import("../src/mysql-pool.js"));
    const listing=await import("../src/services/listing-automation.js");
    await listing.ensureListingAutomationSchema();
    // Keep the actual collector normalizer and SQL. Only the no-image OSS
    // availability boundary is supplied; no upload or external fetch occurs.
    const listingUrl=new URL("../src/services/listing-automation.js",import.meta.url);
    let collectorSource=readFileSync(listingUrl,"utf8");
    const imports=parse(collectorSource,{ecmaVersion:"latest",sourceType:"module"}).body.filter(node=>node.type==="ImportDeclaration");
    const globals={console,process,Buffer,URL,URLSearchParams,Date,Set,Map,TextDecoder,TextEncoder,AbortController,setTimeout,clearTimeout,fetch:globalThis.fetch};
    for(const declaration of imports){
      const specifier=declaration.source.value;
      const module=await import(specifier.startsWith(".")?new URL(specifier,listingUrl).href:specifier);
      for(const binding of declaration.specifiers)globals[binding.local.name]=binding.type==="ImportDefaultSpecifier"?module.default:binding.type==="ImportNamespaceSpecifier"?module:module[binding.imported.name];
    }
    globals.ossStorageConfig=()=>({enabled:true});
    const publishStats=[];
    const actualQuery=globals.mysqlQuery;
    globals.mysqlQuery=async(sql,params)=>{
      const rows=await actualQuery(sql,params);
      if(sql.includes("AS publish_record_count")&&sql.includes("GROUP BY source_collector_sku"))publishStats.push({key:params.at(-1),rows});
      return rows;
    };
    for(const declaration of imports.reverse())collectorSource=collectorSource.slice(0,declaration.start)+collectorSource.slice(declaration.end);
    const collectorContext=vm.createContext(globals);
    vm.runInContext(collectorSource.replaceAll("export ","")+"\nmysqlSchemaReady = true; collectorBoxReadSchemaReady = true;",collectorContext);
    const templates=new Map(),drafts=new Map(),records=new Map();
    for(const id of[1,2,3])await query("INSERT INTO ozon_plugin_collected_products (tenant_id,sku,title,collect_date,payload_json) VALUES (?, 'same', ?, CURRENT_DATE, '{}')",[id===1?"admin":String(id),`Collected ${id}`]);
    await query("INSERT INTO ozon_plugin_collected_products (tenant_id,sku,title,collect_date,payload_json) VALUES ('3','private-b','Private B',CURRENT_DATE,'{}')");
    await t.test("collector lists, detail, edits and template creation use session ownership",async()=>{
      for(const id of[1,2,3]){
        const result=await listing.collectorBoxProducts({tenant_id:"3"},session(id));
        assert.ok(result.rows.every(row=>row.title===`Collected ${id}`||id===3));
        assert.equal((await listing.collectorBoxProductDetail("same",session(id))).title,`Collected ${id}`);
        await listing.saveCollectorBoxEdit("same",{title:`Edited ${id}`,tenant_id:"3"},session(id));
        const created=await collectorContext.createListingTemplateFromCollectorBox("same",{allow_incomplete:true,compact:true},session(id));
        assert.ok(created.template?.id,JSON.stringify(created));
        templates.set(id,created.template.id);
      }
      assert.equal(await listing.collectorBoxProductDetail("private-b",session(1)),null);
      assert.equal(await listing.collectorBoxProductDetail("private-b",session(2)),null);
      await assert.rejects(listing.saveCollectorBoxEdit("private-b",{title:"foreign"},session(2)));
      const edited=await query("SELECT tenant_id,edit_payload_json FROM ozon_plugin_collected_products WHERE sku='same' ORDER BY tenant_id");
      assert.equal(edited.length,3);
      assert.ok(edited.every(row=>String(JSON.parse(row.edit_payload_json).title).endsWith(` ${row.tenant_id==="admin"?1:row.tenant_id}`)),JSON.stringify(edited));
    });
    await t.test("own templates and drafts work while foreign template/draft IDs fail",async()=>{
      for(const id of[1,2,3]){
        const draft=await listing.createListingDraft({tenant_id:"3",template_id:templates.get(id),product_name:`Draft ${id}`,template_payload:{editable_payload:{title:`Draft ${id}`}}},session(id));
        drafts.set(id,draft.id);
        assert.equal(draft.product_name,`Draft ${id}`);
        await listing.updateListingDraft(draft.id,{template_id:templates.get(id),product_name:`Updated ${id}`,template_payload:{editable_payload:{title:`Updated ${id}`}}},session(id));
        const rows=await listing.listingDrafts({},session(id));
        assert.ok((rows.rows||rows).every(row=>row.id===draft.id));
      }
      for(const id of[1,2]){
        await assert.rejects(listing.listingCategoryTemplateDetail(templates.get(3),session(id)),/not found/);
        await assert.rejects(listing.createListingDraft({template_id:templates.get(3),product_name:"foreign"},session(id)),/not found/);
        await assert.rejects(listing.updateListingDraft(drafts.get(3),{product_name:"foreign"},session(id)));
        await assert.rejects(listing.deleteListingDraft(drafts.get(3),session(id)));
      }
      assert.equal((await query("SELECT product_name FROM listing_drafts WHERE id=?",[drafts.get(3)]))[0].product_name,"Updated 3");
    });
    await t.test("collector selection creation and repeated reuse keep the authenticated enterprise",async()=>{
      for(const id of[1,2,3]){
        const created=await listing.createSelectionFromCollectorBox("same",{internal_product_name:`Selection ${id}`,tenant_id:"other"},session(id));
        assert.ok(created.id);
        const product=(await query("SELECT tenant_id,created_by_person_id FROM products WHERE id=?",[created.id]))[0];
        assert.equal(product.tenant_id,id);
        assert.equal(product.created_by_person_id,7);
        const repeated=await listing.createSelectionFromCollectorBox("same",{},session(id));
        assert.equal(repeated.id,created.id);
        assert.equal(repeated.reused,true);
      }
    });
    await t.test("publish record list/detail/draft/delete cannot expose or mutate foreign shops",async()=>{
      for(const[id,shop]of[[1,10],[2,20],[3,30]]){
        const result=await query("INSERT INTO listing_publish_records (tenant_id,draft_id,shop_id,status,request_json,list_summary_json,created_by_person_id,source_collector_sku) VALUES (?,?,?,'failed','{\"items\":[{\"offer_id\":\"own\"}]}','{}',7,'same')",[id===1?"admin":String(id),drafts.get(id),shop]);
        records.set(id,result.insertId);
        const listed=await listing.listingPublishRecords({},session(id));
        assert.deepEqual((listed.rows||listed).map(row=>row.id),[result.insertId]);
      }
      for(const id of[1,2,3]){
        await collectorContext.collectorBoxProducts({},session(id));
        const scoped=publishStats.at(-1);
        assert.equal(scoped.key,id===1?"admin":String(id));
        assert.equal(Number(scoped.rows.find(row=>row.source_collector_sku==="same").publish_record_count),1);
      }
      for(const id of[1,2]){
        await assert.rejects(listing.listingPublishRecordDetail(records.get(3),session(id)));
        await assert.rejects(listing.saveListingPublishRecordDraft(records.get(3),{},session(id)));
        await assert.rejects(listing.deleteListingPublishRecord(records.get(3),session(id)));
      }
      assert.equal((await query("SELECT status FROM listing_publish_records WHERE id=?",[records.get(3)]))[0].status,"failed");
      await listing.deleteCollectorBoxProducts({skus:["same"],tenant_id:"3"},session(2));
      assert.equal((await query("SELECT COUNT(*) AS n FROM ozon_plugin_collected_products WHERE sku='same' AND status<>'deleted'"))[0].n,2);
    });
    await t.test("single collected leaf ID resolves cached category, required attributes and a tenant-owned draft",async()=>{
      await query("INSERT INTO ozon_category_mappings(description_category_id,type_id,name_zh,path_zh,status) VALUES(300,400,'测试类目','汽车用品 / 测试类目','active')");
      await query("INSERT INTO ozon_category_attributes(description_category_id,type_id,attribute_id,name,name_zh,is_required,attribute_type,status) VALUES(300,400,85,'Brand','品牌',1,'String','active')");
      await listing.syncCollectedProductsFromPlugin([{sku:'leaf-fixture',title:'Leaf category test',type_id:400,attributes:[{attribute_id:85,name:'Brand',value:'Fixture brand'}]}],'2');
      const detail=await listing.collectorBoxProductDetail('leaf-fixture',session(2));
      assert.equal(String(detail.rawPayload.description_category_id),'300');
      assert.equal(String(detail.rawPayload.type_id),'400');
      assert.match(detail.category_name,/测试类目/);
      const created=await collectorContext.createListingTemplateFromCollectorBox('leaf-fixture',{allow_incomplete:true},session(2));
      const template=await listing.listingCategoryTemplateDetail(created.template.id,session(2));
      assert.equal(template.ozon_category_id,'300:400');
      assert.ok(template.attributes.some(attr=>Number(attr.attribute_id)===85),JSON.stringify(template.attributes));
      const draft=await listing.createListingDraft({template_id:template.id,product_name:'Leaf draft',template_payload:{...template,editable_payload:template.editable_payload}},session(2));
      assert.equal(draft.template_id,template.id);
      const persisted=(await query('SELECT tenant_id,template_payload_json FROM listing_drafts WHERE id=?',[draft.id]))[0];
      assert.equal(persisted.tenant_id,'2');
      assert.equal(JSON.parse(persisted.template_payload_json).ozon_category_id,'300:400');
      await assert.rejects(listing.listingCategoryTemplateDetail(template.id,session(3)),/not found/);
    });
    await t.test("SKU fallback selects its own enterprise's matching shop rather than the newest configured shop",async()=>{
      await query("UPDATE shops SET ozon_client_id='fixture-client',api_key_hint='fixture-key' WHERE id IN (20,30)");
      await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(21,2,'Newer A shop','fixture-client','fixture-key')");
      await query("INSERT INTO online_products(shop_id,ozon_sku,ozon_product_id,offer_id,name,attributes_json) VALUES(20,'OWN-SKU','','OWN-OFFER','Own product',JSON_OBJECT('description_category_id',300,'type_id',400)),(30,'PRIVATE-SKU','','PRIVATE-OFFER','Foreign product',JSON_OBJECT('description_category_id',300,'type_id',400))");
      const resolved=await listing.resolveOzonCategoryFromSku({sku:'OWN-SKU'},session(2));
      assert.equal(resolved.shopId,20);assert.equal(resolved.category.ozon_category_id,'300:400');
      await assert.rejects(listing.resolveOzonCategoryFromSku({sku:'PRIVATE-SKU'},session(2)),/Local online product cache/);
    });
  }finally{
    globalThis.fetch=originalFetch;
    if(closeMysqlPool)await closeMysqlPool();
    await fixture.cleanup();
  }
});

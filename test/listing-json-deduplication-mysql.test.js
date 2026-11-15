import test from "node:test";
import assert from "node:assert/strict";
import {createTenantMysqlFixture} from "./helpers/tenant-mysql-fixture.js";
import {LISTING_FROZEN_CONTENT_SCHEMA,assembleListingDraftStoredRow} from "../src/services/listing-frozen-content.js";
import {auditListingJsonDuplicates,applyListingJsonDuplicates,restoreListingJsonDuplicates} from "../src/services/listing-json-deduplication.js";
import {jsonArchiveHash} from "../src/services/private-json-archive.js";

test("reviewed duplicate draft JSON is lossless, reversible and enterprise scoped in real MySQL",{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async t=>{
  const fixture=await createTenantMysqlFixture("json_dedup");let closeMysqlPool;
  try{
    fixture.useEnvironment();({closeMysqlPool}=await import("../src/mysql-pool.js"));
    await(await import("../src/services/listing-automation.js")).ensureListingAutomationSchema();
    const query=async(sql,params=[])=>(await fixture.connection.query(sql,params))[0];
    await query(LISTING_FROZEN_CONTENT_SCHEMA);
    await query("INSERT INTO ozon_category_attributes(description_category_id,type_id,attribute_id,name,attribute_type) VALUES(100,200,7,'Material','String')");
    const payload={title:"Original",ozon_category_id:"100:200",attributes:[{id:7,values:["完整保留".repeat(2000)]}],editable_payload:{description_category_id:100,type_id:200,variants:[{id:"one",images:[],images_manually_edited:true,price:7000}]},private_note:"original manual facts"};
    const original=JSON.stringify(payload);
    for(const tenant of ["2","2","3"])await query("INSERT INTO listing_drafts(tenant_id,product_name,status,source_urls_json,source_images_json,ai_payload_json,template_payload_json,manual_facts_json) VALUES(?,'Draft','draft','[]','[]','{}',?,?)",[tenant,original,JSON.stringify({note:"manual unchanged"})]);
    const plan=await auditListingJsonDuplicates(query,{tenantId:"2"});assert.equal(plan.groups.length,1);assert.equal(plan.groups[0].items.length,2);
    const transaction=async work=>{await fixture.connection.beginTransaction();try{const result=await work(query);await fixture.connection.commit();return result;}catch(error){await fixture.connection.rollback();throw error;}};
    const archiveStore=new Map();let failArchive=true;
    const archive=async(text,{namespace})=>{if(failArchive)throw new Error("OSS unavailable");const ref={objectKey:`database-archives/${namespace}/${jsonArchiveHash(text)}.json.gz`,sha256:jsonArchiveHash(text)};archiveStore.set(ref.objectKey,text);return ref;};
    await assert.rejects(applyListingJsonDuplicates({query,transaction,plan,archive}),/OSS unavailable/);
    assert.equal((await query("SELECT template_payload_json FROM listing_drafts WHERE id=1"))[0].template_payload_json,original);
    failArchive=false;
    const result=await applyListingJsonDuplicates({query,transaction,plan,archive});assert.equal(result.updated.length,1);
    const rows=await query("SELECT * FROM listing_drafts ORDER BY id");
    assert.ok(JSON.parse(rows[0].template_payload_json)._listing_frozen_content_v1);
    assert.deepEqual(JSON.parse((await assembleListingDraftStoredRow(query,{tenantId:"2",row:rows[0]})).template_payload_json),payload);
    assert.equal(rows[0].manual_facts_json,JSON.stringify({note:"manual unchanged"}));assert.equal(rows[2].template_payload_json,original);
    assert.equal(result.financial_history_rows_changed,0);
    assert.equal((await query("SELECT COUNT(*) n FROM listing_frozen_content WHERE tenant_id='2' AND content_kind='product_master'"))[0].n,1);
    await query("UPDATE listing_drafts SET template_payload_json='{}' WHERE id=1");
    await assert.rejects(restoreListingJsonDuplicates({query,transaction,report:result,read:async ref=>archiveStore.get(ref.objectKey)}),/changed since compaction/);
    await query("UPDATE listing_drafts SET template_payload_json=? WHERE id=1",[rows[0].template_payload_json]);
    assert.equal((await restoreListingJsonDuplicates({query,transaction,report:result,read:async ref=>archiveStore.get(ref.objectKey)})).restored,2);
    assert.equal((await query("SELECT template_payload_json FROM listing_drafts WHERE id=1"))[0].template_payload_json,original);
    await query("UPDATE listing_drafts SET template_payload_json='{}' WHERE id=1");
    assert.equal((await applyListingJsonDuplicates({query,transaction,plan,archive})).retained[0].reason,"source_changed");
    await assert.rejects(applyListingJsonDuplicates({query,transaction,plan:{...plan,tenant_id:"3"},archive}),/Invalid reviewed/);
  }finally{await closeMysqlPool?.();await fixture.cleanup();}
});

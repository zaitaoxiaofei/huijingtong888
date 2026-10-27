import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { MATERIAL_ASSETS_SCHEMA } from "../src/services/material-assets-schema.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "../src/services/business-task-tenant.js";
import { inventoryTenantSql, resolveInventoryTenantScope } from "../src/services/inventory-tenant-scope.js";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";

const materialSource = readFileSync("src/services/material-assets.js", "utf8");
const listingSource = readFileSync("src/services/listing-automation.js", "utf8");
const listingRead = listingSource.slice(listingSource.indexOf("export async function listingAiVariantAssets("), listingSource.indexOf("export async function listingVariantWorkbenchDrafts("));
const tenantHelpers = listingSource.slice(listingSource.indexOf("function personId(session)"), listingSource.indexOf("function listingStoredShopTenantPredicate("));
const ids = rows => Array.from(rows, row => Number(row.id)).sort((a,b) => a-b);

function listingContext(query) {
  const context = vm.createContext({ all: query, ensureListingAutomationSchema: async () => {}, listingTenantLookup,
    cleanText: (value, max) => String(value || "").replace(/\s+/g," ").trim().slice(0,max),
    normalizeListingAiVariantAssetRow: row => row });
  vm.runInContext(`${tenantHelpers}\n${listingRead.replace("export ", "")}`, context);
  return context;
}

test("optional AI asset recent_days rejects invalid values without broadening a list", async () => {
  const context = listingContext(async () => { throw new Error("invalid filter reached SQL"); });
  for (const recent_days of [0,8,-1,1.5,"","7 OR 1=1",true,Infinity,[7],{value:7}]) {
    await assert.rejects(context.listingAiVariantAssets({recent_days}, {personId:7,tenant:{id:2,slug:"a"}}), error => error.status === 400 && /recent_days/.test(error.message));
  }
});

test("AI library seven-day reads hide retained old indexes without changing history or enterprise/person boundaries in real MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("ai_library_recent");
  try {
    // Mirror mysqlQuery: reads use MySQL text-query bindings, not binary LIMIT parameters.
    const q = async (sql,params=[]) => (await fixture.connection.query(sql,Array.from(params)))[0];
    await q("INSERT INTO tenants(id,slug,name) VALUES(7,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name) VALUES(7,'Operator'),(8,'Other operator')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(7,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations')),(2,8,JSON_ARRAY('operations'))");
    await q(MATERIAL_ASSETS_SCHEMA);
    const listingDdl = listingSource.match(/CREATE TABLE IF NOT EXISTS listing_ai_variant_assets \([\s\S]*?\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/)[0];
    await q(listingDdl);
    for (const [id,tenant,creator,age,status,source] of [
      [1,2,7,6,'active','ai_generated'],[2,2,7,60,'used','ai_generated'],[3,3,7,1,'active','ai_generated'],
      [4,2,7,1,'deleted','ai_generated'],[5,2,7,1,'active','shop_asset_variant'],[6,2,8,1,'active','ai_generated'],
      [7,null,7,60,'used','ai_generated'],[8,null,7,1,'active','ai_generated'],[9,7,7,1,'active','ai_generated']
    ]) await q(`INSERT INTO material_assets(id,tenant_id,created_by,title,source_type,status,usage_count,url,metadata_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,3,?,JSON_OBJECT('business_reference','retained'),DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY),UTC_TIMESTAMP())`,[id,tenant,creator,`asset-${id}`,source,status,`https://fixture.invalid/${id}.png`,age]);
    for (const [id,tenant,creator,age,status] of [[21,'2',7,6,'active'],[22,'2',7,60,'active'],[23,'2',8,1,'active'],[24,'3',7,1,'active'],[25,'admin',7,60,'active'],[26,null,7,1,'active'],[27,'admin',7,1,'active'],[28,'2',7,1,'deleted']]) {
      await q(`INSERT INTO listing_ai_variant_assets(id,tenant_id,created_by_person_id,result_id,field_key,asset_json,status,created_at,updated_at)
        VALUES(?,?,?,?, 'main_image',JSON_OBJECT('url',?),?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY),UTC_TIMESTAMP())`,[id,tenant,creator,`r-${id}`,`https://fixture.invalid/${id}.png`,status,age]);
    }
    const session = (id,slug,personId=7) => ({personId,tenant:{id,slug}});
    const material = vm.createContext({ MATERIAL_ASSETS_SCHEMA, mysqlQuery:q, mysqlExecute:q,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value,q), assertBusinessTaskPermission,
      inventoryTenantSql, resolveInventoryTenantScope: value => resolveInventoryTenantScope(value,q),
      materializeListingMediaAssetUrl: () => { throw new Error("read must not materialize or change files"); } });
    vm.runInContext(materialSource.replace(/^import[^\n]+\n/gm, "").replaceAll("export ",""), material);
    const listing = listingContext(q);
    const before = JSON.stringify({material:await q("SELECT * FROM material_assets ORDER BY id"),listing:await q("SELECT * FROM listing_ai_variant_assets ORDER BY id")});
    await t.test("working library uses creation date even when an old referenced asset was just edited", async () => {
      const recent = await material.materialAssets({paged:1,source_type:'ai_generated',recent_days:7},session(2,'a'));
      assert.deepEqual(ids(recent.rows),[1,6]); assert.equal(recent.total,2);
      const history = await material.materialAssets({source_type:'ai_generated'},session(2,'a'));
      assert.deepEqual(ids(history),[1,2,6]);
      assert.equal((await material.materialAssetDetail(2,session(2,'a'))).usage_count,3,"a historical consumer can still resolve the retained record");
      assert.deepEqual(ids(await listing.listingAiVariantAssets({recent_days:'7',field_key:'main_image'},session(2,'a'))),[21]);
      assert.deepEqual(ids(await listing.listingAiVariantAssets({field_key:'main_image'},session(2,'a'))),[21,22]);
      for(const recent_days of [1,2,3,4,5,6,7]) await material.materialAssets({recent_days},session(2,'a'));
      for(const recent_days of [0,8,-1,1.5,'','7 OR 1=1',true,[7],{value:7}]) await assert.rejects(material.materialAssets({recent_days},session(2,'a')), error=>error.status===400);
    });
    await t.test("scope remains enterprise-shared for materials and creator-private for AI result assets", async () => {
      assert.deepEqual(ids(await material.materialAssets({source_type:'ai_generated',recent_days:7,tenant_id:3,created_by:7},session(2,'a',8))),[1,6]);
      assert.deepEqual(ids(await material.materialAssets({source_type:'ai_generated',recent_days:7},session(3,'b'))),[3]);
      assert.deepEqual(ids(await listing.listingAiVariantAssets({recent_days:7,tenant_id:3,created_by_person_id:7},session(2,'a',8))),[23]);
      assert.deepEqual(ids(await listing.listingAiVariantAssets({recent_days:7},session(3,'b'))),[24]);
      assert.deepEqual(ids(await material.materialAssets({source_type:'ai_generated',recent_days:7},session(7,'default'))),[8,9]);
      assert.deepEqual(ids(await material.materialAssets({source_type:'ai_generated'},session(7,'default'))),[7,8,9]);
      assert.deepEqual(ids(await listing.listingAiVariantAssets({recent_days:7},session(7,'default'))),[26,27]);
      assert.deepEqual(ids(await listing.listingAiVariantAssets({},session(7,'default'))),[25,26,27]);
    });
    assert.equal(JSON.stringify({material:await q("SELECT * FROM material_assets ORDER BY id"),listing:await q("SELECT * FROM listing_ai_variant_assets ORDER BY id")}),before,"both library and history reads leave all records and reference metadata intact");
    await q("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
    await assert.rejects(material.materialAssets({recent_days:7},session(2,'a')),error=>error.status===403,"normal member revocation is still rechecked before read");
  } finally { await fixture.cleanup(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });

test("reviews and Ozon actions authorize enterprise shops before network calls and durable cleanup", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("reviews_actions");
  const originalFetch = globalThis.fetch;
  const requests = [];
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    const tenantColumns = await query("SHOW COLUMNS FROM tenants");
    if (!tenantColumns.some(column=>column.Field==="subscription_status")) await query("ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'");
    if (!tenantColumns.some(column=>column.Field==="subscription_expires_at")) await query("ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL");
    const shopColumns = await query("SHOW COLUMNS FROM shops");
    if (!shopColumns.some(column=>column.Field==="ozon_api_key")) await query("ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL");
    await query("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (10,NULL,'Legacy','client-10','fixture-key'),(11,1,'Default','client-11','fixture-key'),(20,2,'A','client-20','fixture-key'),(30,3,'B','client-30','fixture-key')");
    globalThis.fetch = async (url, options = {}) => {
      const endpoint = new URL(url).pathname;
      const client = options.headers?.["Client-Id"];
      requests.push({ endpoint, client, body: options.body ? JSON.parse(options.body) : null });
      let response = { result: {} };
      if (endpoint === "/v1/actions") response = { result: [] };
      if (endpoint === "/v1/review/list") response = { result: { reviews: [{ id: `sync-${client}`, text: `Private ${client}`, rating: 5 }], has_next: false, total: 1 } };
      if (endpoint === "/v1/review/comment/list") response = { result: { comments: [{ id: "comment", text: `Comment ${client}` }] } };
      if (endpoint === "/v1/review/comment/create") response = { result: { comment_id: "created" } };
      if (!endpoint.startsWith("/v1/review/") && !endpoint.startsWith("/v1/actions") && !endpoint.startsWith("/v1/seller-actions")) throw new Error(`Unexpected network request: ${endpoint}`);
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(response), json: async () => response };
    };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const reviews = await import("../src/services/reviews.js");
    const actions = await import("../src/services/ozon-actions.js");
    await reviews.reviewCenterMysql({}, session(1));
    for (const shop of [10,11,20,30]) await query("INSERT INTO ozon_reviews (id,shop_id,review_id,review_text) VALUES (?,?,?,?)", [shop,shop,`review-${shop}`,`Private ${shop}`]);

    await t.test("A/B/default review list, counts, comments and replies cannot reach other enterprises", async () => {
      for (const [id, shops] of [[1,[10,11]],[2,[20]],[3,[30]]]) {
        const result = await reviews.reviewCenterMysql({},session(id));
        assert.deepEqual(result.rows.map(row => row.shop_id).sort(),shops);
        assert.equal(result.total,shops.length);
      }
      for (const id of [1,2]) {
        assert.deepEqual(await reviews.reviewCommentsMysql(30,session(id)),[]);
        await assert.rejects(reviews.replyOzonReviewMysql(30,{text:"foreign"},30,session(id)),/评价不存在/);
        await assert.rejects(reviews.syncOzonReviewsMysql({shop_id:30},{session:session(id)}),{statusCode:404});
      }
      assert.equal(requests.length,0);
      await reviews.replyOzonReviewMysql(20,{text:"own reply"},30,session(2));
      assert.equal((await query("SELECT created_by_person_id FROM ozon_review_replies WHERE shop_id=20"))[0].created_by_person_id,7);
      assert.equal((await reviews.reviewCommentsMysql(20,session(2)))[0].text,"Comment client-20");
      const synced = await reviews.syncOzonReviewsMysql({shop_id:"all"},{session:session(1)});
      assert.deepEqual(synced.shops.map(row => row.shop_id),[10,11]);
      assert.ok(requests.every(row=>["client-10","client-11","client-20"].includes(row.client)));
    });

    const actionFunctions = [actions.listOzonActionsMysql, actions.listOzonActionCandidatesMysql, actions.listOzonActionProductsMysql, actions.addOzonActionProductsMysql, actions.removeOzonActionProductsMysql, actions.toggleOzonSellerActionMysql, actions.archiveOzonSellerActionMysql];
    const payload = { actionId:123,products:[{product_id:123,sku:123,action_price:1}],enabled:true };
    await t.test("all seven external action APIs reject foreign store IDs before making requests",async()=>{
      const before = requests.length;
      for(const id of [1,2]) for(const action of actionFunctions) await assert.rejects(action({...payload,storeId:30},{session:session(id)}),/店铺不存在/);
      assert.equal(requests.length,before);
      for(const [id,shop]of [[1,10],[2,20],[3,30]]) {
        const start=requests.length;
        for(const action of actionFunctions) await action({...payload,storeId:shop},{session:session(id)});
        assert.equal(requests.length-start,7);
        assert.ok(requests.slice(start).every(row=>row.client===`client-${shop}`));
      }
    });

    await t.test("cleanup configuration cannot be forged or read across enterprise shops",async()=>{
      for(const[id,shop]of [[1,11],[2,20],[3,30]]) {
        await actions.saveOzonActionCleanupConfigMysql({storeId:shop,enabled:false,tenant_key:"foreign",created_by_person_id:30},session(id));
        const config=await actions.getOzonActionCleanupConfigMysql({storeId:shop},session(id));
        assert.equal(config.tenant_key,id===1?"admin":String(id));
        assert.equal(config.created_by_person_id,7);
      }
      for(const id of [1,2]) {
        await assert.rejects(actions.getOzonActionCleanupConfigMysql({storeId:30},session(id)),/店铺不存在/);
        await assert.rejects(actions.saveOzonActionCleanupConfigMysql({storeId:30,enabled:true},session(id)),/店铺不存在/);
      }
    });

    await t.test("durable cleanup restores saved actor and blocks legacy missing/revoked principals",async()=>{
      const before=requests.length;
      await actions.runOzonActionCleanupForStoreMysql(30,null,{force:true});
      assert.equal(requests.length,before+1);
      assert.equal(requests.at(-1).client,"client-30");
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=3 AND person_id=7");
      await assert.rejects(actions.runOzonActionCleanupForStoreMysql(30,null,{force:true}),{statusCode:403});
      await query("UPDATE system_settings SET value_json=? WHERE `key`='ozon.actions.cleanup:30'",[JSON.stringify({enabled:true,tenant_key:"2",created_by_person_id:7})]);
      await assert.rejects(actions.runOzonActionCleanupForStoreMysql(30,null,{force:true}),/店铺不存在/);
      await query("UPDATE system_settings SET value_json=? WHERE `key`='ozon.actions.cleanup:20'",[JSON.stringify({enabled:true})]);
      await assert.rejects(actions.runOzonActionCleanupForStoreMysql(20,null,{force:true}),{statusCode:403});
      assert.equal(requests.length,before+1);
      await assert.rejects(reviews.reviewCenterMysql({},null),{statusCode:403});
      await assert.rejects(actions.listOzonActionsMysql({storeId:10}),{statusCode:403});
    });
  } finally {
    globalThis.fetch=originalFetch;
    if(closeMysqlPool)await closeMysqlPool();
    await fixture.cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { createOglDispatchService } from "../src/services/ogl-dispatch.js";
import { createOglCarriageClient } from "../src/services/ogl-carriage-client.js";
import { OGL_DISPATCH_REFRESH } from "../src/services/ogl-dispatch-access.js";
import { loadTenantOrderService } from "./helpers/tenant-order-service.js";

test("OGL official requests and cached files retain real MySQL enterprise and fresh authority boundaries", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated MySQL named pipe", timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture("ogl_revoke");
  const query = fixture.query;
  const pool = mysql.createPool({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", database: fixture.database, connectionLimit: 4 });
  const transaction = async operation => {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const value = await operation(connection); await connection.commit(); return value; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  };
  const session = tenant => ({ personId: tenant, platform_role: "super_admin", roles: ["admin"], tenant: { id: tenant, slug: tenant === 1 ? "default" : `ogl-${tenant}` } });
  const calls = [];
  const state = { hook: null, paginate: false, remoteStatus: "new", extraNumbers: [] };
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const api = createOglCarriageClient({ fetchImpl: async (url, options) => {
    const remote = new URL(url); assert.equal(remote.origin, "https://api-seller.ozon.ru");
    const shop = Number(String(options.headers["Client-Id"]).split("-").at(-1));
    const body = JSON.parse(options.body), route = remote.pathname;
    const call = { shop, path: route, body }; calls.push(call);
    await state.hook?.(call);
    if (route === "/v2/carriage/delivery/list") return json({ methods: [{ delivery_method_id: 77, departure_date: "2026-10-22T16:00:00Z", has_entrusted_acceptance: true,
      carriages: [{ id: 0, available_actions: ["create"] }, { id: 901, status: "formed", available_actions: ["get_label_containers"] }] }], has_next: state.paginate && !body.cursor, cursor: body.cursor ? "" : "page-2" });
    if (route === "/v1/carriage/create") return json({ carriage_id: 901 });
    if (route === "/v1/carriage/get") return json({ carriage_id: 901, status: state.remoteStatus, delivery_method_id: 77, containers_count: 1, first_mile_type: "pickup", integration_type: "ozon_outsourced", available_actions:["get_label_containers"], secret_customer: "do-not-expose" });
    if (route === "/v2/posting/fbs/act/get-postings") return json({ result: ["SAME-OGL", ...state.extraNumbers].map(posting_number => ({ posting_number })) });
    if (route === "/v1/carriage/set-postings") return json({ result: body.posting_numbers.map(posting_number => ({ posting_number, result: true })) });
    if (route === "/v1/carriage/courier-contact/set") return json({});
    if (route === "/v1/carriage/approve") { state.remoteStatus = "sended"; return json({}); }
    if (route === "/v2/posting/fbs/act/get-container-labels") return new Response(Buffer.from(`%PDF-1.7\nSHOP-${shop}`), { headers: { "content-type": "application/pdf" } });
    assert.fail(`Unexpected mock-only Ozon request ${route}`);
  } });
  const service = createOglDispatchService({ transaction, api, now: () => new Date("2026-10-22T16:30:00Z"),
    extractLabelTracking: async buffer => {
      const shop = Number(buffer.toString().match(/SHOP-(\d+)/)?.[1]); assert.ok(shop);
      return { status: "found", tracking_numbers: [`YT${shop}00000000000`], master_tracking_number: `YT${shop}00000000000`, source: "official_container_label" };
    }
  });
  const capabilities = JSON.stringify({ capabilities: { has_entrusted_acceptance: true } });
  try {
    for (const tenant of [1, 2, 3]) {
      const shop = tenant * 10;
      await query("INSERT INTO tenants(id,slug,name) VALUES (?,?,?)", [tenant, tenant === 1 ? "default" : `ogl-${tenant}`, `Enterprise ${tenant}`]);
      await query("INSERT INTO people(id,name,role) VALUES (?,?,'packing')", [tenant, `Packer ${tenant}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (?,?,'member',JSON_ARRAY('packing'))", [tenant, tenant]);
      await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (?,?,?,?,?)", [shop, tenant === 1 ? null : tenant, `Shop ${shop}`, `client-${shop}`, `fixture-key-${shop}`]);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES (?,?,'SAME-OGL','awaiting_deliver','awaiting_deliver',UTC_TIMESTAMP())", [shop, shop]);
      await query("INSERT INTO order_label_prints(order_id) VALUES (?)", [shop]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES (?,'SAME-OGL','awaiting_deliver',?)", [shop, JSON.stringify({ posting_number: "SAME-OGL", status: "awaiting_deliver", delivery_method: { id: 77, name: "OGL pickup" } })]);
      await query("INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES (?,?,?)", [tenant, shop, tenant]);
      await query("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,status,official_carriage_id,official_status,delivery_method_id,departure_date,official_result_json,created_by) VALUES (?,?,?,?,?,1,'ready','901','approved','77','2026-10-23',?,?)", [tenant, tenant, `OGL-${tenant}`, "same-client-key", shop, capabilities, tenant]);
      await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member) VALUES (?,?,?,?,?,'SAME-OGL',1)", [tenant, tenant, shop, shop, shop]);
    }
    async function reset() {
      state.hook = null; state.paginate = false; state.remoteStatus = "new"; state.extraNumbers = []; calls.length = 0;
      await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,role='member',business_roles_json=JSON_ARRAY('packing')");
      await query("UPDATE ogl_dispatch_settings SET default_shop_id=20 WHERE tenant_id=2");
      await query("UPDATE shops SET status='active' WHERE id=20");
      await query("DELETE FROM ogl_dispatch_official_locks WHERE tenant_id=2");
      await query("UPDATE ogl_dispatch_batches SET status='ready',official_status='approved',official_carriage_id='901',official_operation_token=NULL,official_result_json=? WHERE id=2", [capabilities]);
    }
    const revocations = [
      ["membership", () => query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2")],
      ["role", () => query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2 AND person_id=2")],
      ["subscription", () => query("UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2")]
    ];
    const denied = error => Number(error.statusCode || error.status) === 403;
    const officialQuery = { id: 901, date: "2026-10-23", tenant_id: 3, shop_id: 20 };
    const foreignSnapshot = async () => {
      const rows = {};
      for (const table of ["ogl_dispatch_settings", "ogl_dispatch_batches", "ogl_dispatch_members", "ogl_dispatch_events", "ogl_dispatch_official_locks"]) {
        rows[table] = await query(`SELECT * FROM ${table} WHERE tenant_id<>2 ORDER BY tenant_id`);
      }
      return rows;
    };
    const foreignBefore = await foreignSnapshot();

    await t.test("default legacy shop and A/B share carriage IDs without sharing order matches or label caches", async () => {
      await reset();
      for (const tenant of [1, 2, 3]) {
        const detail = await service.officialDetail(session(tenant), {...officialQuery,shop_id:tenant*10});
        assert.equal(detail.dispatch_shop.id, tenant * 10);
        assert.deepEqual(detail.members.map(row => row.order_id), [tenant * 10]);
        assert.ok(!JSON.stringify(detail).includes("do-not-expose"));
        const file = await service.file(session(tenant), tenant, "container-labels");
        assert.equal(file.buffer.toString(), `%PDF-1.7\nSHOP-${tenant * 10}`);
        const tracking = await service.officialTracking(session(tenant), {...officialQuery,shop_id:tenant*10});
        assert.equal(tracking.tracking.master_tracking_number, `YT${tenant * 10}00000000000`);
      }
      const before = calls.filter(row => row.path.endsWith("get-container-labels")).length;
      for (const tenant of [1, 2, 3]) assert.equal((await service.officialTracking(session(tenant), {...officialQuery,shop_id:tenant*10})).tracking.master_tracking_number, `YT${tenant * 10}00000000000`);
      assert.equal(calls.filter(row => row.path.endsWith("get-container-labels")).length, before);
      await assert.rejects(service.file(session(2), 3, "container-labels"), error => error.statusCode === 404);
    });

    for (const [name, revoke] of revocations) {
      for (const kind of ["file", "options"]) await t.test(`${kind} response is withheld when ${name} is revoked during the request`, async () => {
        await reset();
        state.hook = async () => { state.hook = null; await revoke(); };
        await assert.rejects(kind === "file" ? service.file(session(2), 2, "container-labels") : service.action(session(2), { batch_id: 2, action: "official-options" }), denied);
        assert.equal(calls.length, 1);
      });

      await t.test(`delivery pagination stops after page one when ${name} is revoked`, async () => {
        await reset(); state.paginate = true;
        state.hook = async row => { if (row.path === "/v2/carriage/delivery/list") { state.hook = null; await revoke(); } };
        await assert.rejects(service.listOfficial(session(2), { date: "2026-10-23" }), denied);
        assert.equal(calls.length, 1); assert.equal(calls[0].body.cursor, "");
      });

      for (const action of ["official-create", "official-confirm"]) await t.test(`${action} stops all subsequent calls when ${name} is revoked during carriage GET`, async () => {
        await reset();
        await query("UPDATE ogl_dispatch_batches SET status='preparing',official_status=?,official_carriage_id=? WHERE id=2", [action === "official-create" ? "not_created" : "created", action === "official-create" ? null : "901"]);
        state.hook = async row => { if (row.path === "/v1/carriage/get") { state.hook = null; await revoke(); } };
        await assert.rejects(service.action(session(2), { batch_id: 2, action, delivery_method_id: 77, departure_date: "2026-10-23", courier_contact: { phone: "+8613812345678" } }), denied);
        const getIndex = calls.findIndex(row => row.path === "/v1/carriage/get"); assert.ok(getIndex >= 0);
        assert.equal(calls.length, getIndex + 1);
        assert.ok(!calls.some(row => ["/v2/posting/fbs/act/get-postings", "/v1/carriage/set-postings", "/v1/carriage/courier-contact/set", "/v1/carriage/approve"].includes(row.path)));
      });
    }

    await t.test("revocation after manifest GET prevents set-postings, courier changes and approval", async () => {
      for (const action of ["official-create", "official-confirm"]) {
        await reset();
        await query("UPDATE ogl_dispatch_batches SET status='preparing',official_status=?,official_carriage_id=? WHERE id=2", [action === "official-create" ? "not_created" : "created", action === "official-create" ? null : "901"]);
        state.hook = async row => { if (row.path === "/v2/posting/fbs/act/get-postings") { state.hook = null; await revocations[0][1](); } };
        await assert.rejects(service.action(session(2), { batch_id: 2, action, delivery_method_id: 77, departure_date: "2026-10-23", courier_contact: { phone: "+8613812345678" } }), denied);
        assert.equal(calls.at(-1).path, "/v2/posting/fbs/act/get-postings");
        assert.ok(!calls.some(row => ["/v1/carriage/set-postings", "/v1/carriage/courier-contact/set", "/v1/carriage/approve"].includes(row.path)));
      }
    });

    await t.test("a cached parsed label is not returned after an in-flight authorization revocation", async () => {
      await reset(); await service.officialTracking(session(2), officialQuery); calls.length = 0;
      state.hook = async row => { if (row.path === "/v1/carriage/get") { state.hook = null; await revocations[0][1](); } };
      await assert.rejects(service.officialTracking(session(2), officialQuery), denied);
      assert.equal(calls.at(-1).path, "/v1/carriage/get");
      assert.ok(!calls.some(row => row.path.endsWith("get-container-labels")));
    });

    await t.test("interrupted A operations preserve every default and B workflow row", async () => {
      assert.deepEqual(await foreignSnapshot(), foreignBefore);
    });

    for (const [label, revoke] of [
      ["packing role", revocations[1][1]],
      ["source shop", () => query("UPDATE shops SET status='inactive' WHERE id=20")]
    ]) await t.test(`trusted OGL posting refresh rechecks ${label} before a Seller SDK retry`, async () => {
      await reset(); let networkAttempts = 0;
      const { service: orders } = loadTenantOrderService(fixture.connection, {
        extraMethods: ["syncOzonPostingsByNumberMysql", "activeShopForTenantMysql"],
        shopsMysql: async () => query("SELECT * FROM shops WHERE tenant_id=2 AND status='active'"),
        fetchOzonPostingByNumber: async (_shop, _number, options) => {
          assert.equal(typeof options.beforeRequest, "function");
          const fresh = await options.beforeRequest(); assert.equal(fresh.id, 20); networkAttempts += 1;
          await revoke();
          await options.beforeRequest(); networkAttempts += 1;
          assert.fail("A revoked refresh must not dispatch its retry");
        },
        upsertPostingMysql: async () => assert.fail("A revoked refresh must not persist a posting"),
        syncOutboundForOpenOrdersMysql: async () => {}, refreshTenantOrderAnalyticsMysql: async () => {}
      });
      const operation = orders.syncOzonPostingsByNumberMysql({ shop_id: 20, posting_numbers: ["SAME-OGL"] }, { tenantId: "2", session: session(2), [OGL_DISPATCH_REFRESH]: true });
      if (label === "packing role") await assert.rejects(operation, denied);
      else { const result = await operation; assert.equal(result.ok, false); assert.equal(result.fetched, 0); }
      assert.equal(networkAttempts, 1);
    });

    await t.test("poisoned member, event and default-shop references cannot reveal a foreign enterprise", async () => {
      await reset();
      await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,shop_id,posting_number) VALUES (2,2,30,30,'FOREIGN-PRIVATE')");
      await query("INSERT INTO ogl_dispatch_events(tenant_id,batch_id,action,reason,person_id) VALUES (3,2,'private','FOREIGN-EVENT',3)");
      const detail = await service.detail(session(2), 2);
      assert.deepEqual(detail.members.map(row => row.order_id), [20]);
      assert.ok(!/FOREIGN-PRIVATE|FOREIGN-EVENT/.test(JSON.stringify(detail)));
      calls.length = 0;
      await query("UPDATE ogl_dispatch_batches SET default_shop_id=30 WHERE id=2");
      await assert.rejects(service.file(session(2), 2, "container-labels"), error => error.statusCode === 409);
      assert.equal(calls.length, 0);
    });
  } finally {
    await pool.end();
    await fixture.cleanup();
  }
});

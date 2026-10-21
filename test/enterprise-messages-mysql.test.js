import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql from "mysql2/promise";
import { createEnterpriseMessagesService, ENTERPRISE_MESSAGES_SCHEMA_SQL } from "../src/services/enterprise-messages.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { createEnterpriseMessageRoutes } from "../src/server/routes/enterpriseMessages.js";

const session = (personId, tenantId = 1, extra = {}) => ({ personId, roles: ["operator"], tenant: { id: tenantId, slug: tenantId === 1 ? "default" : "company-b", role: "member" }, ...extra });
const execute = promisify(execFile);
test("private messages open only exact member routes without opening enterprise administration", async () => {
  const member = session(10, 2, { roles: [] });
  for (const [method, action] of [["GET", "contacts"], ["GET", "conversations"], ["GET", "unread"], ["GET", "thread"], ["GET", "references"], ["GET", "reference"], ["POST", "send"], ["POST", "read"]]) {
    const parts = ["api", "enterprise", "messages", action];
    assert.equal(authorizeApiRequest({ method, _session: member }, parts).allowed, true);
    assert.equal(tenantIsolationDecision(member, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: session(99, 1, { tenant: null, platform_role: "super_admin" }) }, parts).allowed, false);
  }
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "enterprise", "people"]).allowed, false);
  assert.equal(tenantIsolationDecision(member, ["api", "enterprise", "messages", "export"], "GET").allowed, false);
  const calls = [];
  const routes = createEnterpriseMessageRoutes({ messages: { thread: (...args) => calls.push(args), send: (...args) => calls.push(args) }, readJson: async req => req.body });
  routes["GET /api/enterprise/messages/thread"]({ _session: member }, new URL("http://test.invalid/api/enterprise/messages/thread?peer_id=20&tenant_id=999"));
  await routes["POST /api/enterprise/messages/send"]({ _session: member, body: { peer_id: 20, text: "fixture" } });
  assert.equal(calls[0][0], member);
  assert.equal(calls[1][0], member);
});

test("enterprise private messages execute scoped SQL against an isolated MySQL fixture", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Set TENANT_TEST_MYSQL_SOCKET to a dedicated isolated instance", timeout: 60000
}, async t => {
  const database = `ozon_messages_test_${randomBytes(8).toString("hex")}`;
  const admin = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root" });
  let pool, created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    pool = mysql.createPool({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", database, timezone: "Z", connectionLimit: 6 });
    const query = async (sql, values = []) => (await pool.execute(sql, values))[0];
    const transaction = async (action, afterExecute = null) => {
      const connection = await pool.getConnection();
      const transport = afterExecute ? { execute: async (...args) => { const result = await connection.execute(...args); await afterExecute(args[0], args[1], result); return result; } } : connection;
      try { await connection.query("SET time_zone = '+08:00'"); await connection.beginTransaction(); const result = await action(transport); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT UNSIGNED PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32), subscription_status VARCHAR(32), subscription_expires_at DATETIME NULL) ENGINE=InnoDB",
      "CREATE TABLE people (id BIGINT UNSIGNED PRIMARY KEY, name VARCHAR(100), username VARCHAR(100), avatar_url TEXT, role VARCHAR(32), roles_json JSON NULL, active TINYINT) ENGINE=InnoDB",
      "CREATE TABLE tenant_members (tenant_id BIGINT UNSIGNED, person_id BIGINT UNSIGNED, role VARCHAR(32), business_roles_json JSON NULL, active TINYINT, PRIMARY KEY(tenant_id,person_id)) ENGINE=InnoDB",
      "CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB",
      "CREATE TABLE orders (id BIGINT PRIMARY KEY, shop_id BIGINT, posting_number VARCHAR(100)) ENGINE=InnoDB",
      "CREATE TABLE products (id BIGINT PRIMARY KEY, tenant_id BIGINT UNSIGNED NULL, name VARCHAR(100)) ENGINE=InnoDB",
      "CREATE TABLE procurement_requests (id BIGINT PRIMARY KEY, tenant_id BIGINT UNSIGNED NULL, source_order_id BIGINT NULL, product_id BIGINT NULL, raw_name VARCHAR(100), quantity INT DEFAULT 1, status VARCHAR(32) DEFAULT 'closed', note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
      ...ENTERPRISE_MESSAGES_SCHEMA_SQL
    ]) await query(sql);
    await query("INSERT INTO tenants VALUES (1,'default','active','active',NULL),(2,'company-b','active','active',NULL)");
    for (const id of [10, 11, 12, 20, 21, 30]) await query("INSERT INTO people VALUES (?,?,?,'','operator',NULL,1)", [id, `Person ${id}`, `fixture-${id}`]);
    for (const [tenantId, personId] of [[1,10],[1,11],[1,12],[2,10],[2,20],[2,21],[1,30]]) await query("INSERT INTO tenant_members VALUES (?,?,'member','[\"operator\"]',1)", [tenantId,personId]);
    await query("INSERT INTO shops VALUES (1,1),(2,2),(3,NULL)");
    await query("INSERT INTO orders VALUES (101,1,'A-101'),(202,2,'B-202'),(103,3,'LEGACY-103')");
    await query("INSERT INTO products VALUES (1,1,'A product'),(2,2,'B product')");
    await query("INSERT INTO procurement_requests (id,tenant_id,source_order_id,product_id) VALUES (501,1,101,1),(502,2,202,2),(503,NULL,NULL,NULL),(504,1,202,2)");
    const service = createEnterpriseMessagesService({ transaction });
    let counter = 0;
    const send = (from = 10, peer = 11, text = "fixture message", tenantId = 1, extra = {}) => service.send(session(from, tenantId), { peer_id: peer, text, client_message_id: `fixture-message-${++counter}`, ...extra });

    await t.test("official administrator migration creates only the new table and is idempotent", async () => {
      await query("DROP TABLE enterprise_direct_messages");
      const args = ["scripts/migrate-enterprise-messages.mjs", "--apply", `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`];
      const options = { cwd: new URL("..", import.meta.url), env: { ...process.env, DB_CLIENT: "mysql", DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: database, DB_USER: "fixture_no_application_connection" } };
      for (let n=0;n<2;n++) {
        const { stdout } = await execute(process.execPath, args, options);
        assert.equal(JSON.parse(stdout.trim()).ready,true);
      }
      const [people] = await query("SELECT COUNT(*) AS n FROM people");
      assert.equal(people.n,6);
      const [messages] = await query("SELECT COUNT(*) AS n FROM enterprise_direct_messages");
      assert.equal(messages.n,0);
    });
    await t.test("migration rejects same-named non-unique, incorrectly ordered and wrongly typed schema", async () => {
      const original = ENTERPRISE_MESSAGES_SCHEMA_SQL[0];
      const invalidSchemas = [
        original.replace("UNIQUE KEY uk_enterprise_message_retry", "KEY uk_enterprise_message_retry"),
        original.replace("uk_enterprise_message_retry (tenant_id, sender_id, client_message_id)", "uk_enterprise_message_retry (sender_id, tenant_id, client_message_id)"),
        original.replace("tenant_id BIGINT UNSIGNED NOT NULL", "tenant_id VARCHAR(20) NOT NULL"),
        original.replace("ENGINE=InnoDB", "ENGINE=MyISAM")
      ];
      const args = ["scripts/migrate-enterprise-messages.mjs", "--apply", `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`];
      const options = { cwd: new URL("..", import.meta.url), env: { ...process.env, DB_CLIENT:"mysql", DB_HOST:"127.0.0.1", DB_PORT:"1", DB_NAME:database, DB_USER:"fixture_no_application_connection" } };
      for (const sql of invalidSchemas) {
        await query("DROP TABLE enterprise_direct_messages");
        await query(sql);
        await assert.rejects(execute(process.execPath,args,options), error => error.code===1 && /schema is incompatible/.test(error.stderr));
      }
      await query("DROP TABLE enterprise_direct_messages");
      await execute(process.execPath,args,options);
    });

    await t.test("contacts and plain text messages remain within the current enterprise", async () => {
      assert.deepEqual((await service.contacts(session(10))).rows.map(row => row.id), [11,12,30]);
      const result = await send(10,11,"<b>plain text only</b>",1,{tenant_id:2,sender_id:20,person_id:20});
      assert.equal(result.message.text, "<b>plain text only</b>");
      assert.equal(result.message.sender_id, 10);
      assert.equal(result.message.recipient_id, 11);
      assert.ok(Math.abs(new Date(result.message.created_at).getTime()-Date.now())<60000,"message creation remains UTC even with a Beijing-time SQL session");
      const [stored] = await query("SELECT tenant_id,sender_id FROM enterprise_direct_messages WHERE id=?",[result.message.id]);
      assert.equal(stored.tenant_id,1);
      assert.equal(stored.sender_id,10);
      assert.deepEqual((await service.thread(session(12), {peer_id:11})).rows, []);
      assert.equal((await service.unread(session(11))).unread_count, 1);
      assert.equal((await service.conversations(session(11))).rows[0].peer.id, 10);
      await assert.rejects(send(10,20), {statusCode:403});
      await assert.rejects(service.thread(session(20,2), {peer_id:11}), {statusCode:403});
      assert.deepEqual((await service.thread(session(30,1,{platform_role:"super_admin"}), {peer_id:11})).rows, []);
    });
    await t.test("tenant switching does not expose another tenant's thread between shared identities", async () => {
      await send(10,20,"private B",2);
      const b = await service.thread(session(10,2),{peer_id:20});
      assert.deepEqual(b.rows.map(row=>row.text), ["private B"]);
      assert.equal((await service.thread(session(10),{peer_id:11})).rows.some(row=>row.text === "private B"), false);
      await assert.rejects(service.contacts(session(99,1,{tenant:null,platform_role:"super_admin"})), {statusCode:403});
    });
    await t.test("disabled accounts, memberships, and tenants immediately lose read and write access", async () => {
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=1 AND person_id=11");
      await assert.rejects(service.thread(session(11),{peer_id:10}), {statusCode:403});
      await assert.rejects(send(), {statusCode:403});
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=1 AND person_id=11");
      await query("UPDATE people SET active=0 WHERE id=11");
      await assert.rejects(service.read(session(11),{peer_id:10,message_ids:[]}), {statusCode:403});
      await query("UPDATE people SET active=1 WHERE id=11");
      await query("UPDATE tenants SET status='archived' WHERE id=1");
      await assert.rejects(service.unread(session(10)), {statusCode:403});
      await query("UPDATE tenants SET status='active' WHERE id=1");
    });
    await t.test("retries including concurrent retries persist one message and reject changed content", async () => {
      const input = {peer_id:11,text:"retry",client_message_id:"retry-key-same"};
      const results = await Promise.all([service.send(session(10),input),service.send(session(10),input)]);
      assert.equal(results[0].message.id, results[1].message.id);
      assert.equal((await service.send(session(10),input)).duplicate,true);
      await assert.rejects(service.send(session(10),{...input,text:"different"}), {statusCode:409});
      const [count] = await query("SELECT COUNT(*) AS n FROM enterprise_direct_messages WHERE client_message_id='retry-key-same'");
      assert.equal(count.n,1);
      await assert.rejects(send(10,10), {statusCode:400});
      await assert.rejects(send(10,11," "), {statusCode:400});
      await assert.rejects(send(10,11,"x".repeat(4001)), {statusCode:400});
      await assert.rejects(service.send(session(10), {text:"missing peer",client_message_id:"missing-peer-test"}),{statusCode:400});
    });
    await t.test("an uncommitted low message ID blocks a reversed sender and polling cursor until ordered commit", async () => {
      let release, reached;
      const held = new Promise(resolve => { release = resolve; });
      const inserted = new Promise(resolve => { reached = resolve; });
      const controlled = createEnterpriseMessagesService({ transaction: action => transaction(action, async sql => {
        if (sql.startsWith("INSERT INTO enterprise_direct_messages")) { reached(); await held; }
      }) });
      const [maximum] = await query("SELECT MAX(id) AS id FROM enterprise_direct_messages");
      const low = controlled.send(session(12),{peer_id:30,text:"low uncommitted",client_message_id:"ordered-commit-low"});
      await inserted;
      let higherSettled = false, pollSettled = false;
      const high = service.send(session(30),{peer_id:12,text:"high committed later",client_message_id:"ordered-commit-high"}).finally(() => { higherSettled = true; });
      const poll = service.thread(session(12),{peer_id:30,after_id:maximum.id,limit:1}).finally(() => { pollSettled = true; });
      try {
        await new Promise(resolve => setTimeout(resolve,40));
        assert.equal(higherSettled,false,"the reversed sender must not commit a higher ID ahead of the held message");
        assert.equal(pollSettled,false,"the polling reader must not advance past an uncommitted message");
      } finally { release(); }
      const [first,second,page] = await Promise.all([low,high,poll]);
      assert.ok(first.message.id < second.message.id);
      assert.equal(page.rows[0].id,first.message.id);
      assert.equal(page.next_after_id,first.message.id);
      const next = await service.thread(session(12),{peer_id:30,after_id:page.next_after_id});
      assert.deepEqual(next.rows.map(row=>row.id),[second.message.id]);
    });
    await t.test("cursor pages are ordered, non-overlapping and do not automatically read messages", async () => {
      for(let n=0;n<5;n++) await send(12,11,`page-${n}`);
      const latest=await service.thread(session(11),{peer_id:12,limit:2});
      assert.deepEqual(latest.rows.map(row=>row.text),["page-3","page-4"]);
      assert.equal(latest.has_more,true);
      const older=await service.thread(session(11),{peer_id:12,before_id:latest.next_before_id,limit:2});
      assert.deepEqual(older.rows.map(row=>row.text),["page-1","page-2"]);
      const newer=await service.thread(session(11),{peer_id:12,after_id:older.next_after_id,limit:2});
      assert.deepEqual(newer.rows.map(row=>row.id),latest.rows.map(row=>row.id));
      assert.ok(latest.rows.every(row=>row.read_at===null));
      await assert.rejects(service.thread(session(11),{peer_id:12,before_id:1,after_id:2}),{statusCode:400});
      await service.read(session(11),{peer_id:12,message_ids:[latest.rows[0].id]});
      const [read] = await query("SELECT read_at FROM enterprise_direct_messages WHERE id=?",[latest.rows[0].id]);
      assert.ok(Math.abs(new Date(read.read_at).getTime()-Date.now())<60000,"explicit read timestamps remain UTC under a Beijing-time SQL session");
      const [count]=await query("SELECT COUNT(*) AS n FROM enterprise_direct_messages WHERE sender_id=12 AND recipient_id=11 AND read_at IS NULL");
      assert.equal(count.n,4,"only the explicitly displayed ID is marked read");
      await service.read(session(10),{peer_id:11,message_ids:latest.rows.map(row=>row.id)});
      assert.equal((await query("SELECT COUNT(*) AS n FROM enterprise_direct_messages WHERE sender_id=12 AND read_at IS NOT NULL"))[0].n,1);
    });
    await t.test("references use server labels and routes and reject foreign records and missing business permission", async () => {
      const result=await send(10,11,"reference",1,{reference:{type:"order",id:101,label:"fake",route:"https://evil.invalid"}});
      assert.equal(result.message.reference.route,"/orders?orderId=101");
      assert.equal(result.message.reference.label,"订单 A-101");
      await assert.rejects(send(10,11,"foreign",1,{reference:{type:"order",id:202}}),{statusCode:403});
      await assert.rejects(send(10,11,"foreign",1,{reference:{type:"procurement",id:502}}),{statusCode:403});
      await assert.rejects(send(10,11,"mismatched",1,{reference:{type:"procurement",id:504}}),{statusCode:403});
      const procurement=await send(10,11,"request",1,{reference:{type:"procurement",id:501}});
      assert.equal(procurement.message.reference.route,"/procurement/workspace?message_request_id=501");
      assert.equal((await service.references(session(10,2),{type:"procurement",q:"502"})).rows[0].id,502);
      const detail = await service.reference(session(10), {type:"procurement",id:501});
      assert.equal(detail.record.product_name,"A product");
      assert.equal(detail.record.status,"closed");
      assert.equal(detail.record.source_posting_number,"A-101");
      await assert.rejects(service.reference(session(10),{type:"procurement",id:502}),{statusCode:403});
      await assert.rejects(service.reference(session(10),{type:"procurement",id:504}),{statusCode:403});
      await query("UPDATE tenant_members SET business_roles_json='[\"technical\"]' WHERE tenant_id=1 AND person_id=11");
      const thread=await service.thread(session(11),{peer_id:10});
      assert.equal(thread.rows.find(row=>row.id===result.message.id).reference.available,false);
      await assert.rejects(service.send(session(11),{peer_id:10,text:"no permission",client_message_id:"no-permission-ref",reference:{type:"order",id:101}}),{statusCode:403});
      await query("UPDATE tenant_members SET business_roles_json='[\"operator\"]' WHERE tenant_id=1 AND person_id=11");
    });
  } finally {
    await pool?.end();
    if(created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

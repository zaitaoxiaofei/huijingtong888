import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('customer messages use actual tenant-owned orders, templates, chats and persisted send principals', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Set TENANT_TEST_MYSQL_SOCKET to isolated MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('messages');
  fixture.useEnvironment();
  const service = await import('../src/services/mysql-cutover.js').catch(async error => { await fixture.cleanup(); throw error; });
  const scope = await import('../src/services/customer-message-tenant-scope.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const { query } = fixture;
  const sessions = Object.fromEntries([1,2,3].map(id => [id,{personId:id,roles:['admin'],tenant:{id,slug:id===1?'default':id===2?'a':'b',role:'admin'}}]));
  const run = (id, fn) => scope.runCustomerMessageTenantOperation(sessions[id],fn);
  const calls = [];
  let revokeDuring = '';
  t.mock.method(globalThis,'fetch',async (url,options) => {
    const path = new URL(url).pathname;
    const client = Number(options.headers['Client-Id']);
    const body = JSON.parse(options.body);
    calls.push({path,client,body});
    if (revokeDuring === path) await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
    let result;
    if (path.endsWith('/chat/list')) result={chats:[{chat_id:`chat-${client}`,posting_number:`${client}-100-1`,title:`Buyer ${client}`} ]};
    else if (path.endsWith('/chat/history')) result={messages:[{message_id:'same-id',text:`Private ${client}`,sender_type:'customer',created_at:new Date().toISOString()}]};
    else if (path.endsWith('/chat/start')) result={chat_id:`chat-${client}`};
    else if (path.endsWith('/chat/send/message')) result={message_id:'sent'};
    else if (path==='/v3/posting/fbs/get') result={posting_number:body.posting_number,status:'awaiting_registration',in_process_at:new Date().toISOString(),products:[]};
    else assert.fail(`Unexpected external request ${path}`);
    return new Response(JSON.stringify({result}),{status:200,headers:{'content-type':'application/json'}});
  });
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES (1,'Default operator','admin'),(2,'A operator','admin'),(3,'B operator','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (1,1,'admin',JSON_ARRAY('admin')),(2,2,'admin',JSON_ARRAY('admin')),(3,3,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES (1,1,'Default shop','1','fixture-key'),(2,2,'A shop','2','fixture-key'),(3,3,'B shop','3','fixture-key'),(4,NULL,'Legacy shop','4','fixture-key')");
    for (const id of [1,2,3,4]) await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,last_status_changed_at) VALUES (?,?,?,'awaiting_registration',NOW(),NOW())",[id,id,`${id}-100-1`]);
    await run(2,()=>service.customerMessageSettingsMysql());
    await query("UPDATE shops SET ozon_seller_id=CONCAT('seller-',id)");
    await t.test('no context or platform-only context cannot read enterprise messages',async()=>{
      await assert.rejects(service.customerMessagesMysql(),{statusCode:403});
      await assert.rejects(scope.runCustomerMessageTenantOperation({personId:2,platform_role:'super_admin'},()=>service.customerMessageSettingsMysql()));
      assert.equal((await run(2,()=>service.customerMessageSettingsMysql())).shops.length,1);
    });
    await t.test('template migration retains old-writer dedupe and gives each enterprise independent scenarios',async()=>{
      const { inspectCustomerMessageTemplateOwnership,migrateCustomerMessageTemplateOwnership }=await import('../src/services/customer-message-template-schema.js');
      await query('DROP TABLE customer_message_templates');
      await query("CREATE TABLE customer_message_templates(scenario VARCHAR(64) PRIMARY KEY,name VARCHAR(64) NOT NULL DEFAULT '',label VARCHAR(64) NOT NULL DEFAULT '',enabled TINYINT NOT NULL DEFAULT 0,template_text TEXT,template_translation TEXT,trigger_condition VARCHAR(64) NOT NULL DEFAULT '',delay_hours INT NOT NULL DEFAULT 1,rule_defaults_version INT NOT NULL DEFAULT 1,deleted TINYINT NOT NULL DEFAULT 0,enabled_defaults_version INT NOT NULL DEFAULT 1,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
      await query("INSERT INTO customer_message_templates(scenario,template_text) VALUES ('passport_reminder','Legacy private')");
      const before=await inspectCustomerMessageTemplateOwnership(query);
      assert.equal(before.legacy_null_count,1);
      await assert.rejects(migrateCustomerMessageTemplateOwnership(query));
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      const migrationArgs=[fileURLToPath(new URL('../scripts/migrate-tenant-customer-messages.mjs',import.meta.url)),`--database=${fixture.database}`,`--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`];
      const execute=promisify(execFile);
      const dry=JSON.parse((await execute(process.execPath,migrationArgs,{env:{...process.env,...fixture.env}})).stdout);
      assert.equal(dry.changes_database,false);
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      const applied=JSON.parse((await execute(process.execPath,[...migrationArgs,'--apply','--assign-legacy-customer-default'],{env:{...process.env,...fixture.env}})).stdout);
      assert.equal(applied.templates.legacy_default_rows_assigned,1);
      await migrateCustomerMessageTemplateOwnership(query,{assignLegacyDefault:true});
      await query("INSERT INTO customer_message_templates(scenario,template_text) VALUES ('passport_reminder','Legacy updated') ON DUPLICATE KEY UPDATE template_text=VALUES(template_text)");
      for (const id of [2,3]) await run(id,()=>service.updateCustomerMessageTemplateMysql({scenario:'passport_reminder',template_text:`Tenant ${id} {{posting_number}}`,enabled:true,shop_ids:[id],tenant_id:1}));
      assert.equal((await query("SELECT COUNT(*) n FROM customer_message_templates WHERE scenario='passport_reminder'"))[0].n,3);
      for (const id of [1,2,3]) {
        const result=await run(id,()=>service.customerMessageSettingsMysql());
        assert.equal(result.templates.find(row=>row.scenario==='passport_reminder').template_text,id===1?'Legacy updated':`Tenant ${id} {{posting_number}}`);
        assert.deepEqual(result.shops.map(row=>row.shop_id),id===1?[1,4]:[id]);
      }
      const concurrent=await Promise.all([run(2,()=>service.customerMessageSettingsMysql()),run(3,()=>service.customerMessageSettingsMysql())]);
      assert.deepEqual(concurrent.map(result=>result.shops[0].shop_id),[2,3]);
      const original=await query('SELECT * FROM customer_message_templates WHERE tenant_id=2');
      await assert.rejects(run(2,()=>service.updateCustomerMessageTemplateMysql({scenario:'passport_reminder',template_text:'bad',shop_ids:[3]})),{statusCode:404});
      assert.deepEqual(await query('SELECT * FROM customer_message_templates WHERE tenant_id=2'),original);
      await run(2,()=>service.deleteCustomerMessageTemplateMysql('pickup_notice'));
      assert.ok((await run(3,()=>service.customerMessageSettingsMysql())).templates.some(row=>row.scenario==='pickup_notice'));
    });
    await t.test('lists, previews, records and retry reject foreign and poisoned order/shop references',async()=>{
      const history=await query("INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,customer_name) VALUES (2,3,'2-100-1','awaiting_registration',NOW(),NOW(),'B private poisoned history')");
      for (const id of [1,2,3]) {
        await run(id,()=>service.recordCustomerMessageMysql({order_id:id,status:'sent',message_text:`Record ${id}`}));
        const rows=await run(id,()=>service.customerMessagesMysql());
        assert.deepEqual(rows.rows.map(row=>Number(row.id)),id===1?[4,1]:[id]);
        const records=await run(id,()=>service.customerMessagesMysql({view:'send_records'}));
        assert.deepEqual(records.rows.map(row=>Number(row.order_id)),[id]);
        assert.ok(!JSON.stringify(rows).includes('B private poisoned history'));
      }
      await query('DELETE FROM order_status_history WHERE id=?',[history.insertId]);
      await assert.rejects(run(2,()=>service.previewCustomerMessageMysql({order_id:3})),{statusCode:404});
      await assert.rejects(run(1,()=>service.recordCustomerMessageMysql({order_id:2,status:'sent'})),{statusCode:404});
      await assert.rejects(run(2,()=>service.recordCustomerMessageMysql({order_id:2,shop_id:3})),{statusCode:404});
      await assert.rejects(run(2,()=>service.customerMessageCustomerOrdersMysql({shop_id:3,customer_id:'3'})),{statusCode:404});
      const poisoned=await query("INSERT INTO customer_message_tasks(order_id,shop_id,posting_number,scenario,status,scheduled_at,next_attempt_at) VALUES (3,2,'3-100-1','passport_reminder','failed',NOW(),NOW())");
      await assert.rejects(run(2,()=>service.retryCustomerMessageTaskMysql({task_id:poisoned.insertId})),{statusCode:404});
      const records=await run(2,()=>service.customerMessagesMysql({view:'send_records'}));
      assert.ok(!records.rows.some(row=>Number(row.order_id)===3));
      await query('DELETE FROM customer_message_tasks WHERE id=?',[poisoned.insertId]);
    });
    await t.test('chat sync and history use owned credentials even with identical remote message IDs',async()=>{
      for(const id of [2,3]) {
        await run(id,()=>service.syncCustomerChatsMysql({force:true,tenant_id:id===2?3:2}));
        const threads=await run(id,()=>service.customerChatThreadsMysql());
        assert.deepEqual(threads.rows.map(row=>Number(row.shop_id)),[id]);
        const messages=await run(id,()=>service.customerChatThreadMessagesMysql({shop_id:id,chat_id:`chat-${id}`}));
        assert.deepEqual(messages.rows.map(row=>row.message_text),[`Private ${id}`]);
      }
      const before=calls.length;
      await assert.rejects(run(2,()=>service.syncCustomerChatsMysql({force:true,shop_id:3})),{statusCode:404});
      await assert.rejects(run(2,()=>service.customerChatThreadMessagesMysql({shop_id:3,chat_id:'chat-3'})),{statusCode:404});
      assert.equal(calls.length,before);
      assert.deepEqual((await run(1,()=>service.customerChatThreadsMysql())).rows,[]);
    });
    await t.test('webhook receipt only queues and tenant worker never claims another enterprise event',async()=>{
      for (const id of [2,3]) await service.receiveOzonWebhookMysql({message_type:'TYPE_CHAT',seller_id:`seller-${id}`,event_id:`event-${id}`});
      assert.deepEqual((await query('SELECT status FROM ozon_webhook_events ORDER BY id')).map(row=>row.status),['received','received']);
      await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processOzonWebhookEventsMysql());
      assert.deepEqual((await query('SELECT status FROM ozon_webhook_events ORDER BY id')).map(row=>row.status),['processed','received']);
      await assert.rejects(service.processOzonWebhookEventsMysql(),{statusCode:403});
    });
    await t.test('automatic tasks persist explicit config principal; missing or revoked identity never sends',async()=>{
      await run(2,()=>service.updateCustomerMessageShopSettingMysql({shop_id:2,chat_enabled:true,send_mode:'auto',enabled_scenarios:['passport_reminder'],automation_person_id:3}));
      await run(3,()=>service.updateCustomerMessageShopSettingMysql({shop_id:3,chat_enabled:true,send_mode:'auto',enabled_scenarios:['passport_reminder']}));
      await query("UPDATE customer_message_shop_settings SET chat_capability='available',webhook_last_received_at=NOW(),passport_automation_enabled_at=DATE_SUB(NOW(),INTERVAL 1 HOUR) WHERE shop_id IN (2,3)");
      await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.materializeCustomerMessageTasksMysql());
      await scope.runCustomerMessageTenantScheduledOperation(3,()=>service.materializeCustomerMessageTasksMysql());
      for (const id of [2,3]) {
        const upcoming=await run(id,()=>service.customerMessagesMysql({view:'upcoming'}));
        assert.deepEqual(upcoming.rows.map(row=>Number(row.shop_id)),[id]);
      }
      assert.equal(Number((await query('SELECT person_id FROM customer_message_tasks WHERE shop_id=2'))[0].person_id),2);
      process.env.OZON_CUSTOMER_MESSAGE_SEND_ENABLED='1';
      await query("UPDATE customer_message_tasks SET person_id=NULL,next_attempt_at=NOW() WHERE shop_id=2");
      const before=calls.length;
      await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processCustomerMessageTasksMysql());
      assert.equal(calls.length,before);
      assert.equal((await query('SELECT status FROM customer_message_tasks WHERE shop_id=2'))[0].status,'failed');
      await run(2,()=>service.updateCustomerMessageShopSettingMysql({shop_id:2}));
      await query("UPDATE customer_message_tasks SET status='retry',next_attempt_at=NOW() WHERE shop_id=2");
      await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processCustomerMessageTasksMysql());
      assert.equal(calls.length,before);
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      await query("UPDATE customer_message_tasks SET status='retry',next_attempt_at=NOW() WHERE shop_id=2");
      const result=await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processCustomerMessageTasksMysql());
      assert.equal(result.results[0].status,'sent',JSON.stringify(result));
      assert.equal((await query('SELECT status FROM customer_message_tasks WHERE shop_id=2'))[0].status,'sent');
      assert.equal((await query("SELECT COUNT(*) n FROM customer_message_records WHERE shop_id=2 AND scenario='passport_reminder' AND status='sent'"))[0].n,1);
      assert.equal((await query('SELECT status FROM customer_message_tasks WHERE shop_id=3'))[0].status,'pending');
    });
    await t.test('actual route handlers derive context only from the authenticated session',async()=>{
      const {createOperationsRoutes,handleOperationsRestRoute}=await import('../src/server/routes/operations.js');
      const services={customerMessageSettings:service.customerMessageSettingsMysql,updateCustomerMessageTemplate:service.updateCustomerMessageTemplateMysql,deleteCustomerMessageTemplate:service.deleteCustomerMessageTemplateMysql};
      const routes=createOperationsRoutes({services,readJson:async req=>req.body});
      const own=await routes['GET /api/customer-message-settings']({_session:sessions[2],query:{tenant_id:3}});
      assert.deepEqual(own.shops.map(row=>row.shop_id),[2]);
      await routes['POST /api/customer-message-settings/template']({_session:sessions[2],body:{scenario:'order_update',template_text:'Route A',tenant_id:3,_tenantScope:{id:3}}});
      assert.equal((await query("SELECT template_text FROM customer_message_templates WHERE tenant_id=2 AND scenario='order_update'"))[0].template_text,'Route A');
      assert.equal((await query("SELECT COUNT(*) n FROM customer_message_templates WHERE tenant_id=3 AND scenario='order_update'"))[0].n,0);
      await handleOperationsRestRoute({req:{method:'DELETE',_session:sessions[2]},parts:['api','customer-message-settings','template','order_update'],services,json:(_res,value)=>value});
      assert.equal((await query("SELECT deleted FROM customer_message_templates WHERE tenant_id=2 AND scenario='order_update'"))[0].deleted,1);
    });
    await t.test('capability, preview draft and manual sends preserve ownership and idempotence',async()=>{
      const before=calls.length;
      await assert.rejects(run(2,()=>service.checkCustomerMessageShopCapabilityMysql({shop_id:3})),{statusCode:404});
      await assert.rejects(run(2,()=>service.testCustomerMessageTemplateMysql({shop_id:3,scenario:'passport_reminder',create_test_draft:true})),{statusCode:404});
      assert.equal(calls.length,before);
      assert.equal((await run(2,()=>service.checkCustomerMessageShopCapabilityMysql({shop_id:2}))).capability,'available');
      const draft=await run(2,()=>service.testCustomerMessageTemplateMysql({shop_id:2,scenario:'passport_reminder',create_test_draft:true}));
      assert.equal(draft.test_only,true);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,last_status_changed_at) VALUES (6,2,'2-300-1','awaiting_registration',NOW(),NOW())");
      process.env.OZON_CUSTOMER_MESSAGE_MANUAL_TEST_ENABLED='1';
      await assert.rejects(run(2,()=>service.sendCustomerMessageManualTestMysql({order_id:3,scenario:'passport_reminder'})),{statusCode:404});
      const sent=await run(2,()=>service.sendCustomerMessageManualTestMysql({order_id:6,scenario:'passport_reminder'}));
      assert.equal(sent.ok,true,JSON.stringify(sent));
      const count=calls.filter(row=>row.path==='/v1/chat/send/message').length;
      const repeated=await run(2,()=>service.sendCustomerMessageManualTestMysql({order_id:6,scenario:'passport_reminder'}));
      assert.equal(repeated.__status,409);
      assert.equal(calls.filter(row=>row.path==='/v1/chat/send/message').length,count);
      assert.equal((await query('SELECT status FROM customer_message_manual_tests WHERE order_id=6'))[0].status,'sent');
    });
    await t.test('scheduled worker persists a confirmed send when its original principal is revoked in flight',async()=>{
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,last_status_changed_at) VALUES (5,2,'2-200-1','awaiting_registration',NOW(),NOW())");
      await query("INSERT INTO customer_message_tasks(person_id,order_id,shop_id,posting_number,scenario,status,scheduled_at,next_attempt_at) VALUES (2,5,2,'2-200-1','passport_reminder','pending',NOW(),NOW())");
      revokeDuring='/v1/chat/send/message';
      const result=await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processCustomerMessageTasksMysql());
      assert.equal(result.results.find(row=>row.status==='sent')?.status,'sent',JSON.stringify(result));
      assert.equal((await query('SELECT status FROM customer_message_tasks WHERE order_id=5'))[0].status,'sent');
      assert.equal((await query("SELECT COUNT(*) n FROM customer_message_records WHERE order_id=5 AND status='sent'"))[0].n,1);
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      revokeDuring='';
      const before=calls.filter(row=>row.path==='/v1/chat/send/message').length;
      await scope.runCustomerMessageTenantScheduledOperation(2,()=>service.processCustomerMessageTasksMysql());
      assert.equal(calls.filter(row=>row.path==='/v1/chat/send/message').length,before);
    });
    await t.test('fresh authorization is checked after external chat creation and known sent result remains terminal',async()=>{
      await query("UPDATE customer_message_shop_settings SET chat_capability='available' WHERE shop_id=2");
      await query('DELETE FROM customer_chat_threads WHERE shop_id=2');
      const initialSends=calls.filter(row=>row.path==='/v1/chat/send/message').length;
      revokeDuring='/v1/chat/start';
      await assert.rejects(run(2,()=>service.sendCustomerMessageMysql({order_id:2,message_text:'Own message'})),{statusCode:403});
      assert.equal(calls.filter(row=>row.path==='/v1/chat/send/message').length,initialSends);
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      revokeDuring='/v1/chat/send/message';
      const sent=await run(2,()=>service.sendCustomerMessageMysql({order_id:2,message_text:'Own message'}));
      assert.equal(sent.ok,true);
      assert.equal(calls.filter(row=>row.path==='/v1/chat/send/message').length,initialSends+1);
      await assert.rejects(run(2,()=>service.sendCustomerMessageMysql({order_id:3,message_text:'foreign'})));
    });
  } finally {
    delete process.env.OZON_CUSTOMER_MESSAGE_SEND_ENABLED;
    delete process.env.OZON_CUSTOMER_MESSAGE_MANUAL_TEST_ENABLED;
    t.mock.restoreAll();
    await closeMysqlPool();
    await fixture.cleanup();
  }
});

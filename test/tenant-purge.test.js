import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tenantLifecycle } from '../src/services/tenant-lifecycle.js';
import { buildTenantPurgeScopes } from '../src/services/tenant-purge-scope.js';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'test_db'; process.env.DB_USER ||= 'test_user';
const { createTenantPurgeService, cleanupTenantPurgeFiles } = await import('../src/services/tenant-purge.js');
const now = Date.parse('2030-04-01T00:00:00Z');
const platform = { personId: 1, platform_role: 'super_admin' };
function fixture() {
 const db = new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,slug TEXT,name TEXT,status TEXT,subscription_status TEXT,subscription_expires_at TEXT,subscription_started_at TEXT,updated_at TEXT);
 CREATE TABLE ai_generation_tasks(id INTEGER PRIMARY KEY,tenant_id TEXT,status TEXT);
 CREATE TABLE shops(id INTEGER PRIMARY KEY,tenant_id INTEGER);
 CREATE TABLE orders(id INTEGER PRIMARY KEY,shop_id INTEGER);
 CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER);
 CREATE TABLE products(id INTEGER PRIMARY KEY,tenant_id TEXT);
 CREATE TABLE people(id INTEGER PRIMARY KEY);
 CREATE TABLE platform_grants(person_id INTEGER,active INTEGER);
 CREATE TABLE tenant_members(tenant_id INTEGER,person_id INTEGER);
 CREATE TABLE sessions(person_id INTEGER,active_tenant_id INTEGER);
 CREATE TABLE tenant_private_files(tenant_id INTEGER,storage_name TEXT);
 CREATE TABLE tenant_purge_audit(tenant_id INTEGER PRIMARY KEY,reason TEXT,actor_person_id INTEGER,row_counts_json TEXT);
 CREATE TABLE tenant_purge_files(id INTEGER PRIMARY KEY,tenant_id INTEGER,kind TEXT,storage_name TEXT,status TEXT DEFAULT 'pending',last_error TEXT,last_attempt_at TEXT,UNIQUE(tenant_id,kind,storage_name));
 INSERT INTO tenants VALUES(1,'default','Internal','active','active','2031-01-01',NULL,'2030-01-01'),(2,'customer-a','A','archived','expired','2030-02-01',NULL,'2030-02-02'),(3,'customer-b','B','active','active','2031-01-01',NULL,'2030-01-01');
 INSERT INTO shops VALUES(11,1),(21,2),(31,3);
 INSERT INTO orders VALUES(110,11),(210,21),(310,31);
 INSERT INTO order_items VALUES(1100,110),(2100,210),(3100,310);
 INSERT INTO products VALUES(1,'admin'),(2,'2'),(3,'3');
 INSERT INTO people VALUES(1),(2),(3); INSERT INTO platform_grants VALUES(1,1);
 INSERT INTO tenant_members VALUES(1,1),(2,2),(2,3),(3,3);
 INSERT INTO sessions VALUES(1,1),(2,2),(3,2),(3,3);
 INSERT INTO tenant_private_files VALUES(2,'a.txt'),(3,'b.txt');`);
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
 const columns=names.flatMap(name=>db.prepare(`PRAGMA table_info(${name})`).all().map(c=>({TABLE_NAME:name,COLUMN_NAME:c.name})));
 const calls=[];let failDelete=false;let beforeTransaction;
 const connection={execute:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.includes('information_schema.COLUMNS'))return[columns];
  if(sql.includes('information_schema.TABLES'))return[names.map(name=>({TABLE_NAME:name,ENGINE:'InnoDB'}))];
  if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return[[]];
  if(failDelete && sql.startsWith('DELETE r FROM `order_items`'))throw Error('delete failure');
  let local=sql.replace(/ FOR UPDATE/g,'').replace(/^DELETE r FROM (`[^`]+`) r WHERE/, 'DELETE FROM $1 AS r WHERE').replace('INSERT IGNORE','INSERT OR IGNORE');
  if(/^SELECT/.test(local))return[db.prepare(local).all(...params)];
  const result=db.prepare(local).run(...params);return[{affectedRows:Number(result.changes)}];
 }};
 const service=createTenantPurgeService({prepare:async()=>{},execute:async()=>{},now:()=>now,
  grant:async id=>db.prepare('SELECT person_id FROM platform_grants WHERE person_id=? AND active=1').get(id),
  query:async()=>db.prepare("SELECT id FROM tenants WHERE slug<>'default' AND subscription_expires_at<='2030-03-02' ORDER BY id").all(),
  transaction:async run=>{if(beforeTransaction){const cb=beforeTransaction;beforeTransaction=null;cb();}db.exec('BEGIN');try{const result=await run(connection);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
 });
 return {db,service,calls,fail:()=>{failDelete=true;},before:cb=>{beforeTransaction=cb;}};
}

test('lifecycle shows exact start, remaining days and a thirty-day expiry boundary without inventing legacy dates',()=>{
 const active=tenantLifecycle({slug:'a',status:'active',subscription_status:'active',subscription_started_at:'2030-03-01 00:00:00',subscription_expires_at:'2030-04-02 01:00:00'},now);
 assert.equal(active.remaining_days,2);assert.equal(active.subscription_started_at,'2030-03-01T00:00:00.000Z');
 assert.equal(tenantLifecycle({slug:'a'},now).subscription_started_at,null);
 assert.equal(tenantLifecycle({slug:'a',subscription_expires_at:'2030-03-02T00:00:00Z'},now).retention_due,true);
 assert.equal(tenantLifecycle({slug:'a',subscription_expires_at:'2030-03-02T00:00:01Z'},now).retention_due,false);
 assert.equal(tenantLifecycle({slug:'default',subscription_expires_at:'2020-01-01'},now).retention_due,false);
});

test('purge removes only A direct rows and shop/order descendants, preserves B/default and shared identities',async()=>{
 const f=fixture();const preview=await f.service.preview(2,platform);
 assert.equal(preview.counts.order_items,1);
 const result=await f.service.remove({tenant_id:2,fingerprint:preview.fingerprint,confirmation_name:'A'},platform);
 assert.equal(result.ok,true);
 assert.deepEqual(f.db.prepare('SELECT id FROM tenants ORDER BY id').all().map(r=>r.id),[1,3]);
 assert.deepEqual(f.db.prepare('SELECT id FROM order_items ORDER BY id').all().map(r=>r.id),[1100,3100]);
 assert.deepEqual(f.db.prepare('SELECT id FROM shops ORDER BY id').all().map(r=>r.id),[11,31]);
 assert.deepEqual(f.db.prepare('SELECT id FROM people ORDER BY id').all().map(r=>r.id),[1,2,3]);
 assert.deepEqual(f.db.prepare('SELECT person_id,active_tenant_id FROM sessions ORDER BY person_id').all().map(r=>[r.person_id,r.active_tenant_id]),[[1,1],[3,3]]);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_purge_files WHERE tenant_id=2').get().n,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_purge_audit WHERE tenant_id=2').get().n,1);
 f.db.close();
});

test('platform grant, internal enterprise, active enterprise, stale review and execution failures all fail closed',async()=>{
 const f=fixture();
 await assert.rejects(f.service.preview(2,{personId:2,platform_role:'super_admin'}),{statusCode:403});
 await assert.rejects(f.service.preview(1,platform),{statusCode:403});
 await assert.rejects(f.service.preview(3,platform),{statusCode:409});
 const preview=await f.service.preview(2,platform);
 f.db.exec('INSERT INTO order_items VALUES(2101,210)');
 await assert.rejects(f.service.remove({tenant_id:2,fingerprint:preview.fingerprint,confirmation_name:'A'},platform),{statusCode:409});
 const current=await f.service.preview(2,platform);f.fail();
 await assert.rejects(f.service.remove({tenant_id:2,fingerprint:current.fingerprint,confirmation_name:'A'},platform),/delete failure/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n,4);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenant_purge_files').get().n,0);f.db.close();
});

test('expiry sweep rechecks the locked current subscription and cannot delete a renewed enterprise',async()=>{
 const f=fixture();
 f.before(()=>f.db.exec("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at='2031-01-01' WHERE id=2"));
 const result=await f.service.sweep();assert.equal(result.results[0].skipped,true);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,3);f.db.close();
});

test('new unreviewed shop ownership refuses purge, while unsafe SQL identifiers never reach a query',()=>{
 assert.throws(()=>buildTenantPurgeScopes([{TABLE_NAME:'future_table',COLUMN_NAME:'shop_id'}]),/future_table/);
 assert.throws(()=>buildTenantPurgeScopes([{TABLE_NAME:'shops; DROP',COLUMN_NAME:'tenant_id'}]),/identifier/);
});

test('durable file cleanup removes only private files of the purged tenant and refuses traversal and symlink results',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tenant-purge-test-'));const attachments=path.join(root,'attachments');const ai=path.join(root,'ai');
 await fs.mkdir(attachments);await fs.mkdir(ai);await fs.mkdir(path.join(ai,'2'));await fs.writeFile(path.join(ai,'2','result.json'),'{}');
 await fs.writeFile(path.join(attachments,'a.txt'),'a');await fs.writeFile(path.join(attachments,'b.txt'),'b');
 const jobs=[{id:1,tenant_id:2,kind:'private_attachment',storage_name:'a.txt'},{id:2,tenant_id:2,kind:'ai_results',storage_name:'2'},{id:3,tenant_id:2,kind:'private_attachment',storage_name:'../b.txt'}];
 const updates=[];
 const result=await cleanupTenantPurgeFiles({attachmentRoots:[attachments],aiRoot:ai,query:async sql=>sql.startsWith('SELECT id,')?jobs:[],execute:async(sql,params)=>updates.push({sql,params})});
 assert.equal(result.completed,2);assert.equal(result.pending,1);
 assert.equal(await fs.readFile(path.join(attachments,'b.txt'),'utf8'),'b');
 await assert.rejects(fs.stat(path.join(attachments,'a.txt')),{code:'ENOENT'});
 await fs.symlink(attachments,path.join(ai,'3'));
 const symlink=await cleanupTenantPurgeFiles({attachmentRoots:[attachments],aiRoot:ai,query:async()=>[{id:4,tenant_id:3,kind:'ai_results',storage_name:'3'}],execute:async()=>{}});
 assert.equal(symlink.completed,0);assert.equal(await fs.readFile(path.join(attachments,'b.txt'),'utf8'),'b');
 await fs.rm(root,{recursive:true});
});

test('automatic expiry cleanup pauses for an executing tenant task and succeeds after it ends',async()=>{
 const f=fixture();f.db.exec("INSERT INTO ai_generation_tasks VALUES(1,'2','running')");
 const blocked=await f.service.sweep();assert.equal(blocked.errors[0].tenant_id,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id=2').get().n,1);
 f.db.exec("UPDATE ai_generation_tasks SET status='failed' WHERE id=1");
 const complete=await f.service.sweep();assert.equal(complete.results[0].ok,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id=2').get().n,0);
 assert.deepEqual(f.db.prepare('SELECT id FROM tenants ORDER BY id').all().map(r=>r.id),[1,3]);f.db.close();
});

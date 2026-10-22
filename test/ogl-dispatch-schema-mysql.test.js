import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { migrateOglDispatchSchema } from '../scripts/lib/ogl-dispatch-schema-migration.mjs';
import { assertOglDispatchSchemaReady } from '../src/services/ogl-dispatch-schema.js';
import { readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('OGL release migration creates explicit tenant tables before dependent readers and refuses unsafe partial schemas',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL'
},async t=>{
  const fixture=await createTenantMysqlFixture('ogl_schema');
  const {query}=fixture;
  const [{database_name:database}]=await query('SELECT DATABASE() AS database_name');
  const tables=['ogl_dispatch_settings','ogl_dispatch_batches','ogl_dispatch_members','ogl_dispatch_official_locks','ogl_dispatch_events'];
  const migrate=options=>migrateOglDispatchSchema(query,{database,...options});
  try {
    await t.test('dry-run is read-only and the explicit administrator apply is idempotent',async()=>{
      for(const table of tables)await query(`DROP TABLE ${table}`);
      const preview=await migrate();
      assert.equal(preview.mode,'dry-run');assert.equal(preview.before.missing_tables.length,5);
      await assert.rejects(assertOglDispatchSchemaReady(query),{statusCode:503});
      assert.equal((await migrate({apply:true})).created_tables.length,5);
      assert.equal((await migrate({apply:true})).created_tables.length,0);
      assert.equal((await assertOglDispatchSchemaReady(query)).ready,true);
      await assert.rejects(migrateOglDispatchSchema(query,{database:'another_database',apply:true}),/differs/);
      const output=execFileSync(process.execPath,['scripts/migrate-ogl-dispatch-schema.mjs',`--database=${database}`,`--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`],{encoding:'utf8',timeout:20000});
      assert.equal(JSON.parse(output).mode,'dry-run');
    });
    await t.test('existing rows and explicit attribution survive repeated migration',async()=>{
      await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES(2,20,7)');
      const before=await query('SELECT * FROM ogl_dispatch_settings');
      await migrate({apply:true});assert.deepEqual(await query('SELECT * FROM ogl_dispatch_settings'),before);
    });
    await t.test('nullable or defaulted ownership blocks readiness and does not get guessed during apply',async()=>{
      await query('ALTER TABLE ogl_dispatch_events MODIFY tenant_id BIGINT UNSIGNED NULL');
      await assert.rejects(assertOglDispatchSchemaReady(query),/explicit BIGINT/);
      await assert.rejects(migrate({apply:true}),/no DDL applied/);
      await query('ALTER TABLE ogl_dispatch_events MODIFY tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1');
      await assert.rejects(migrate({apply:true}),/without default/);
      await query('ALTER TABLE ogl_dispatch_events ALTER tenant_id DROP DEFAULT');
    });
    await t.test('global, nonunique, prefix and invisible workflow keys are refused',async()=>{
      await query('ALTER TABLE ogl_dispatch_batches DROP INDEX uk_ogl_batch_request, ADD UNIQUE INDEX uk_ogl_batch_request(client_request_id)');
      await assert.rejects(migrate({apply:true}),/UNIQUE\(tenant_id,client_request_id\)/);
      await query('ALTER TABLE ogl_dispatch_batches DROP INDEX uk_ogl_batch_request, ADD INDEX uk_ogl_batch_request(tenant_id,client_request_id)');
      await assert.rejects(assertOglDispatchSchemaReady(query),{statusCode:503});
      await query('ALTER TABLE ogl_dispatch_batches DROP INDEX uk_ogl_batch_request, ADD UNIQUE INDEX uk_ogl_batch_request(tenant_id,client_request_id(10))');
      await assert.rejects(assertOglDispatchSchemaReady(query),{statusCode:503});
      await query('ALTER TABLE ogl_dispatch_batches DROP INDEX uk_ogl_batch_request, ADD UNIQUE INDEX uk_ogl_batch_request(tenant_id,client_request_id) INVISIBLE');
      await assert.rejects(assertOglDispatchSchemaReady(query),{statusCode:503});
      await query('ALTER TABLE ogl_dispatch_batches ALTER INDEX uk_ogl_batch_request VISIBLE');
      await query('ALTER TABLE ogl_dispatch_batches ADD UNIQUE INDEX unsafe_global_number(batch_number)');
      await assert.rejects(migrate({apply:true}),/unsafe_global_number/);
      await query('ALTER TABLE ogl_dispatch_batches DROP INDEX unsafe_global_number');
    });
    await t.test('surrogate identities retain their primary keys and auto increment semantics',async()=>{
      for(const table of ['ogl_dispatch_batches','ogl_dispatch_members','ogl_dispatch_events']) {
        await query(`ALTER TABLE ${table} MODIFY id BIGINT UNSIGNED NOT NULL, DROP PRIMARY KEY`);
        await assert.rejects(migrate({apply:true}),/AUTO_INCREMENT|PRIMARY/);
        await query(`ALTER TABLE ${table} ADD PRIMARY KEY(id)`);
        await assert.rejects(assertOglDispatchSchemaReady(query),/AUTO_INCREMENT/);
        await query(`ALTER TABLE ${table} MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`);
      }
      await query('ALTER TABLE ogl_dispatch_events ENGINE=MyISAM');
      await assert.rejects(migrate({apply:true}),/InnoDB/);
      await query('ALTER TABLE ogl_dispatch_events ENGINE=InnoDB');
      assert.equal((await assertOglDispatchSchemaReady(query)).ready,true);
    });
    await t.test('a failed or partial installation can retry without changing valid rows',async()=>{
      await query('DROP TABLE ogl_dispatch_events');
      await query('ALTER TABLE ogl_dispatch_members DROP COLUMN sync_error');
      await assert.rejects(migrate({apply:true}),/sync_error missing/);
      assert.ok((await migrate().catch(error=>({error:error.message}))).error);
      await query('ALTER TABLE ogl_dispatch_members ADD COLUMN sync_error VARCHAR(2000) NULL');
      const result=await migrate({apply:true});assert.deepEqual(result.created_tables,['ogl_dispatch_events']);
      assert.equal((await query('SELECT tenant_id FROM ogl_dispatch_settings'))[0].tenant_id,2);
      assert.equal((await assertOglDispatchSchemaReady(query)).ready,true);
    });
    await t.test('DDL interruption releases the administrator lock and a retry creates only missing tables',async()=>{
      for(const table of tables)await query(`DROP TABLE ${table}`);
      let creates=0;
      const interrupted=async(sql,params=[])=>{
        if(sql.startsWith('CREATE TABLE')&&++creates===2)throw new Error('fixture DDL interruption');
        return query(sql,params);
      };
      await assert.rejects(migrateOglDispatchSchema(interrupted,{database,apply:true}),/fixture DDL/);
      const lockName=`ogl_schema_v1:${createHash('sha256').update(database).digest('hex').slice(0,32)}`;
      const [lock]=await query('SELECT IS_FREE_LOCK(?) AS available',[lockName]);assert.equal(lock.available,1);
      assert.equal((await migrate({apply:true})).created_tables.length,4);
      assert.equal((await assertOglDispatchSchemaReady(query)).ready,true);
    });
  }finally{await fixture.cleanup();}
});

test('release backs up and installs OGL schema before maintenance and candidate readers even when maintenance is skipped',()=>{
  const source=readFileSync(new URL('../deploy/linux/remote-release.sh',import.meta.url),'utf8');
  const hook=source.indexOf('if [[ -f "$staging_dir/scripts/migrate-ogl-dispatch-schema.mjs" ]]');
  assert.ok(hook>source.indexOf('  backup_database\n'));
  assert.ok(hook<source.indexOf('if [[ "$run_db_maintenance" == "1" && "$run_db_init" == "1" ]]'));
  assert.ok(hook<source.indexOf('\nstart_candidate\n'));
  assert.ok(source.slice(hook,source.indexOf('\nfi',hook)).includes('--apply --database="$DB_NAME"'));
});

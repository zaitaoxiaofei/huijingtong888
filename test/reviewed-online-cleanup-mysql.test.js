import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { REVIEWED_ONLINE_PAIRS,inspectReviewedOnlineCleanup,applyReviewedOnlineCleanup,inspectOnlineCleanupJournal,rollbackReviewedOnlineCleanup } from '../scripts/lib/reviewed-online-cleanup.mjs';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET,options={skip:!socketPath};
async function fixture(body) {
  const db=await mysql.createConnection({socketPath,user:'root',supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,jsonStrings:true,multipleStatements:true});
  const database=`ozon_online_test_${randomBytes(8).toString('hex')}`;let created=false;
  const query=async(text,args=[]) => (await db.query(text,args))[0];
  try {
    assert.equal(Number((await query('SELECT @@skip_networking value'))[0].value),1);
    await query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);created=true;await db.changeUser({database});await query("SET SESSION time_zone='+00:00'");
    await query(`CREATE TABLE tenants(id BIGINT UNSIGNED PRIMARY KEY,slug VARCHAR(64)) ENGINE=InnoDB; INSERT INTO tenants VALUES(1,'default'),(2,'customer-a');
      CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED) ENGINE=InnoDB; INSERT INTO shops VALUES(4,NULL),(5,NULL),(6,NULL),(7,NULL),(20,2);
      CREATE TABLE products(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED,quantity INT,amount DECIMAL(14,4),raw_json LONGTEXT) ENGINE=InnoDB; INSERT INTO products VALUES(504,NULL,17,12.5000,'preserve four-piece'),(518,NULL,13,50.0000,'same tenant'),(521,NULL,20,19.5000,'eight-piece'),(900,2,19,1.0000,'foreign');
      CREATE TABLE orders(id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED,tenant_id BIGINT UNSIGNED,amount DECIMAL(14,4)) ENGINE=InnoDB; INSERT INTO orders VALUES(4,4,NULL,12.5000),(5,5,NULL,13.5000),(6,6,NULL,14.5000),(7,7,NULL,15.5000);
      CREATE TABLE order_items(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED,quantity INT) ENGINE=InnoDB; INSERT INTO order_items VALUES(4,4,1),(5,5,2),(6,6,3),(13657,7,1);
      CREATE TABLE online_products(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL,ozon_sku VARCHAR(128) NOT NULL,ozon_product_id VARCHAR(128),product_id BIGINT UNSIGNED,status VARCHAR(32),raw_json LONGTEXT,amount DECIMAL(14,4),updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),KEY uk_online_products_shop_sku(shop_id,ozon_sku)) ENGINE=InnoDB;
      CREATE TABLE online_product_actions(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,tenant_id VARCHAR(64),request_json LONGTEXT,updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB;
      CREATE TABLE outbound_records(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,order_item_id BIGINT UNSIGNED,quantity INT,amount DECIMAL(14,4),evidence LONGBLOB,updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB;
      CREATE TABLE ozon_stock_snapshots(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,quantity INT,updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB;
      CREATE TABLE sku_mappings(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,tenant_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,amount DECIMAL(14,4),updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB;
      CREATE TABLE product_barcode_label_cache(online_product_id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED,label_pdf LONGBLOB,ozon_product_id VARCHAR(128)) ENGINE=InnoDB;
      CREATE TABLE sku_inventory_recipes(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED) ENGINE=InnoDB;
      CREATE TABLE inventory_product_requests(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED,payload_json LONGTEXT) ENGINE=InnoDB;
      INSERT INTO inventory_product_requests VALUES(1,NULL,'{"unrelated":true}');
      INSERT INTO product_barcode_label_cache VALUES(243408,4,UNHEX('000102FFABCDEF'),'5736715451');
      INSERT INTO outbound_records VALUES(13777,243408,4,518,13657,2,-17.2500,UNHEX('00FF000A'),'2025-01-01 01:01:01.123456');`);
    let n=0;
    for(const pair of REVIEWED_ONLINE_PAIRS) {
      n++;
      for(const [rowId,old] of [[pair.remove_id,true],[pair.keep_id,false]])await query('INSERT INTO online_products(id,shop_id,ozon_sku,ozon_product_id,product_id,status,raw_json,amount,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[rowId,pair.shop_id,pair.ozon_sku,old?'OLD-IDENTITY':pair.keep_id==='243408'?'5736715451':'NEW-IDENTITY',old?504:pair.keep_id==='243408'?518:521,old?'old':'ready',old?'{"image":"old"}':'{"image":"new"}',old?'12.1250':'13.2500','2025-01-01 01:01:01.123456']);
      if(n<=2)await query("INSERT INTO online_product_actions VALUES(?,?,?,?,?,'2025-01-01 01:01:01.123456')",[n,pair.remove_id,pair.shop_id,'admin','{"historical_online_id":'+pair.remove_id+'}']);
      if(n<=4)await query("INSERT INTO sku_mappings VALUES(?,?,?,?,?,?,'2025-01-01 01:01:01.123456')",[n,pair.remove_id,pair.shop_id,null,504,'12.5000']);
      if(n<=2)await query("INSERT INTO ozon_stock_snapshots VALUES(?,?,?,?,?,'2025-01-01 01:01:01.123456')",[n,pair.remove_id,pair.shop_id,504,17]);
    }
    for(let i=1;i<=20;i++){const pair=REVIEWED_ONLINE_PAIRS[(i-1)%8];await query("INSERT INTO outbound_records VALUES(?,?,?,?,?,?,?,UNHEX('000102FF'),'2025-01-01 01:01:01.123456')",[i,pair.remove_id,pair.shop_id,504,pair.shop_id,i,'12.5000']);}
    const columns=(await query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='outbound_records' ORDER BY ORDINAL_POSITION")).map(r=>r.COLUMN_NAME);
    const expression=`SHA2(CONCAT(${columns.map(c=>`IF(\`${c}\` IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(\`${c}\` AS BINARY)),':',HEX(CAST(\`${c}\` AS BINARY))))`).join(',')}),256)`;
    const sha=(await query(`SELECT ${expression} sha FROM outbound_records WHERE id=13777`))[0].sha;
    const plan={version:1,mode:'reviewed-online-eight',repair_id:randomBytes(6).toString('hex'),pairs:structuredClone(REVIEWED_ONLINE_PAIRS),reviewed_by:'isolated-test',reason:'Exact eight user-reviewed choices',maintenance_confirmed:true,production_approved:true,rollback_restores_nonunique_schema:true,
      unchanged_outbound_reference:{table:'outbound_records',row_id:'13777',shop_id:'4',online_product_id:'243408',order_item_id:'13657',expected_parent_order_id:'7',expected_parent_shop_id:'7',expected_tenant_id:'1',expected_full_row_sha256:sha,user_confirmation_reference:'User explicitly retained complete row13777 pending review',reason:'No guessed historical parent correction'}};
    const reviewed=async()=>{plan.expected_snapshot=(await inspectReviewedOnlineCleanup(db,plan)).snapshot;return plan;};
    await body({db,database,query,plan,reviewed});
  }finally{if(created)await query(`DROP DATABASE \`${database}\``);await db.end();}
}

test('read-only exact eight audit; differing identities accepted only through explicit reviewed pairs',options,()=>fixture(async({db,query,plan})=>{
  const before=await query('SHOW TABLES');await db.query('START TRANSACTION READ ONLY');const report=await inspectReviewedOnlineCleanup(db,plan);await db.rollback();
  assert.equal(report.changes_database,false);assert.equal(report.snapshot.reviewed_rows.count,16);assert.equal(report.snapshot.references.find(r=>r.table==='outbound_records').changed.count,20);assert.deepEqual(await query('SHOW TABLES'),before);
  const altered=structuredClone(plan);altered.pairs[0].keep_id='243398';await assert.rejects(inspectReviewedOnlineCleanup(db,altered),/exact eight/);
}));
test('strict shadow preserves all retained/original bytes, remaps only28 IDs, protected rows and timestamps untouched; matching rollback',options,()=>fixture(async({db,database,query,reviewed})=>{
  const plan=await reviewed(),tables=['online_products','online_product_actions','outbound_records','ozon_stock_snapshots','sku_mappings','product_barcode_label_cache','products','orders','order_items'];
  const baseline=Object.fromEntries(await Promise.all(tables.map(async t=>[t,await query(`SELECT * FROM \`${t}\` FORCE INDEX(PRIMARY) ORDER BY 1`)])));
  const result=await applyReviewedOnlineCleanup(db,plan,database);assert.equal(result.phase,'applied');assert.equal(result.references.reduce((n,r)=>n+r.changed,0),28);assert.equal(result.canonical_rows,8);
  for(const table of tables.filter(t=>!['online_products','online_product_actions','outbound_records','ozon_stock_snapshots','sku_mappings'].includes(t)))assert.deepEqual(await query(`SELECT * FROM \`${table}\` FORCE INDEX(PRIMARY) ORDER BY 1`),baseline[table]);
  for(const table of ['online_product_actions','outbound_records','ozon_stock_snapshots','sku_mappings'])for(const [i,row] of (await query(`SELECT * FROM \`${table}\` FORCE INDEX(PRIMARY) ORDER BY 1`)).entries()){const old=baseline[table][i];assert.deepEqual({...row,online_product_id:old.online_product_id},old,table);}
  const state=await inspectOnlineCleanupJournal(db,plan.repair_id);assert.deepEqual(await query(`SELECT * FROM \`${state.archive}\` FORCE INDEX(PRIMARY) ORDER BY 1`),baseline.online_products);
  assert.equal((await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true)).schema_exact,false);
  for(const table of tables)assert.deepEqual(await query(`SELECT * FROM \`${table}\` FORCE INDEX(PRIMARY) ORDER BY 1`),baseline[table],table);
}));
test('strict actual UNIQUE rejects an unreviewed duplicate; source and references unchanged',options,()=>fixture(async({db,database,query,reviewed})=>{
  await query("INSERT INTO online_products(id,shop_id,ozon_sku,product_id) VALUES(999999,5,'5173097673',504)");const plan=await reviewed();
  await assert.rejects(applyReviewedOnlineCleanup(db,plan,database),{code:'ER_DUP_ENTRY'});assert.equal((await query('SELECT * FROM online_products FORCE INDEX(PRIMARY)')).length,17);assert.equal(String((await query('SELECT online_product_id FROM sku_mappings WHERE id=1'))[0].online_product_id),'243359');
  assert.equal((await inspectOnlineCleanupJournal(db,plan.repair_id)).phase,'preparing');await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true);
}));
test('native snapshot drift, new references, foreign enterprise, requests and writable schema fail closed',options,()=>fixture(async({db,database,query,plan,reviewed})=>{
  await reviewed();await query('UPDATE outbound_records SET quantity=99 WHERE id=1');await assert.rejects(applyReviewedOnlineCleanup(db,plan,database),/snapshot/);
  await query('UPDATE outbound_records SET quantity=1,updated_at=\'2025-01-01 01:01:01.123456\' WHERE id=1');await reviewed();await query("INSERT INTO inventory_product_requests VALUES(2,NULL,'{\"online_product_id\":243359}')");await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/request JSON/);await query('DELETE FROM inventory_product_requests WHERE id=2');
  await query('UPDATE sku_mappings SET tenant_id=2 WHERE id=1');await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/crosses enterprises/);await query('UPDATE sku_mappings SET tenant_id=NULL WHERE id=1');
  await query('CREATE TABLE new_ref(id INT PRIMARY KEY,online_product_id BIGINT) ENGINE=InnoDB');await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/Unknown typed/);await query('DROP TABLE new_ref');
  await query('ALTER TABLE online_product_actions ADD g INT GENERATED ALWAYS AS (id+1) STORED');await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/Generated/);
}));
test('cross-schema FK and trigger refuse before any journal mutation',options,()=>fixture(async({db,query,plan,database})=>{
  const foreign=`${database}_fk`;try{await query(`CREATE DATABASE \`${foreign}\`;CREATE TABLE \`${foreign}\`.child(id BIGINT PRIMARY KEY,parent BIGINT UNSIGNED,FOREIGN KEY(parent) REFERENCES \`${database}\`.online_products(id)) ENGINE=InnoDB`);await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/foreign keys/);}finally{await query(`DROP DATABASE IF EXISTS \`${foreign}\``);}
  await query('CREATE TRIGGER stop_cleanup BEFORE UPDATE ON sku_mappings FOR EACH ROW SET NEW.amount=NEW.amount');await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/Triggers/);assert.equal((await query("SHOW TABLES LIKE '_reviewed_online_cleanups'")).length,0);
}));
test('reference failure rolls back all28 remaps, native archives and timestamps',options,()=>fixture(async({db,database,query,reviewed})=>{
  const plan=await reviewed(),before=await query('SELECT * FROM outbound_records ORDER BY id');
  const wrapped={query:(text,args)=>text.startsWith('UPDATE `sku_mappings`')?db.query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture remap rejection'"):db.query(text,args),beginTransaction:db.beginTransaction.bind(db),commit:db.commit.bind(db),rollback:db.rollback.bind(db)};
  await assert.rejects(applyReviewedOnlineCleanup(wrapped,plan,database),{code:'ER_SIGNAL_EXCEPTION'});assert.deepEqual(await query('SELECT * FROM outbound_records ORDER BY id'),before);assert.equal((await inspectOnlineCleanupJournal(db,plan.repair_id)).phase,'preparing');await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true);
}));
test('crash after reference commit is identified and matching rollback preserves complete records',options,()=>fixture(async({db,database,query,reviewed})=>{
  const plan=await reviewed(),before=await query('SELECT * FROM outbound_records ORDER BY id');
  const wrapped={query:db.query.bind(db),beginTransaction:db.beginTransaction.bind(db),rollback:db.rollback.bind(db),commit:async()=>{await db.commit();throw Error('after-commit');}};
  await assert.rejects(applyReviewedOnlineCleanup(wrapped,plan,database),/after-commit/);assert.equal((await inspectOnlineCleanupJournal(db,plan.repair_id)).phase,'references_applied');await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true);assert.deepEqual(await query('SELECT * FROM outbound_records ORDER BY id'),before);
}));
test('crash after forward and reverse rename recovers by journal/native identities; later changes refuse undo',options,()=>fixture(async({db,database,query,reviewed})=>{
  const plan=await reviewed();const wrapped={query:async(text,args)=>{if(text.startsWith('UPDATE `_reviewed_online_cleanups`')&&args?.[0]==='applied')throw Error('after-rename');return db.query(text,args);},beginTransaction:db.beginTransaction.bind(db),commit:db.commit.bind(db),rollback:db.rollback.bind(db)};
  await assert.rejects(applyReviewedOnlineCleanup(wrapped,plan,database),/after-rename/);assert.equal((await inspectOnlineCleanupJournal(db,plan.repair_id)).phase,'swap_pending');
  await query("INSERT INTO inventory_product_requests VALUES(2,NULL,'{\"online_product_id\":243397}')");await assert.rejects(rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true),/active request/);await query('DELETE FROM inventory_product_requests WHERE id=2');
  await query('CREATE TABLE new_ref(id INT PRIMARY KEY,online_product_id BIGINT) ENGINE=InnoDB');await assert.rejects(rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true),/Unknown typed/);await query('DROP TABLE new_ref');
  await query('UPDATE outbound_records SET amount=99 WHERE id=1');await assert.rejects(rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true),/Reference/);await query("UPDATE outbound_records SET amount=12.5,updated_at='2025-01-01 01:01:01.123456' WHERE id=1");
  const undo={...wrapped,query:db.query.bind(db),beginTransaction:async()=>{throw Error('after-reverse-rename');}};
  await assert.rejects(rollbackReviewedOnlineCleanup(undo,plan.repair_id,database,true),/after-reverse/);assert.equal((await inspectOnlineCleanupJournal(db,plan.repair_id)).phase,'rollback_swap_pending');assert.equal((await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true)).phase,'rolled_back');
}));
test('writing CLI rejects ambiguous/unknown/non-bare flags before connection',()=>{
  for(const args of [['--apply=false'],['--apply=true'],['--apply','--apply'],['--unknown']]){const r=spawnSync(process.execPath,['scripts/repair-reviewed-online-products.mjs',...args],{encoding:'utf8'});assert.equal(r.status,1);assert.doesNotMatch(r.stderr,/ECONNREFUSED|password|PRIVATE/);}
});
test('additional secondary index ordering preserves schema through apply and rollback',options,()=>fixture(async({db,database,query,plan,reviewed})=>{
  await query('ALTER TABLE online_products ADD KEY status_lookup(status)');await reviewed();await applyReviewedOnlineCleanup(db,plan,database);await rollbackReviewedOnlineCleanup(db,plan.repair_id,database,true);
}));
test('CHECK schema refuses before journal or shadow creation',options,()=>fixture(async({db,query,plan})=>{
  await query('ALTER TABLE online_products ADD CHECK(amount>=0)');
  await assert.rejects(inspectReviewedOnlineCleanup(db,plan),/CHECK constraints/);assert.equal((await query("SHOW TABLES LIKE '_reviewed_online_cleanups'")).length,0);assert.equal((await query("SHOW TABLES LIKE '_roc_%'")).length,0);
}));

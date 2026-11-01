import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
const source=fs.readFileSync(new URL('../src/services/listing-automation.js',import.meta.url),'utf8');
const repaired=source.match(/UPDATE listing_drafts\s+SET development_type = 'copy'[^]*?(?=`\)\.catch)/)?.[0];
const legacy="UPDATE listing_drafts SET development_type='copy',vehicle_brand='',vehicle_model='',vehicle_model_key='',updated_at=CURRENT_TIMESTAMP WHERE status<>'deleted' AND (ai_payload_json LIKE '%ai_product_material_optimizer%' OR manual_facts_json LIKE '%ai_product_material_optimizer%')";
test('startup migration retains legacy values and skips already repaired drafts without refreshing timestamps',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL'},async()=>{
 const mysql=await import('mysql2/promise'),c=await mysql.createConnection({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',dateStrings:true}),db='test_startup_'+randomUUID().replaceAll('-','');
 try{
  const [[flags]]=await c.query('SELECT @@skip_networking isolated');assert.equal(Number(flags.isolated),1);
  assert.ok(repaired);await c.query('CREATE DATABASE `'+db+'`');await c.changeUser({database:db});
  const schema="(id INT PRIMARY KEY,status VARCHAR(32),development_type VARCHAR(32),vehicle_brand VARCHAR(64),vehicle_model VARCHAR(64),vehicle_model_key VARCHAR(64),ai_payload_json LONGTEXT,manual_facts_json LONGTEXT,updated_at DATETIME) ENGINE=InnoDB";
  await c.query('CREATE TABLE listing_drafts '+schema);await c.query('CREATE TABLE expected '+schema);
  const marker='ai_product_material_optimizer';const definitions=[
   ['active','original','Brand','Model','key',marker,''],['active','copy','','','',marker,''],
   ['deleted','original','Brand','Model','key',marker,''],['active','original','Brand','Model','key','manual',''],
   ['active',null,null,null,null,'',marker],['active','COPY','','','',marker,''],
   ['active','copy',' ','','',marker,''],['active','original','Brand','','','',marker],
   ['active','copy','','','','manual',''],['active','copy','','','',null,null]
  ];
  const data=definitions.map((values,i)=>[i+1,...values,'2001-01-01 00:00:00']);
  await c.query('INSERT INTO listing_drafts VALUES ?',[data]);await c.query('INSERT INTO expected SELECT * FROM listing_drafts');
  await c.query(legacy.replaceAll('listing_drafts','expected'));await c.query(repaired);
  const select='SELECT id,status,development_type,vehicle_brand,vehicle_model,vehicle_model_key,ai_payload_json,manual_facts_json FROM ';
  assert.deepEqual((await c.query(select+'listing_drafts ORDER BY id'))[0],(await c.query(select+'expected ORDER BY id'))[0],'field results must exactly match legacy migration, including NULL/case/whitespace');
  const [unchanged]=await c.query('SELECT id,updated_at FROM listing_drafts WHERE id IN(2,3,4,9,10)');assert.ok(unchanged.every(row=>row.updated_at==='2001-01-01 00:00:00'),'already correct, manual and deleted rows keep their edit timestamp');
  const [repeat]=await c.query(repaired);assert.equal(repeat.affectedRows,0,'second startup performs no writes');
  const padding='x'.repeat(32768);const bulk=Array.from({length:300},(_,i)=>[100+i,'active','copy','','','',JSON.stringify({source:marker,padding}),'','2001-01-01 00:00:00']);await c.query('INSERT INTO listing_drafts VALUES ?',[bulk]);
  let started=performance.now();const [next]=await c.query(repaired);const newMs=Math.round(performance.now()-started);assert.equal(next.affectedRows,0);
  started=performance.now();await c.query(legacy);console.log(JSON.stringify({repaired_drafts:300,payload_bytes:padding.length,noop_ms:newMs,legacy_ms:Math.round(performance.now()-started)}));
 }finally{await c.query('DROP DATABASE IF EXISTS `'+db+'`');await c.end();}
});

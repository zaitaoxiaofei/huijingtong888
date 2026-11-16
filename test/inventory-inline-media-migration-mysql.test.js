import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {auditInventoryInlineMedia,applyInventoryInlineMedia,restoreInventoryInlineMedia} from '../src/services/inventory-inline-media-migration.js';
import {prepareInventoryInlineMedia} from '../src/services/database-inline-media.js';import {jsonArchiveHash} from '../src/services/private-json-archive.js';

test('inventory inline media migrates only the owned rows, verifies OSS before writing, and restores original bytes',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const f=await createTenantMysqlFixture('inline_store');
 try{
  const q=async(sql,p=[])=>(await f.connection.query(sql,p))[0],transaction=async work=>{await f.connection.beginTransaction();try{const r=await work(q);await f.connection.commit();return r;}catch(e){await f.connection.rollback();throw e;}};
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'two','A'),(3,'three','B')");
  const image='data:image/png;base64,'+Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64'),details=JSON.stringify([image]);
  for(const [id,tenant]of [[1,2],[2,3],[3,null]])await q('INSERT INTO products(id,tenant_id,name,image_url,detail_image_urls) VALUES(?,?,?,?,?)',[id,tenant,'Media',image,details]);
  const plan=await auditInventoryInlineMedia(q,{tenantId:'2'});assert.equal(plan.items.length,1);assert.equal(plan.items[0].id,1);
  assert.deepEqual((await auditInventoryInlineMedia(q,{tenantId:'admin'})).items.map(i=>i.id),[3]);
  const objects=new Map(),client={async head(key){if(!objects.has(key))throw Object.assign(Error('missing'),{status:404});},async put(key,value){objects.set(key,Buffer.from(value));},async getStream(key){return {stream:Readable.from([objects.get(key)])};}};
  const env={OSS_ENABLED:'true',OSS_REGION:'oss-cn-test',OSS_BUCKET:'test-bucket',OSS_ACCESS_KEY_ID:'key',OSS_ACCESS_KEY_SECRET:'secret'},backups=new Map();
  const archive=async(text,{namespace})=>{const ref={objectKey:`database-archives/${namespace}/${jsonArchiveHash(text)}.json.gz`,sha256:jsonArchiveHash(text)};backups.set(ref.objectKey,text);return ref;};
  await assert.rejects(applyInventoryInlineMedia({query:q,transaction,plan,prepare:async()=>{throw Error('OSS failed');},archive}),/OSS failed/);
  assert.equal((await q('SELECT image_url FROM products WHERE id=1'))[0].image_url,image);
  const report=await applyInventoryInlineMedia({query:q,transaction,plan,prepare:body=>prepareInventoryInlineMedia(body,{env,client}),archive});assert.equal(report.updated.length,1);
  assert.match((await q('SELECT image_url FROM products WHERE id=1'))[0].image_url,/^https:/);assert.equal((await q('SELECT image_url FROM products WHERE id=2'))[0].image_url,image);
  assert.equal((await restoreInventoryInlineMedia({query:q,transaction,report,read:r=>backups.get(r.objectKey)})).restored,1);
  const [restored]=await q('SELECT image_url,detail_image_urls FROM products WHERE id=1');assert.deepEqual(restored,{image_url:image,detail_image_urls:details});
  const again=await applyInventoryInlineMedia({query:q,transaction,plan,prepare:body=>prepareInventoryInlineMedia(body,{env,client}),archive});await q("UPDATE products SET image_url='https://example.com/new.png' WHERE id=1");
  await assert.rejects(restoreInventoryInlineMedia({query:q,transaction,report:again,read:r=>backups.get(r.objectKey)}),/edited since/);
  assert.equal((await applyInventoryInlineMedia({query:q,transaction,plan,prepare:body=>prepareInventoryInlineMedia(body,{env,client}),archive})).retained[0].reason,'source_changed');
 }finally{await f.cleanup();}
});

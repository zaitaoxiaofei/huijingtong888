// Administrator maintenance only. This module never imports application config.
import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { inspectUnchangedOutboundReference } from './reviewed-unique-index-repair.mjs';

export const REVIEWED_ONLINE_PAIRS = Object.freeze([
  ['243359','243397','5','5173097673'], ['243360','243398','5','5193464517'],
  ['243361','243399','6','5281757182'], ['243362','243408','4','5278755673'],
  ['243363','243556','5','5313171446'], ['243364','244418','5','5172189693'],
  ['244043','243366','4','5333877101'], ['244565','243368','5','5355572677']
].map(([remove_id,keep_id,shop_id,ozon_sku]) => Object.freeze({ remove_id,keep_id,shop_id,ozon_sku })));
const REFS = ['online_product_actions','outbound_records','ozon_stock_snapshots','product_barcode_label_cache','sku_inventory_recipes','sku_mappings'];
const REQUESTS = 'inventory_product_requests';
const JOURNAL = '_reviewed_online_cleanups';
const INDEX = 'uk_online_products_shop_sku';
const PROTECTED = [{table:'products',row_id:'504'}, {table:'outbound_records',row_id:'13777'}, {table:'product_barcode_label_cache',row_id:'243408'}];
const q = name => '`' + String(name).replaceAll('`','``') + '`';
const hash = value => createHash('sha256').update(value).digest('hex');
const run = async (db,text,args=[]) => (await db.query(text,args))[0];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function refuse(message) { throw Object.assign(new Error(message),{safe:true}); }
function id(value) { if (typeof value==='number' && !Number.isSafeInteger(value)) refuse('Precision-safe integer IDs required'); const text=String(value); if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text)>18446744073709551615n) refuse('Invalid positive ID'); return text; }
const names = repair => ({shadow:`_roc_${repair}_new_online`,archive:`_roc_${repair}_old_online`,undone:`_roc_${repair}_undo_online`});
const refName = (repair,kind,table) => `_roc_${repair}_${kind}_${table}`;
function checked(plan,apply=false) {
  if (plan?.version!==1 || plan?.mode!=='reviewed-online-eight' || !/^[a-f0-9]{12}$/.test(plan.repair_id||'')) refuse('Explicit reviewed-online-eight v1 plan and fresh repair ID required');
  if (!Array.isArray(plan.pairs) || plan.pairs.length!==8 || !same(plan.pairs.map(pair=>Object.fromEntries(['remove_id','keep_id','shop_id','ozon_sku'].map(key=>[key,id(pair[key])]))),REVIEWED_ONLINE_PAIRS)) refuse('Only the exact eight reviewed remove/keep identities are allowed');
  if (apply && (!plan.reviewed_by || !plan.reason || plan.maintenance_confirmed!==true || plan.production_approved!==true || plan.rollback_restores_nonunique_schema!==true || !plan.expected_snapshot)) refuse('Apply requires reviewed snapshot, approval, maintenance and NONUNIQUE rollback acknowledgements');
  if (apply && (!plan.unchanged_outbound_reference || String(plan.unchanged_outbound_reference.row_id)!=='13777')) refuse('Exact protected outbound preservation review required');
  return plan;
}
async function metadata(db,table,{writable=true,primaryNames=['id','online_product_id']}={}) {
  const [object]=await run(db,'SELECT ENGINE,AUTO_INCREMENT,DATA_LENGTH,INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
  if (object?.ENGINE!=='InnoDB') refuse(`Expected InnoDB table: ${table}`);
  const columns=await run(db,'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table]);
  if (writable && columns.some(c=>/(?:VIRTUAL|STORED) GENERATED|INVISIBLE/i.test(c.EXTRA))) refuse(`Generated/invisible writable columns: ${table}`);
  const indexes=await run(db,'SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,SUB_PART,EXPRESSION,IS_VISIBLE,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[table]);
  const primary=indexes.filter(i=>i.INDEX_NAME==='PRIMARY');
  if (primary.length!==1 || !primaryNames.includes(primary[0].COLUMN_NAME) || primary[0].SUB_PART!=null) refuse(`Unsupported primary key: ${table}`);
  if (writable) {
    const triggers=await run(db,'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?',[table]);
    const fks=await run(db,`SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND ((TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?) OR (REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=?))`,[table,table]);
    if (triggers.length || fks.length) refuse(`Triggers or foreign keys require separate review: ${table}`);
    const checks=await run(db,"SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK'",[table]);
    if(checks.length)refuse(`CHECK constraints require separate reviewed CREATE LIKE handling: ${table}`);
  }
  const [ddl]=await run(db,`SHOW CREATE TABLE ${q(table)}`);
  // information_schema AUTO_INCREMENT may be statistics-cached after INSERT or
  // ALTER. SHOW CREATE is the live counter used in the reviewed DDL proof.
  const create=ddl['Create Table'],counter=/\bAUTO_INCREMENT=(\d+)/.exec(create)?.[1]??(columns.some(c=>/auto_increment/i.test(c.EXTRA))?'1':null);
  return {table,columns,primary:primary[0].COLUMN_NAME,indexes,ddl:create,auto_increment:counter,storage_bytes:Number(object.DATA_LENGTH)+Number(object.INDEX_LENGTH)};
}
function rowHash(meta,exclude=[]) {
  const parts=meta.columns.filter(c=>!exclude.includes(c.COLUMN_NAME)).map(c=>`IF(${q(c.COLUMN_NAME)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${q(c.COLUMN_NAME)} AS BINARY)),':',HEX(CAST(${q(c.COLUMN_NAME)} AS BINARY))))`);
  return `SHA2(CONCAT(${parts.join(',')}),256)`;
}
async function rowsHash(db,meta,predicate='1',{exclude=[],lock=false}={}) {
  const h=createHash('sha256'); let last=null,count=0; const rows=[];
  while (true) {
    const page=await run(db,`SELECT ${q(meta.primary)} row_id,${rowHash(meta,exclude)} row_hash FROM ${q(meta.table)} FORCE INDEX(PRIMARY) WHERE (${predicate})${last==null?'':` AND ${q(meta.primary)}>?`} ORDER BY ${q(meta.primary)} LIMIT 1000${lock?' FOR SHARE':''}`,last==null?[]:[last]);
    for (const row of page) { const entry={id:String(row.row_id),sha256:row.row_hash}; h.update(`${entry.id}:${entry.sha256}\n`); rows.push(entry); last=entry.id; count++; }
    if (page.length<1000) break;
  }
  return {count,sha256:h.digest('hex'),...(predicate==='1'?{}:{rows})};
}
const ids = plan => plan.pairs.flatMap(p=>[id(p.remove_id),id(p.keep_id)]);
const predicate = values => `online_product_id IN (${values.join(',')})`;
const selectedRows = values => `id IN (${values.join(',')})`;
const proof = value => ({count:value.count,sha256:value.sha256});
function schema(ddl,{online=false}={}) {
  const text=ddl.replace(/^CREATE TABLE `[^`]+`/,'CREATE TABLE `<table>`').replace(/\bAUTO_INCREMENT=\d+\s*/g,'');
  const lines=(online?text.replace(`UNIQUE KEY \`${INDEX}\``,`KEY \`${INDEX}\``):text).split('\n').map(line=>line.trim().replace(/,$/,''));
  // DROP/ADD of the one reviewed key appends it after other indexes. Index
  // declaration ordering has no semantic effect; each exact definition remains.
  const indexes=lines.filter(line=>/^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY /.test(line)).sort();
  return [...lines.filter(line=>!/^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY /.test(line)),...indexes].join('\n');
}
async function schemaProof(db,table,expected,{online=false}={}) {
  const meta=await metadata(db,table);
  if(schema(meta.ddl,{online})!==schema(expected.ddl,{online})||meta.auto_increment!==expected.auto_increment)refuse(`Reviewed schema or counter changed: ${table}`);
  return meta;
}
function checkIndex(meta) {
  const key=meta.indexes.filter(i=>i.INDEX_NAME===INDEX);
  if (key.length!==2 || key.map(i=>i.COLUMN_NAME).join(',')!=='shop_id,ozon_sku' || key.some(i=>i.SUB_PART!=null || i.EXPRESSION!=null || i.IS_VISIBLE!=='YES' || i.INDEX_TYPE!=='BTREE')) refuse('Unexpected online natural-key definition');
  return key.every(i=>Number(i.NON_UNIQUE)===0);
}
async function ownerEvidence(db,plan,online,refs,{lock=false}={}) {
  const tail=lock?' FOR SHARE':'';
  const tenants=await run(db,`SELECT id FROM tenants WHERE slug='default'${tail}`),tenant=tenants[0];
  if (tenants.length!==1) refuse('Exactly one actual default enterprise required');
  const tenantId=id(tenant.id), effective=value=>value==null||value==='admin'?tenantId:id(value);
  const evidence=[];
  const shop=async value=>{const [row]=await run(db,`SELECT * FROM shops FORCE INDEX(PRIMARY) WHERE id=?${tail}`,[id(value)]); if (!row || effective(row.tenant_id)!==tenantId) refuse('Shop crosses default enterprise'); evidence.push({table:'shops',id:id(value),value:row});return row;};
  const product=async value=>{if(value==null||String(value)==='0')return;const [row]=await run(db,`SELECT * FROM products FORCE INDEX(PRIMARY) WHERE id=?${tail}`,[id(value)]);if(!row||effective(row.tenant_id)!==tenantId)refuse('Product crosses enterprises');evidence.push({table:'products',id:id(value),value:row});};
  for (const row of online) { await shop(row.shop_id); if ('tenant_id' in row && effective(row.tenant_id)!==tenantId)refuse('Online enterprise mismatch');await product(row.product_id); }
  const byId=new Map(online.map(row=>[String(row.id),row]));
  for (const ref of refs) for (const row of ref.rows) {
    const source=byId.get(String(row.online_product_id)); if(!source||String(row.shop_id)!==String(source.shop_id))refuse('Reference crosses shops');
    if('tenant_id' in row&&effective(row.tenant_id)!==tenantId)refuse('Reference crosses enterprises');await product(row.product_id);
    if(row.order_item_id) {
      const [item]=await run(db,`SELECT * FROM order_items FORCE INDEX(PRIMARY) WHERE id=?${tail}`,[id(row.order_item_id)]);
      const [order]=item?await run(db,`SELECT * FROM orders FORCE INDEX(PRIMARY) WHERE id=?${tail}`,[id(item.order_id)]):[];
      if(!order)refuse('Reference order parent missing'); await shop(order.shop_id);
      if(('tenant_id' in item&&effective(item.tenant_id)!==tenantId)||('shop_id' in item&&String(item.shop_id)!==String(order.shop_id)))refuse('Order item ownership disagrees with parent');
      evidence.push({table:'order_items',id:id(item.id),value:item},{table:'orders',id:id(order.id),value:order});
      if(String(order.shop_id)!==String(source.shop_id) && !(ref.table==='outbound_records'&&String(row.id)==='13777'&&plan.unchanged_outbound_reference))refuse('Reference order parent shop mismatch');
      if('tenant_id' in order&&effective(order.tenant_id)!==tenantId)refuse('Order parent crosses enterprises');
    }
  }
  if(plan.unchanged_outbound_reference) await inspectUnchangedOutboundReference(db,{version:1,repair_id:plan.repair_id,tables:[{table:'online_products',groups:plan.pairs.map(p=>({row_ids:[p.remove_id,p.keep_id],keeper_id:p.keep_id}))}],unchanged_outbound_reference:plan.unchanged_outbound_reference},{lock});
  // Native parent hashes, not client JSON/date conversions, form the approval proof.
  const unique=[...new Map(evidence.map(e=>[`${e.table}:${e.id}`,e])).values()].sort((a,b)=>`${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const result=[];
  for(const entry of unique) result.push({table:entry.table,id:entry.id,...proof(await rowsHash(db,await metadata(db,entry.table,{writable:false}),`id=${entry.id}`,{lock}))});
  return {default_tenant_id:tenantId,rows:result};
}
async function knownReferences(db,plan) {
  const artifacts=new Set(Object.values(names(plan.repair_id)));
  for(const table of REFS)for(const kind of ['before','after'])artifacts.add(refName(plan.repair_id,kind,table));
  const unknown=await run(db,"SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='online_product_id'");
  if(unknown.some(row=>!REFS.includes(row.TABLE_NAME)&&!artifacts.has(row.TABLE_NAME)))refuse('Unknown typed online reference requires review');
}
export async function inspectReviewedOnlineCleanup(db,input,{lock=false}={}) {
  const plan=checked(input), allIds=ids(plan);await knownReferences(db,plan);
  const source=await metadata(db,'online_products');checkIndex(source);
  const online=await run(db,`SELECT * FROM online_products FORCE INDEX(PRIMARY) WHERE ${selectedRows(allIds)} ORDER BY id${lock?' FOR SHARE':''}`);
  if(online.length!==16)refuse('Exactly sixteen reviewed online rows must exist');
  for(const pair of plan.pairs)for(const key of ['remove_id','keep_id']) {const row=online.find(r=>String(r.id)===String(pair[key])); if(String(row.shop_id)!==String(pair.shop_id)||String(row.ozon_sku)!==String(pair.ozon_sku))refuse('Reviewed natural identity changed');}
  const refs=[],referenceRows=[];
  for(const table of REFS) {
    const meta=await metadata(db,table);
    const values=await run(db,`SELECT * FROM ${q(table)} FORCE INDEX(PRIMARY) WHERE ${predicate(allIds)} ORDER BY ${q(meta.primary)}${lock?' FOR UPDATE':''}`);
    referenceRows.push({table,rows:values});
    const changed=values.filter(row=>plan.pairs.some(pair=>pair.remove_id===String(row.online_product_id))).map(row=>String(row[meta.primary]));
    if(['product_barcode_label_cache','sku_inventory_recipes'].includes(table)&&changed.length)refuse('New cache/recipe loser references require separate review');
    const scope=changed.length?`${q(meta.primary)} IN (${changed.join(',')})`:'0';
    refs.push({table,ddl:meta.ddl,auto_increment:meta.auto_increment,all:await rowsHash(db,meta,predicate(allIds),{lock}),changed:await rowsHash(db,meta,scope,{lock}),unchanged_columns:await rowsHash(db,meta,scope,{exclude:['online_product_id'],lock})});
  }
  const request=await metadata(db,REQUESTS);
  const requestPredicate=`IF(JSON_VALID(payload_json),JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.online_product_id')),NULL) IN (${allIds.map(v=>`'${v}'`).join(',')})`;
  const requests=await rowsHash(db,request,requestPredicate,{lock});
  if(requests.count)refuse('New active request JSON references require separate review');
  const protectedRows=[];
  for(const p of PROTECTED){const meta=await metadata(db,p.table,{writable:p.table!=='products'});const d=await rowsHash(db,meta,`${q(meta.primary)}=${p.row_id}`,{lock});if(d.count!==1)refuse('Protected original row missing');protectedRows.push({...p,...d});}
  const snapshot={source:{ddl:source.ddl,auto_increment:source.auto_increment,...proof(await rowsHash(db,source,'1',{lock}))},reviewed_rows:await rowsHash(db,source,selectedRows(allIds),{lock}),references:refs,requests:{table:REQUESTS,ddl:request.ddl,...requests},protected_rows:protectedRows,owners:await ownerEvidence(db,plan,online,referenceRows,{lock})};
  return {mode:plan.mode,repair_id:plan.repair_id,changes_database:false,snapshot,storage_bytes:source.storage_bytes,snapshot_sha256:hash(JSON.stringify(snapshot))};
}
async function capacity(db) {
  const [server]=await run(db,'SELECT @@datadir datadir');const space=await statfs(server.datadir,{bigint:true});
  const [table]=await run(db,"SELECT DATA_LENGTH+INDEX_LENGTH bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='online_products'");
  // Online-only: strict copy + archive/index/redo margin + 1 GiB operating reserve.
  const required=BigInt(table.bytes)*4n+1024n**3n,available=space.bavail*space.bsize;
  if(available<required)refuse('Insufficient online-only maintenance capacity');
  return {available_bytes:String(available),required_bytes:String(required),online_allocated_estimate:String(table.bytes)};
}
async function repairLock(db,database,operation) {
  const [s]=await run(db,'SELECT DATABASE() db,@@SESSION.unique_checks checks,@@SESSION.foreign_key_checks fk_checks,@@event_scheduler scheduler');
  if(!database||s.db!==database||Number(s.checks)!==1||Number(s.fk_checks)!==1)refuse('Explicit database, unique_checks=1 and foreign_key_checks=1 required');
  if(String(s.scheduler).toUpperCase()==='ON')refuse('Event scheduler must be disabled during maintenance');
  await run(db,'SET SESSION lock_wait_timeout=5');await run(db,'SET SESSION innodb_lock_wait_timeout=5');
  const name=`unique_repair:${hash(database).slice(0,40)}`;const [r]=await run(db,'SELECT GET_LOCK(?,0) acquired',[name]);if(Number(r.acquired)!==1)refuse('Another repair holds database lock');
  try{return await operation();}finally{await run(db,'SELECT RELEASE_LOCK(?)',[name]);}
}
async function save(db,state) {await run(db,`UPDATE ${q(JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`,[state.phase,JSON.stringify(state),state.repair_id]);}
async function nonunique(db,table) {const meta=await metadata(db,table);if(checkIndex(meta))await run(db,`ALTER TABLE ${q(table)} DROP INDEX ${q(INDEX)},ADD KEY ${q(INDEX)} (shop_id,ozon_sku),ALGORITHM=INPLACE,LOCK=EXCLUSIVE`);}
async function protectedProof(db,snapshot) {for(const p of snapshot.protected_rows){const meta=await metadata(db,p.table,{writable:p.table!=='products'});if(!same(await rowsHash(db,meta,`${q(meta.primary)}=${p.row_id}`),{count:p.count,sha256:p.sha256,rows:p.rows}))refuse('Protected original row changed');}}
export async function applyReviewedOnlineCleanup(db,input,database) {
  const plan=checked(input,true);
  return repairLock(db,database,async()=>{
    const report=await inspectReviewedOnlineCleanup(db,plan);if(!same(report.snapshot,plan.expected_snapshot))refuse('Reviewed native snapshot, references or schema changed');
    const budget=await capacity(db);
    await run(db,`CREATE TABLE IF NOT EXISTS ${q(JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    const journalMeta=await metadata(db,JOURNAL,{primaryNames:['repair_id']});
    if(journalMeta.columns.map(c=>c.COLUMN_NAME).join(',')!=='repair_id,phase,state_json,created_at'||journalMeta.indexes.length!==1)refuse('Unexpected dedicated cleanup journal schema');
    if((await run(db,`SELECT repair_id FROM ${q(JOURNAL)} WHERE repair_id=?`,[plan.repair_id])).length)refuse('Existing repair ID: inspect matching journal; never reapply');
    const state={mode:plan.mode,version:1,repair_id:plan.repair_id,database,phase:'preparing',plan,budget,...names(plan.repair_id),references:[]};
    await run(db,`INSERT INTO ${q(JOURNAL)} (repair_id,phase,state_json) VALUES(?,?,?)`,[state.repair_id,state.phase,JSON.stringify(state)]);
    const meta=await metadata(db,'online_products');
    await run(db,`CREATE TABLE ${q(state.shadow)} LIKE online_products`);
    if(!checkIndex(await metadata(db,state.shadow)))await run(db,`ALTER TABLE ${q(state.shadow)} DROP INDEX ${q(INDEX)},ADD UNIQUE KEY ${q(INDEX)} (shop_id,ozon_sku)`);
    const losers=plan.pairs.map(p=>p.remove_id),columns=meta.columns.map(c=>q(c.COLUMN_NAME)).join(',');
    await run(db,`INSERT INTO ${q(state.shadow)} (${columns}) SELECT ${columns} FROM online_products FORCE INDEX(PRIMARY) WHERE id NOT IN (${losers.join(',')}) ORDER BY id`);
    if(meta.auto_increment)await run(db,`ALTER TABLE ${q(state.shadow)} AUTO_INCREMENT=${id(meta.auto_increment)}`);
    await schemaProof(db,state.shadow,report.snapshot.source,{online:true});
    state.after=proof(await rowsHash(db,await metadata(db,state.shadow)));
    const retained=proof(await rowsHash(db,meta,`id NOT IN (${losers.join(',')})`));
    if(!same(retained,state.after)||state.after.count+8!==report.snapshot.source.count)refuse('Strict shadow retained native copy mismatch');await save(db,state);
    for(const ref of report.snapshot.references.filter(ref=>ref.changed.count)) {
      const entry={table:ref.table,before:refName(plan.repair_id,'before',ref.table),after:refName(plan.repair_id,'after',ref.table),ids:ref.changed.rows.map(r=>r.id),before_digest:ref.changed,all_before:ref.all,unchanged_columns:ref.unchanged_columns};state.references.push(entry);await save(db,state);
      await run(db,`CREATE TABLE ${q(entry.before)} LIKE ${q(ref.table)}`);await run(db,`CREATE TABLE ${q(entry.after)} LIKE ${q(ref.table)}`);
    }
    await db.beginTransaction();
    try {
      const fresh=await inspectReviewedOnlineCleanup(db,plan,{lock:true});if(!same(fresh.snapshot,report.snapshot))refuse('Source/owner/reference changed during strict preparation');
      for(const ref of state.references){const rm=await metadata(db,ref.table),scope=`${q(rm.primary)} IN (${ref.ids.join(',')})`;
        await run(db,`INSERT INTO ${q(ref.before)} SELECT * FROM ${q(ref.table)} FORCE INDEX(PRIMARY) WHERE ${scope}`);
        const timestamps=rm.columns.filter(c=>/on update/i.test(c.EXTRA)).map(c=>`,${q(c.COLUMN_NAME)}=${q(c.COLUMN_NAME)}`).join('');
        for(const pair of plan.pairs)await run(db,`UPDATE ${q(ref.table)} FORCE INDEX(PRIMARY) SET online_product_id=?${timestamps} WHERE ${scope} AND online_product_id=?`,[pair.keep_id,pair.remove_id]);
        if(!same(await rowsHash(db,rm,scope,{exclude:['online_product_id']}),ref.unchanged_columns))refuse('Reference non-ID fields changed');
        await run(db,`INSERT INTO ${q(ref.after)} SELECT * FROM ${q(ref.table)} FORCE INDEX(PRIMARY) WHERE ${scope}`);
        ref.after_digest=await rowsHash(db,rm,scope);ref.all_after=await rowsHash(db,rm,predicate(ids(plan)));
        if(!same(proof(await rowsHash(db,await metadata(db,ref.before))),proof(ref.before_digest))||!same(proof(await rowsHash(db,await metadata(db,ref.after))),proof(ref.after_digest)))refuse('Native reference archive mismatch');
      }
      await protectedProof(db,report.snapshot);state.phase='references_applied';await save(db,state);await db.commit();
    }catch(error){await db.rollback();throw error;}
    if(!same(proof(await rowsHash(db,await metadata(db,'online_products'))),proof(report.snapshot.source)))refuse('Whole original source changed before swap');
    await nonunique(db,'online_products');
    if(!same(proof(await rowsHash(db,await metadata(db,'online_products'))),proof(report.snapshot.source)))refuse('Original bytes changed during index conversion');
    state.phase='swap_pending';await save(db,state);
    await run(db,`RENAME TABLE online_products TO ${q(state.archive)},${q(state.shadow)} TO online_products`);
    if(!same(proof(await rowsHash(db,await schemaProof(db,'online_products',report.snapshot.source,{online:true}))),state.after)||!same(proof(await rowsHash(db,await schemaProof(db,state.archive,report.snapshot.source,{online:true}))),proof(report.snapshot.source))||!checkIndex(await metadata(db,'online_products')))refuse('Post-rename strict/native verification failed');
    await protectedProof(db,report.snapshot);state.phase='applied';await save(db,state);
    return {repair_id:state.repair_id,phase:state.phase,removed_online_rows:8,original_rows_preserved:report.snapshot.source.count,canonical_rows:state.after.count,references:state.references.map(r=>({table:r.table,changed:r.ids.length})),protected_rows_unchanged:true,budget};
  });
}
export async function inspectOnlineCleanupJournal(db,repairId) {
  if(!/^[a-f0-9]{12}$/.test(repairId||''))refuse('Invalid repair ID');
  const [row]=await run(db,`SELECT phase,state_json FROM ${q(JOURNAL)} WHERE repair_id=?`,[repairId]);if(!row)refuse('Matching online cleanup journal missing');
  const state=typeof row.state_json==='string'?JSON.parse(row.state_json):row.state_json;
  if(state.mode!=='reviewed-online-eight'||state.phase!==row.phase)refuse('Journal mode/phase mismatch');return state;
}
export async function rollbackReviewedOnlineCleanup(db,repairId,database,maintenanceConfirmed=false) {
  if(maintenanceConfirmed!==true)refuse('Rollback requires confirmed maintenance');
  return repairLock(db,database,async()=>{
    const state=await inspectOnlineCleanupJournal(db,repairId);checked(state.plan,true);
    await knownReferences(db,state.plan);
    if(state.database!==database||state.repair_id!==repairId||state.phase==='rolled_back'||!same(Object.fromEntries(Object.keys(names(repairId)).map(k=>[k,state[k]])),names(repairId)))refuse('Journal database/artifact/phase mismatch');
    const exists=async table=>(await run(db,'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table])).length===1;
    const swapped=await exists(state.archive),reverseDone=await exists(state.undone),snapshot=state.plan.expected_snapshot;
    const current=proof(await rowsHash(db,await schemaProof(db,'online_products',snapshot.source,{online:true})));
    if(!same(current,swapped?state.after:proof(snapshot.source)))refuse('Current online rows changed; rollback refused');
    if(swapped&&!same(proof(await rowsHash(db,await schemaProof(db,state.archive,snapshot.source,{online:true}))),proof(snapshot.source)))refuse('Original archive changed; rollback refused');
    if(reverseDone&&!same(proof(await rowsHash(db,await metadata(db,state.undone))),state.after))refuse('Undone strict archive changed');
    const applied=['references_applied','swap_pending','applied','rollback_swap_pending'].includes(state.phase);
    for(const ref of snapshot.references) {
      const changed=state.references.find(r=>r.table===ref.table),meta=await schemaProof(db,ref.table,ref);
      const expected=applied&&changed?changed.all_after:ref.all;
      if(!same(await rowsHash(db,meta,predicate(ids(state.plan))),expected))refuse('Reference rows or new references changed; rollback refused');
      if(applied&&changed){if(changed.before!==refName(repairId,'before',ref.table)||changed.after!==refName(repairId,'after',ref.table))refuse('Invalid native reference archive identity');
        if(schema((await metadata(db,changed.before)).ddl)!==schema(ref.ddl)||schema((await metadata(db,changed.after)).ddl)!==schema(ref.ddl)||!same(proof(await rowsHash(db,await metadata(db,changed.before))),proof(changed.before_digest))||!same(proof(await rowsHash(db,await metadata(db,changed.after))),proof(changed.after_digest)))refuse('Native reference archive changed');}
    }
    const requestMeta=await metadata(db,REQUESTS),requestPredicate=`IF(JSON_VALID(payload_json),JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.online_product_id')),NULL) IN (${ids(state.plan).map(v=>`'${v}'`).join(',')})`;
    if(schema(requestMeta.ddl)!==schema(snapshot.requests.ddl)||(await rowsHash(db,requestMeta,requestPredicate)).count)refuse('New active request reference or schema changed; rollback refused');
    await protectedProof(db,snapshot);await nonunique(db,swapped?state.archive:'online_products');
    if(swapped){state.phase='rollback_swap_pending';await save(db,state);await run(db,`RENAME TABLE online_products TO ${q(state.undone)},${q(state.archive)} TO online_products`);}
    await db.beginTransaction();
    try {
      if(applied)for(const ref of state.references){const meta=await metadata(db,ref.table),columns=meta.columns.map(c=>c.COLUMN_NAME),assign=columns.filter(c=>c!==meta.primary).map(c=>`a.${q(c)}=b.${q(c)}`).join(',');
        await run(db,`UPDATE ${q(ref.table)} a JOIN ${q(ref.before)} b ON a.${q(meta.primary)}=b.${q(meta.primary)} SET ${assign}`);
        if(!same(await rowsHash(db,meta,predicate(ids(state.plan))),ref.all_before))refuse('Reference restoration mismatch');}
      await protectedProof(db,snapshot);state.phase='rolled_back';await save(db,state);await db.commit();
    }catch(error){await db.rollback();throw error;}
    return {repair_id:repairId,phase:state.phase,original_data_restored:true,schema_exact:false,warning:'Original duplicate data restored with NONUNIQUE key; business writers must remain stopped'};
  });
}

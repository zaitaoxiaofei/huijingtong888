// Pure administrator maintenance library; no standalone database-writing CLI.
const SPEC={order_status_history:{fields:['order_id'],natural:'uk_order_status_history_hour_state'},online_products:{fields:['ozon_product_id','product_id'],natural:'uk_online_products_shop_sku'},outbound_records:{fields:['order_item_id']}};
const JOURNAL='_reviewed_legacy_link_repairs';
const q=v=>'`'+String(v).replaceAll('`','``')+'`';
const id=v=>{if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('IDs outside safe JSON integer precision must be strings');
const s=String(v);
if(!/^[1-9][0-9]{0,19}$/.test(s)||BigInt(s)>18446744073709551615n)throw Error('Invalid explicit ID');
return s;
};
const eq=(a,b)=>a==null?b==null:String(a)===String(b);
const chunks=(a,n=300)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,i*n+n));
function validate(plan){if(plan.version!==1||!/^[a-f0-9]{12}$/.test(plan.repair_id||'')||!plan.reviewed_by||!plan.reason||plan.maintenance_confirmed!==true||!Array.isArray(plan.changes)||!plan.changes.length)throw Error('Explicit reviewed maintenance plan required');
const seen=new Set();
for(const r of plan.changes){if(!SPEC[r.table]||!r.fields||!Object.keys(r.fields).length||Object.keys(r.fields).some(f=>!SPEC[r.table].fields.includes(f))||!/^[a-f0-9]{64}$/.test(r.expected_full_row_sha256||''))throw Error('Unsupported correction or missing full-row fingerprint');
r.id=id(r.id);
const k=`${r.table}:${r.id}`;
if(seen.has(k))throw Error('Repeated correction row');
seen.add(k);
for(const v of Object.values(r.fields)){if(!Object.hasOwn(v,'before')||!Object.hasOwn(v,'after'))throw Error('Before and after values required');
v.after=id(v.after);
}if(r.table==='online_products'&&r.fields.ozon_product_id&&!/^[a-f0-9]{64}$/.test(r.official_evidence_sha256||''))throw Error('Official evidence fingerprint required');
if(r.table==='online_products'&&r.fields.product_id&&!String(r.user_confirmation_reference||'').trim())throw Error('Explicit user business decision reference required');
}return plan;
}
async function meta(c,t){const [cols]=await c.query('SELECT COLUMN_NAME,EXTRA FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position',[t]);
if(!cols.length||cols.some(r=>/(?:VIRTUAL|STORED) GENERATED|INVISIBLE/.test(r.EXTRA)))throw Error('Unsupported table metadata');
const [triggers]=await c.query('SELECT TRIGGER_NAME FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table=?',[t]);
if(triggers.length)throw Error('Triggers require separate review');
const [keys]=await c.query('SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[t]);
const [ddl]=await c.query(`SHOW CREATE TABLE ${q(t)}`);
return{table:t,columns:cols.map(r=>r.COLUMN_NAME),keys,ddl:ddl[0]['Create Table']};
}
function rowHash(m,a='r'){return'SHA2(CONCAT('+m.columns.map(n=>`IF(${a}.${q(n)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${a}.${q(n)} AS BINARY)),':',HEX(CAST(${a}.${q(n)} AS BINARY))))`).join(',')+'),256)';
}
async function rows(c,m,ids,lock=false){const found=[];
for(const batch of chunks(ids)){const [r]=await c.query(`SELECT r.*,${rowHash(m)} full_hash FROM ${q(m.table)} r FORCE INDEX(PRIMARY) WHERE r.id IN (${batch.map(id).join(',')}) ORDER BY r.id${lock?' FOR UPDATE':''}`);
found.push(...r);
}return found;
}
async function guardContext(c,changes){const [shops]=await c.query('SELECT id,tenant_id,status FROM shops FORCE INDEX(PRIMARY) FOR SHARE');
const [defaults]=await c.query("SELECT id FROM tenants WHERE slug='default' FOR SHARE");
if(defaults.length!==1)throw Error('Default enterprise ambiguous');
const ctx={shops:new Map(shops.map(r=>[String(r.id),r])),defaultId:String(defaults[0].id),orders:new Map(),items:new Map()};
const add=(map,key,row)=>{if(!map.has(key))map.set(key,[]);
map.get(key).push(row);
};
if(changes.some(r=>r.table==='order_status_history'||r.table==='outbound_records')){const [orders]=await c.query('SELECT id,shop_id,posting_number FROM orders FORCE INDEX(PRIMARY) FOR SHARE');
for(const r of orders)add(ctx.orders,JSON.stringify([String(r.shop_id),String(r.posting_number)]),r);
if(changes.some(r=>r.table==='outbound_records')){const byId=new Map(orders.map(r=>[String(r.id),r]));
const [items]=await c.query('SELECT id,order_id,ozon_sku,quantity FROM order_items FORCE INDEX(PRIMARY) FOR SHARE');
for(const r of items){const parent=byId.get(String(r.order_id));
if(parent)add(ctx.items,JSON.stringify([String(parent.shop_id),String(parent.posting_number),String(r.ozon_sku),String(r.quantity)]),r);
}}}return ctx;
}
async function targetGuard(c,r,current,ctx){if(String(current.shop_id)!==String(r.original_shop_id))throw Error('Original shop changed');
const shop=ctx.shops.get(String(current.shop_id));
if(!shop||shop.status==='deleted'||r.expected_tenant_id==null)throw Error('Explicit current original enterprise required');
const effective=v=>v==null||v==='admin'?ctx.defaultId:String(v);
if(effective(shop.tenant_id)!==String(r.expected_tenant_id))throw Error('Reviewed shop enterprise changed');
if(r.table==='order_status_history'){const p=ctx.orders.get(JSON.stringify([String(current.shop_id),String(current.posting_number)]))||[];
if(p.length!==1||!eq(p[0].id,r.fields.order_id.after))throw Error('History exact original shop/posting candidate is missing or ambiguous');
}
 if(r.table==='outbound_records'){const p=ctx.items.get(JSON.stringify([String(current.shop_id),String(current.order_ref),String(current.ozon_sku),String(current.quantity)]))||[];
if(p.length!==1||!eq(p[0].id,r.fields.order_item_id.after))throw Error('Outbound exact original shop/posting/SKU/quantity candidate is missing or ambiguous');
}
 if(r.table==='online_products'&&r.fields.product_id){const [p]=await c.query('SELECT p.id,p.tenant_id,s.tenant_id shop_tenant,p.active FROM products p JOIN shops s ON s.id=? WHERE p.id=? FOR SHARE',[current.shop_id,r.fields.product_id.after]);
if(p.length!==1||Number(p[0].active)!==1)throw Error('Target inventory product missing/inactive');
const [d]=await c.query("SELECT id FROM tenants WHERE slug='default'");
if(d.length!==1)throw Error('Default enterprise ambiguous');
const tenant=v=>v==null||v==='admin'?String(d[0].id):String(v);
if(tenant(p[0].tenant_id)!==tenant(p[0].shop_tenant))throw Error('Target inventory product crosses enterprise');
}}
async function archiveTable(c,name,m){await c.query(`CREATE TABLE ${q(name)} LIKE ${q(m.table)}`);
const known=SPEC[m.table].natural;
if(known&&m.keys.some(k=>k.INDEX_NAME===known&&Number(k.NON_UNIQUE)===0)){const columns=m.keys.filter(k=>k.INDEX_NAME===known).map(k=>q(k.COLUMN_NAME)).join(',');
await c.query(`ALTER TABLE ${q(name)} DROP INDEX ${q(known)},ADD KEY ${q(known)} (${columns})`);
}}
async function lock(c,database,fn){const [[s]]=await c.query('SELECT DATABASE() db,@@session.unique_checks unique_checks');
if(s.db!==database||Number(s.unique_checks)!==1)throw Error('Explicit database/strict unique checks mismatch');
const name='legacy-links:'+database;
const [[l]]=await c.query('SELECT GET_LOCK(?,0) acquired',[name]);
if(Number(l.acquired)!==1)throw Error('Another link repair holds the lock');
try{return await fn();
}finally{await c.query('SELECT RELEASE_LOCK(?)',[name]);
}}
export async function inspect(c,plan,database){validate(plan);
const [[s]]=await c.query('SELECT DATABASE() db');
if(s.db!==database)throw Error('Database mismatch');
const ctx=await guardContext(c,plan.changes);
const report={repair_id:plan.repair_id,changes_database:false,tables:[]};
for(const table of [...new Set(plan.changes.map(r=>r.table))]){const m=await meta(c,table);
if(table==='order_status_history'&&m.keys.some(k=>k.INDEX_NAME===SPEC[table].natural&&Number(k.NON_UNIQUE)===0))throw Error('History correction is allowed only on an explicit NONUNIQUE staging table; build and review a strict final shadow instead of updating the original UNIQUE');
const changes=plan.changes.filter(r=>r.table===table),current=await rows(c,m,changes.map(r=>r.id));
if(current.length!==changes.length)throw Error('A reviewed row is missing');
for(const r of changes){const row=current.find(x=>String(x.id)===r.id);
if(row.full_hash!==r.expected_full_row_sha256)throw Error('Reviewed full row changed');
for(const [f,v]of Object.entries(r.fields))if(!eq(row[f],v.before))throw Error('Reviewed before value changed');
await targetGuard(c,r,row,ctx);
}report.tables.push({table,rows:changes.length,changed_fields:[...new Set(changes.flatMap(r=>Object.keys(r.fields)))]});
}return report;
}
export async function apply(c,plan,database){validate(plan);
return lock(c,database,async()=>{await inspect(c,plan,database);
await c.query(`CREATE TABLE IF NOT EXISTS ${q(JOURNAL)} (repair_id CHAR(12) PRIMARY KEY,phase VARCHAR(32) NOT NULL,state_json LONGTEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
const [old]=await c.query(`SELECT repair_id FROM ${q(JOURNAL)} WHERE repair_id=?`,[plan.repair_id]);
if(old.length)throw Error('Repair ID already exists; inspect/undo instead');
const state={version:1,database,repair_id:plan.repair_id,phase:'preparing',plan,tables:[]};
await c.query(`INSERT INTO ${q(JOURNAL)} VALUES (?,?,?,CURRENT_TIMESTAMP)`,[plan.repair_id,state.phase,JSON.stringify(state)]);
 for(const table of [...new Set(plan.changes.map(r=>r.table))]){const m=await meta(c,table),entry={...m,before:`_uir_${plan.repair_id}_before_${table}`,after:`_uir_${plan.repair_id}_after_${table}`,ids:plan.changes.filter(r=>r.table===table).map(r=>r.id)};
await archiveTable(c,entry.before,m);
await archiveTable(c,entry.after,m);
state.tables.push(entry);
await c.query(`UPDATE ${q(JOURNAL)} SET state_json=? WHERE repair_id=?`,[JSON.stringify(state),plan.repair_id]);
}
 await c.beginTransaction();
try{const ctx=await guardContext(c,plan.changes);
for(const m of state.tables){const current=await rows(c,m,m.ids,true);
for(const r of plan.changes.filter(r=>r.table===m.table)){const row=current.find(x=>String(x.id)===r.id);
if(row?.full_hash!==r.expected_full_row_sha256)throw Error('Row changed during maintenance preparation');
await targetGuard(c,r,row,ctx);
}for(const batch of chunks(m.ids))await c.query(`INSERT INTO ${q(m.before)} SELECT * FROM ${q(m.table)} FORCE INDEX(PRIMARY) WHERE id IN (${batch.join(',')})`);
for(const r of plan.changes.filter(r=>r.table===m.table)){const fields=Object.keys(r.fields),keep=m.columns.includes('updated_at')?',updated_at=updated_at':'';
const [changed]=await c.query(`UPDATE ${q(m.table)} r SET ${fields.map(f=>q(f)+'=?').join(',')}${keep} WHERE id=? AND ${rowHash(m)}=?`,[...fields.map(f=>r.fields[f].after),r.id,r.expected_full_row_sha256]);
if(Number(changed.affectedRows)!==1)throw Error('Correction affected count mismatch');
}for(const batch of chunks(m.ids))await c.query(`INSERT INTO ${q(m.after)} SELECT * FROM ${q(m.table)} FORCE INDEX(PRIMARY) WHERE id IN (${batch.join(',')})`);
m.before_hashes=Object.fromEntries((await rows(c,{...m,table:m.before},m.ids)).map(r=>[String(r.id),r.full_hash]));
m.after_hashes=Object.fromEntries((await rows(c,m,m.ids)).map(r=>[String(r.id),r.full_hash]));
}state.phase='applied';
await c.query(`UPDATE ${q(JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`,[state.phase,JSON.stringify(state),plan.repair_id]);
await c.commit();
return{repair_id:plan.repair_id,phase:state.phase,tables:state.tables.map(t=>({table:t.table,changed_rows:t.ids.length,before:t.before,after:t.after}))};
}catch(e){await c.rollback();
throw e;
}});
}
export async function undo(c,repairId,database,maintenanceConfirmed){if(!maintenanceConfirmed||!/^[a-f0-9]{12}$/.test(repairId))throw Error('Explicit maintenance and repair ID required');
return lock(c,database,async()=>{const [[j]]=await c.query(`SELECT phase,state_json FROM ${q(JOURNAL)} WHERE repair_id=?`,[repairId]);
if(!j||j.phase!=='applied')throw Error('Applied link repair journal required');
const state=JSON.parse(j.state_json);
validate(state.plan);
if(state.database!==database)throw Error('Journal database mismatch');
await c.beginTransaction();
try{for(const m of state.tables){if(m.before!==`_uir_${repairId}_before_${m.table}`||m.after!==`_uir_${repairId}_after_${m.table}`)throw Error('Archive identity mismatch');
const current=await rows(c,m,m.ids,true),before=await rows(c,{...m,table:m.before},m.ids),after=await rows(c,{...m,table:m.after},m.ids);
for(const [data,expected]of [[current,m.after_hashes],[before,m.before_hashes],[after,m.after_hashes]])if(data.length!==m.ids.length||data.some(r=>r.full_hash!==expected[String(r.id)]))throw Error('Current or complete archive row changed; undo refused');
for(const r of state.plan.changes.filter(r=>r.table===m.table)){const keep=m.columns.includes('updated_at')?',r.updated_at=r.updated_at':'';
await c.query(`UPDATE ${q(m.table)} r JOIN ${q(m.before)} b ON b.id=r.id SET ${Object.keys(r.fields).map(f=>`r.${q(f)}=b.${q(f)}`).join(',')}${keep} WHERE r.id=?`,[r.id]);
}const restored=await rows(c,m,m.ids);
if(restored.some(r=>r.full_hash!==m.before_hashes[String(r.id)]))throw Error('Full native row undo mismatch');
}state.phase='rolled_back';
await c.query(`UPDATE ${q(JOURNAL)} SET phase=?,state_json=? WHERE repair_id=?`,[state.phase,JSON.stringify(state),repairId]);
await c.commit();
return{repair_id:repairId,phase:'rolled_back',all_changed_rows_full_field_match:true};
}catch(e){await c.rollback();
throw e;
}});
}

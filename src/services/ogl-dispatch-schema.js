// All new workflow rows have explicit enterprise ownership, including defaults.
export const OGL_DISPATCH_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_settings (
    tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, default_shop_id BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_batches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_number VARCHAR(64) NOT NULL, client_request_id VARCHAR(128) NOT NULL,
    default_shop_id BIGINT UNSIGNED NOT NULL, containers_count INT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'preparing', note VARCHAR(1000) NOT NULL DEFAULT '',
    delivery_method_id VARCHAR(64) NULL, departure_date VARCHAR(64) NULL,
    official_carriage_id VARCHAR(64) NULL, official_status VARCHAR(32) NOT NULL DEFAULT 'not_created',
    official_result_json JSON NULL, official_operation_token VARCHAR(64) NULL,
    official_error VARCHAR(2000) NULL, last_refreshed_at DATETIME NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ogl_batch_request (tenant_id, client_request_id),
    UNIQUE KEY uk_ogl_batch_number (tenant_id, batch_number),
    UNIQUE KEY uk_ogl_official (tenant_id, default_shop_id, official_carriage_id),
    KEY idx_ogl_batch_tenant (tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_members (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL, order_id BIGINT UNSIGNED NOT NULL,
    active_order_id BIGINT UNSIGNED NULL, shop_id BIGINT UNSIGNED NOT NULL,
    posting_number VARCHAR(128) NOT NULL, container_no INT UNSIGNED NULL,
    dispatched_at DATETIME NULL, dispatched_by BIGINT UNSIGNED NULL,
    withdrawn_at DATETIME NULL, withdrawn_by BIGINT UNSIGNED NULL,
    exception_code VARCHAR(64) NULL, exception_note VARCHAR(1000) NULL,
    official_member TINYINT(1) NOT NULL DEFAULT 0,
    last_synced_at DATETIME NULL, last_refresh_attempt_at DATETIME NULL, sync_error VARCHAR(2000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ogl_active_order (tenant_id, active_order_id),
    UNIQUE KEY uk_ogl_batch_order (tenant_id, batch_id, order_id),
    KEY idx_ogl_member_batch (tenant_id, batch_id, id),
    KEY idx_ogl_member_order (order_id, tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_official_locks (
    tenant_id BIGINT UNSIGNED NOT NULL, default_shop_id BIGINT UNSIGNED NOT NULL,
    delivery_method_id VARCHAR(64) NOT NULL, batch_id BIGINT UNSIGNED NOT NULL,
    operation_token VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, default_shop_id, delivery_method_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS ogl_dispatch_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL, member_id BIGINT UNSIGNED NULL,
    action VARCHAR(64) NOT NULL, reason VARCHAR(1000) NOT NULL DEFAULT '',
    detail_json JSON NULL, person_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ogl_event_batch (tenant_id, batch_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];

export async function ensureOglDispatchSchema(execute) {
  const run = typeof execute === 'function' ? execute : (sql) => execute.query(sql);
  for (const sql of OGL_DISPATCH_SCHEMA_SQL) await run(sql);
}

export const ensureSchema = ensureOglDispatchSchema;

const requiredColumns = {
  ogl_dispatch_settings: ['tenant_id','default_shop_id','updated_by','updated_at'],
  ogl_dispatch_batches: ['id','tenant_id','batch_number','client_request_id','default_shop_id','containers_count','status','note','delivery_method_id','departure_date','official_carriage_id','official_status','official_result_json','official_operation_token','official_error','last_refreshed_at','created_by','created_at','updated_at'],
  ogl_dispatch_members: ['id','tenant_id','batch_id','order_id','active_order_id','shop_id','posting_number','container_no','dispatched_at','dispatched_by','withdrawn_at','withdrawn_by','exception_code','exception_note','official_member','last_synced_at','last_refresh_attempt_at','sync_error','created_at'],
  ogl_dispatch_official_locks: ['tenant_id','default_shop_id','delivery_method_id','batch_id','operation_token','created_at'],
  ogl_dispatch_events: ['id','tenant_id','batch_id','member_id','action','reason','detail_json','person_id','created_at']
};
const requiredUniqueKeys = [
  ['ogl_dispatch_settings','PRIMARY',['tenant_id']],
  ['ogl_dispatch_batches','PRIMARY',['id']],
  ['ogl_dispatch_members','PRIMARY',['id']],
  ['ogl_dispatch_events','PRIMARY',['id']],
  ['ogl_dispatch_batches','uk_ogl_batch_request',['tenant_id','client_request_id']],
  ['ogl_dispatch_batches','uk_ogl_batch_number',['tenant_id','batch_number']],
  ['ogl_dispatch_batches','uk_ogl_official',['tenant_id','default_shop_id','official_carriage_id']],
  ['ogl_dispatch_members','uk_ogl_active_order',['tenant_id','active_order_id']],
  ['ogl_dispatch_members','uk_ogl_batch_order',['tenant_id','batch_id','order_id']],
  ['ogl_dispatch_official_locks','PRIMARY',['tenant_id','default_shop_id','delivery_method_id']]
];

export async function inspectOglDispatchSchema(query) {
  const tables=Object.keys(requiredColumns), placeholders=tables.map(()=>'?').join(',');
  const columns=await query(`SELECT table_name,column_name,column_type,is_nullable,column_default,extra FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (${placeholders})`,tables);
  const engines=await query(`SELECT table_name,engine FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (${placeholders})`,tables);
  const statistics=await query(`SELECT table_name,index_name,column_name,seq_in_index,non_unique,sub_part,is_visible FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (${placeholders})`,tables);
  const present=new Set(columns.map(row=>row.TABLE_NAME||row.table_name));
  const missing=tables.filter(table=>!present.has(table)), invalid=[];
  for(const [table,names]of Object.entries(requiredColumns)) {
    if(!present.has(table))continue;
    if(!engines.some(row=>(row.TABLE_NAME||row.table_name)===table&&String(row.ENGINE||row.engine).toUpperCase()==='INNODB'))invalid.push(`${table} requires InnoDB`);
    const own=columns.filter(row=>(row.TABLE_NAME||row.table_name)===table);
    for(const name of names)if(!own.some(row=>(row.COLUMN_NAME||row.column_name)===name))invalid.push(`${table}.${name} missing`);
    const owner=own.find(row=>(row.COLUMN_NAME||row.column_name)==='tenant_id');
    if(!owner||!/^(?:bigint)(?:\(\d+\))? unsigned$/i.test(owner.COLUMN_TYPE||owner.column_type||'')
      ||(owner.IS_NULLABLE||owner.is_nullable)!=='NO'||(owner.COLUMN_DEFAULT??owner.column_default)!=null)invalid.push(`${table}.tenant_id must be explicit BIGINT UNSIGNED NOT NULL without default`);
    if(['ogl_dispatch_batches','ogl_dispatch_members','ogl_dispatch_events'].includes(table)) {
      const identity=own.find(row=>(row.COLUMN_NAME||row.column_name)==='id');
      if(!identity||!/^bigint(?:\(\d+\))? unsigned$/i.test(identity.COLUMN_TYPE||identity.column_type||'')
        ||(identity.IS_NULLABLE||identity.is_nullable)!=='NO'||!/auto_increment/i.test(identity.EXTRA||identity.extra||''))invalid.push(`${table}.id requires BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`);
    }
    if(table==='ogl_dispatch_members') {
      const active=own.find(row=>(row.COLUMN_NAME||row.column_name)==='active_order_id');
      if((active?.IS_NULLABLE||active?.is_nullable)!=='YES')invalid.push(`${table}.active_order_id must remain nullable for withdrawals`);
    }
  }
  const indexes=new Map();
  for(const row of statistics) {
    const table=row.TABLE_NAME||row.table_name,name=row.INDEX_NAME||row.index_name,key=`${table}.${name}`;
    const index=indexes.get(key)||{table,name,columns:[],unique:true,complete:true};
    index.columns[Number(row.SEQ_IN_INDEX??row.seq_in_index)-1]=row.COLUMN_NAME||row.column_name;
    index.unique&&=Number(row.NON_UNIQUE??row.non_unique)===0;
    index.complete&&=(row.SUB_PART??row.sub_part)==null&&(row.IS_VISIBLE||row.is_visible)==='YES';
    indexes.set(key,index);
  }
  for(const [table,name,expected]of requiredUniqueKeys) {
    if(!present.has(table))continue;
    const key=indexes.get(`${table}.${name}`);
    if(!key?.unique||!key.complete||key.columns.join(',')!==expected.join(','))invalid.push(`${table}.${name} requires visible full UNIQUE(${expected.join(',')})`);
    const natural=expected.filter(column=>column!=='tenant_id');
    if(expected.includes('tenant_id')&&natural.length)for(const other of indexes.values())if(other.table===table&&other.unique&&!other.columns.includes('tenant_id')
      &&natural.every(column=>other.columns.includes(column)))invalid.push(`${table}.${other.name} is an unsafe global natural key`);
  }
  for(const index of indexes.values())if(index.unique&&index.name!=='PRIMARY'&&!index.columns.includes('tenant_id'))invalid.push(`${index.table}.${index.name} is an unsafe global natural key`);
  return {ready:!missing.length&&!invalid.length,missing_tables:missing,invalid:[...new Set(invalid)]};
}

export async function assertOglDispatchSchemaReady(query) {
  const result=await inspectOglDispatchSchema(query);
  if(!result.ready)throw Object.assign(new Error(`OGL 企业发运结构未就绪，请先执行 release 的 migrate-ogl-dispatch-schema.mjs：${[...result.missing_tables,...result.invalid].join('；')}`),{statusCode:503});
  return result;
}

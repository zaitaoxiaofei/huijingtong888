// Compact final facts contain no product metadata or original response JSON.
export const SKU_TRAFFIC_DAILY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seller_sku_traffic_daily (
    tenant_id VARCHAR(80) NOT NULL, shop_id BIGINT UNSIGNED NOT NULL, sku VARCHAR(128) NOT NULL,
    date_key DATE NOT NULL, total_views DECIMAL(18,4) NULL, search_views DECIMAL(18,4) NULL,
    pdp_views DECIMAL(18,4) NULL, total_hits_to_cart DECIMAL(18,4) NULL, ordered_units DECIMAL(18,4) NULL,
    conv_views_to_order DECIMAL(18,4) NULL, conv_total_views_to_cart DECIMAL(18,4) NULL,
    conv_hits_to_cart_to_order DECIMAL(18,4) NULL, updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(tenant_id,shop_id,date_key,sku),
    KEY idx_sku_traffic_series(tenant_id,shop_id,sku,date_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS seller_sku_traffic_days (
    tenant_id VARCHAR(80) NOT NULL, shop_id BIGINT UNSIGNED NOT NULL, date_key DATE NOT NULL,
    run_id VARCHAR(80) NULL, status VARCHAR(24) NOT NULL, message VARCHAR(512) NULL,
    requested_at DATETIME(3) NOT NULL, last_success_at DATETIME(3) NULL, product_count INT NULL,
    PRIMARY KEY(tenant_id,shop_id,date_key), KEY idx_sku_traffic_days_date(date_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

export async function inspectSkuTrafficDailySchema(query) {
  const tables=['seller_sku_traffic_daily','seller_sku_traffic_days'];
  const columns=await query("SELECT TABLE_NAME table_name,COLUMN_NAME column_name,DATA_TYPE data_type,CHARACTER_MAXIMUM_LENGTH max_length,NUMERIC_PRECISION precision_value,NUMERIC_SCALE scale_value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)",tables);
  const indexes=await query("SELECT TABLE_NAME table_name,INDEX_NAME index_name,COLUMN_NAME column_name,SEQ_IN_INDEX position_value FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",tables);
  const missing_tables=[],problems=[];
  const required={seller_sku_traffic_daily:{tenant_id:'varchar',shop_id:'bigint',sku:'varchar',date_key:'date',total_views:'decimal',search_views:'decimal',pdp_views:'decimal',total_hits_to_cart:'decimal',ordered_units:'decimal',conv_views_to_order:'decimal',conv_total_views_to_cart:'decimal',conv_hits_to_cart_to_order:'decimal',updated_at:'datetime'},seller_sku_traffic_days:{tenant_id:'varchar',shop_id:'bigint',date_key:'date',run_id:'varchar',status:'varchar',message:'varchar',requested_at:'datetime',last_success_at:'datetime',product_count:'int'}};
  for(const table of tables){
    const present=columns.filter(c=>c.table_name===table);
    if(!present.length){missing_tables.push(table);continue;}
    for(const [name,type] of Object.entries(required[table])){
      const column=present.find(c=>c.column_name===name);
      if(!column||column.data_type!==type||(type==='decimal'&&(Number(column.precision_value)!==18||Number(column.scale_value)!==4)))problems.push(`${table}.${name}`);
    }
    for(const [name,size] of Object.entries({tenant_id:80,...(table==='seller_sku_traffic_daily'?{sku:128}:{run_id:80,status:24,message:512})}))if(Number(present.find(c=>c.column_name===name)?.max_length)!==size)problems.push(`${table}.${name}:length`);
    const expected=table==='seller_sku_traffic_daily'?'tenant_id,shop_id,date_key,sku':'tenant_id,shop_id,date_key';
    if(indexes.filter(i=>i.table_name===table&&i.index_name==='PRIMARY').map(i=>i.column_name).join(',')!==expected)problems.push(`${table}:tenant-primary-key`);
    if(table==='seller_sku_traffic_daily'&&indexes.filter(i=>i.table_name===table&&i.index_name==='idx_sku_traffic_series').map(i=>i.column_name).join(',')!=='tenant_id,shop_id,sku,date_key')problems.push(`${table}:series-index`);
  }
  return {ready:!missing_tables.length&&!problems.length,missing_tables,problems};
}

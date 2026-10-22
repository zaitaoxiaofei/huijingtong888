import { mysqlQuery } from "../mysql-pool.js";
import { AI_BACKGROUND_TENANT_TABLES } from './ai-background-tenant-tables.js';
import { assertAiVariantDraftHistorySchemaReady } from './ai-variant-draft-history-schema.js';
import { assertOglDispatchSchemaReady } from './ogl-dispatch-schema.js';

// Some optional workflows create their tables lazily. An absent table is safe;
// an existing legacy table without ownership must never reach a business query.
const optionalOwnedTables = [
  'product_components', 'product_name_aliases', 'asset_tail_templates', 'inventory_product_requests', 'inventory_product_naming_options',
  'ai_variant_lab_analyses', 'ai_variant_lab_plans', 'ai_variant_templates', 'ai_variant_template_cases',
  'ai_variant_case_templates', 'ai_variant_case_runs', 'ai_variant_lab_batch_jobs', 'ai_variant_lab_batch_items',
  'ai_image_usage_events', 'ai_image_optimizer_jobs', 'ai_generation_tasks', 'ai_variant_draft_save_batches', 'ai_vehicle_catalog',
  'ai_variant_draft_save_items', 'asset_variant_jobs', 'listing_ozon_copy_jobs'
];

// Readiness must fail before a candidate can replace production when its
// required ownership migration was skipped or applied to the wrong database.
export async function assertTenantPilotSchemaReady(query = mysqlQuery) {
  await assertAiVariantDraftHistorySchemaReady(query);
  await assertOglDispatchSchemaReady(query);
  const required = {
    products: ["tenant_id"], shops: ["tenant_id"], sku_mappings: ["tenant_id"],
    suppliers: ["tenant_id"], logistics_fee_rules: ["tenant_id"],
    procurement_requests: ["tenant_id"], inventory_movements: ["tenant_id"],
    purchase_orders: ["tenant_id"], purchase_order_items: ["tenant_id"], inbound_records: ["tenant_id"],
    purchase_cost_versions: ["tenant_id"], procurement_platform_orders: ["tenant_id"],
    procurement_payment_transactions: ["tenant_id"], procurement_payment_matches: ["tenant_id"],
    sync_logs: ["tenant_id"], tenant_private_files: ["tenant_id", "storage_name", "purpose"],
    tenant_ai_limits: ["tenant_id", "monthly_request_limit"], tenant_ai_usage: ["tenant_id", "period_key"],
    ai_image_task_owners: ["tenant_id", "task_id", "created_by_person_id"],
    team_tasks: ["tenant_id"], team_operational_owners: ["tenant_id"],
    product_development_projects: ["tenant_id"], product_development_candidates: ["tenant_id"],
    product_development_ideas: ["tenant_id"], product_development_idea_products: ["tenant_id"],
    product_development_idea_drafts: ["tenant_id"], product_development_task_links: ["tenant_id"],
    product_development_heatmap_orders: ["tenant_id"], order_vehicle_title_tags: ["tenant_id"],
    material_assets: ["tenant_id"], system_notifications: ["tenant_id"],
    customer_message_templates: ["tenant_id"], customer_message_shop_settings: ["automation_person_id"], customer_message_tasks: ["person_id"]
  };
  const tables = [...Object.keys(required), ...optionalOwnedTables];
  const columns = await query(`SELECT table_name, column_name, column_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (${tables.map(() => "?").join(",")})`, tables);
  const present = new Set(columns.map(row => `${row.TABLE_NAME || row.table_name}.${row.COLUMN_NAME || row.column_name}`));
  const missing = Object.entries(required).flatMap(([table, names]) => names.filter(name => !present.has(`${table}.${name}`)).map(name => `${table}.${name}`));
  for (const table of optionalOwnedTables) {
    if (columns.some(row => (row.TABLE_NAME || row.table_name) === table) && !present.has(`${table}.tenant_id`)) missing.push(`${table}.tenant_id`);
  }
  if (missing.length) throw Object.assign(new Error(`企业隔离数据库迁移未完成，请运行 release 的企业迁移后再启动：${missing.join("、")}`), { statusCode: 503 });
  const uniqueKeys = [
    ['procurement_platform_orders','uk_procurement_platform_order',['tenant_id','platform','platform_order_no']],
    ['procurement_payment_transactions','uk_procurement_payment_transaction',['tenant_id','provider','external_no']],
    ['procurement_payment_matches','uk_procurement_payment_match_order',['tenant_id','platform_order_id']],
    ['customer_message_templates','PRIMARY',['tenant_id','scenario']],
    ['tenant_ai_limits','PRIMARY',['tenant_id']],
    ['tenant_ai_usage','PRIMARY',['tenant_id','period_key']],
    ['ai_image_task_owners','PRIMARY',['task_id']],
    ['ai_vehicle_catalog','uniq_ai_vehicle_catalog_tenant_brand_model',['tenant_id','brand_key','model_key']],
    ...AI_BACKGROUND_TENANT_TABLES.filter(([,name])=>name).map(([table,name,key])=>[table,name,['tenant_id',key]])
  ];
  const existing = new Set(columns.map(row => row.TABLE_NAME || row.table_name));
  const checked = uniqueKeys.filter(([table])=>existing.has(table));
  const indexedTables = [...new Set([...checked.map(([table])=>table), 'suppliers'])];
  const statistics = await query(`SELECT table_name,index_name,column_name,seq_in_index,non_unique FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (${indexedTables.map(()=>'?').join(',')})`,indexedTables);
  const indexes = new Map();
  for(const row of statistics){
    const table=row.TABLE_NAME||row.table_name,name=row.INDEX_NAME||row.index_name;
    const key=`${table}.${name}`;
    const index=indexes.get(key)||{table,name,columns:[],unique:Number(row.NON_UNIQUE??row.non_unique)===0};
    index.columns[Number(row.SEQ_IN_INDEX??row.seq_in_index)-1]=row.COLUMN_NAME||row.column_name;
    indexes.set(key,index);
  }
  const supplierIndex = indexes.get('suppliers.idx_suppliers_tenant_status_id');
  if (!supplierIndex || supplierIndex.unique || supplierIndex.columns.join(',') !== 'tenant_id,status,id') {
    throw Object.assign(new Error('供应商企业索引迁移未完成，请运行 scripts/migrate-tenant-suppliers.mjs --apply 后再启动：suppliers.idx_suppliers_tenant_status_id (tenant_id,status,id)'), { statusCode: 503 });
  }
  const invalid=[];
  for(const [table,name,expected]of checked){
    const index=indexes.get(`${table}.${name}`);
    if(!index?.unique||index.columns.join(',')!==expected.join(','))invalid.push(`${table}.${name} UNIQUE(${expected.join(',')})`);
    const natural=expected.filter(column=>column!=='tenant_id');
    if(expected.includes('tenant_id')&&natural.length)for(const other of indexes.values()){
      if(other.table===table&&other.unique&&!other.columns.includes('tenant_id')&&natural.every(column=>other.columns.includes(column)))invalid.push(`${table}.${other.name} 仍为全局唯一键`);
    }
    if(expected.includes('tenant_id')){
      const owner=columns.find(row=>(row.TABLE_NAME||row.table_name)===table&&(row.COLUMN_NAME||row.column_name)==='tenant_id');
      if((owner?.IS_NULLABLE||owner?.is_nullable)!=='NO')invalid.push(`${table}.tenant_id 必须 NOT NULL`);
    }
  }
  for(const table of [...AI_BACKGROUND_TENANT_TABLES.map(([table])=>table),'ai_vehicle_catalog']){
    if(!existing.has(table))continue;
    const owner=columns.find(row=>(row.TABLE_NAME||row.table_name)===table&&(row.COLUMN_NAME||row.column_name)==='tenant_id');
    if((owner?.IS_NULLABLE||owner?.is_nullable)!=='NO'||(owner.COLUMN_DEFAULT??owner.column_default)!=='admin'
      ||!(table==='ai_vehicle_catalog'?/^varchar\(64\)$/i:/^varchar\((64|80)\)$/i).test(owner.COLUMN_TYPE||owner.column_type||''))invalid.push(`${table}.tenant_id 必须 VARCHAR NOT NULL DEFAULT admin`);
  }
  const importDefaults=columns.filter(row=>['procurement_platform_orders','procurement_payment_transactions','procurement_payment_matches'].includes(row.TABLE_NAME||row.table_name)
    &&(row.COLUMN_NAME||row.column_name)==='tenant_id'&&(row.COLUMN_DEFAULT??row.column_default)!=null);
  if(importDefaults.length){
    const [defaultTenant]=await query("SELECT id FROM tenants WHERE slug='default' AND status='active' LIMIT 1");
    for(const owner of importDefaults)if(!defaultTenant||Number(owner.COLUMN_DEFAULT??owner.column_default)!==Number(defaultTenant.id))invalid.push(`${owner.TABLE_NAME||owner.table_name}.tenant_id DEFAULT 必须为实际默认企业`);
  }
  if(invalid.length)throw Object.assign(new Error(`企业隔离关键唯一键迁移未完成：${[...new Set(invalid)].join('、')}`),{statusCode:503});
  return { ok: true, tables: tables.length };
}

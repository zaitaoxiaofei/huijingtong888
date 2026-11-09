const shopTables = `analytics_product_profit_daily analytics_shop_daily analytics_sku_profit_daily asset_variants
customer_chat_messages customer_chat_threads customer_message_logs customer_message_manual_tests customer_message_records customer_message_shop_settings customer_message_tasks
fbp_replenishment_batches fbp_replenishment_fill_executions fbp_replenishment_ignores fbp_replenishment_order_items fbp_replenishment_orders fbp_replenishment_print_records fbp_transfer_records
generated_images generated_titles inventory_alert_sku_daily online_products order_package_label_cache order_profit_detail_snapshots order_status_history orders outbound_records
ozon_ad_campaign_catalog ozon_ad_forbidden_campaigns ozon_ad_history_reconciliation ozon_ad_sku_daily ozon_category_sync_jobs ozon_finance_items ozon_review_replies ozon_reviews ozon_stock_snapshots ozon_webhook_events
product_barcode_label_cache publish_task_items scheduled_job_run_events shop_product_versions shop_variant_rules sku_inventory_recipes`.split(/\s+/);
const relations = {
  ai_credit_attempts: [['task_id', 'ai_credit_tasks']],
  fbp_replenishment_batch_members: [['batch_id', 'fbp_replenishment_batches'], ['order_id', 'fbp_replenishment_orders']],
  fbp_replenishment_item_adjustments: [['order_id', 'fbp_replenishment_orders']],
  historical_profit_reviews: [['order_item_id', 'order_items']],
  inventory_current: [['real_product_id', 'products']],
  inventory_order_priorities: [['product_id', 'products'], ['order_item_id', 'order_items']],
  inventory_product_naming_option_scopes: [['option_id', 'inventory_product_naming_options']],
  order_exceptions: [['store_id', 'shops']],
  order_items: [['order_id', 'orders']],
  order_item_procurement_marks: [['order_item_id', 'order_items']],
  order_label_prints: [['order_id', 'orders']], order_marks: [['order_id', 'orders']],
  order_profit_items: [['order_item_id', 'order_items']],
  ozon_orders_raw: [['store_id', 'shops']],
  payroll_periods: [['company_id', 'finance_companies']], payroll_profiles: [['company_id', 'finance_companies']],
  payroll_statements: [['period_id', 'payroll_periods']],
  procurement_history_sources: [['action_id', 'procurement_ledger_actions'], ['inbound_record_id', 'inbound_records']],
  procurement_ledger_actions: [['product_id', 'products']],
  procurement_order_allocations: [['procurement_request_id', 'procurement_requests']],
  procurement_platform_order_links: [['platform_order_id', 'procurement_platform_orders']],
  procurement_purchase_groups: [['supplier_id', 'suppliers']],
  procurement_purchase_group_items: [['group_id', 'procurement_purchase_groups'], ['product_id', 'products']],
  procurement_stock_cost_tasks: [['product_id', 'products']],
  procurement_stock_cost_links: [['task_id', 'procurement_stock_cost_tasks'], ['purchase_order_item_id', 'purchase_order_items']],
  product_merge_history: [['target_product_id', 'products']],
  product_merge_history_refs: [['merge_history_id', 'product_merge_history']],
  publish_tasks: [['master_product_id', 'products']],
  purchase_order_shipments: [['purchase_order_id', 'purchase_orders']],
  sku_inventory_recipe_items: [['recipe_id', 'sku_inventory_recipes']],
  fbp_shortage_item_handlings: [['request_group_no', 'procurement_requests', 'request_group_no']]
};
export function purgeIdentifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('Invalid purge SQL identifier');
  return `\`${value}\``;
}
// Every indirect edge names an existing, reviewed ownership path. Never infer
// enterprise ownership from a creator/person name or a coincident external ID.
export function buildTenantPurgeScopes(columns, foreignKeys = []) {
  const tables = new Map();
  for (const row of columns) {
    const table = row.TABLE_NAME;
    purgeIdentifier(table); purgeIdentifier(row.COLUMN_NAME);
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(row.COLUMN_NAME);
  }
  const types = new Map(columns.map(row => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, String(row.COLUMN_TYPE || "").toLowerCase()]));
  const scopes = new Map();
  const excluded = new Set(['tenants', 'tenant_purge_audit', 'tenant_purge_files']);
  for (const [table, fields] of tables) {
    if (excluded.has(table)) continue;
    const column = ['tenant_id', 'tenant_key', ...(table === 'sessions' ? ['active_tenant_id'] : []), ...(table === 'tenant_subscription_vouchers' ? ['used_by_tenant_id'] : [])].find(key => fields.has(key));
    if (column) scopes.set(table, { column, parents: [], dependencies: [] });
  }
  const edges = { ...relations };
  for (const table of shopTables) edges[table] = [...(edges[table] || []), ['shop_id', 'shops']];
  for (let pass = 0; pass < tables.size; pass++) {
    let changed = false;
    for (const [table, links] of Object.entries(edges)) {
      if (!tables.has(table) || scopes.get(table)?.column) continue;
      const parents = links.filter(([field, parent]) => tables.get(table).has(field) && tables.get(parent)?.has(links.find(link => link[1] === parent)?.[2] || 'id') && scopes.has(parent));
      if (!parents.length) continue;
      const prior = scopes.get(table);
      if (JSON.stringify(prior?.parents) !== JSON.stringify(parents)) {
        scopes.set(table, { parents, dependencies: parents.map(([, parent]) => parent) }); changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [table, column, prefix] of [
    ['dashboard_snapshots', 'snapshot_key', 'dashboard:v2:tenant:'],
    ['exception_workbench_snapshots', 'cache_key', ''],
    ['inventory_alert_base_snapshots', 'cache_key', 'alerts-v6-']
  ]) if (tables.get(table)?.has(column)) scopes.set(table, { custom: 'cache', column, prefix, parents: [], dependencies: [] });
  if (tables.get('exception_task_states')?.has('task_id') && scopes.has('orders') && scopes.has('products')) {
    scopes.set('exception_task_states', { custom: 'exception', dependencies: ['orders', 'products'] });
  }
  for (const fk of foreignKeys) {
    const child = scopes.get(fk.TABLE_NAME);
    if (child && scopes.has(fk.REFERENCED_TABLE_NAME)) child.dependencies.push(fk.REFERENCED_TABLE_NAME);
  }
  // A future unscoped shop table must be explicitly reviewed before a purge.
  for (const [table, fields] of tables) {
    if (!table.startsWith('_') && fields.has('shop_id') && !scopes.has(table)) {
      throw Object.assign(new Error(`企业清理范围尚未覆盖 ${table}，请先补充店铺归属规则后再删除`), { statusCode: 503 });
    }
  }
  const visiting = new Set(), visited = new Set(), ordered = [];
  function visit(table) {
    if (visited.has(table)) return;
    if (visiting.has(table)) throw new Error(`Cyclic purge ownership: ${table}`);
    visiting.add(table);
    for (const parent of scopes.get(table).dependencies) visit(parent);
    visiting.delete(table); visited.add(table); ordered.push(table);
  }
  for (const table of scopes.keys()) visit(table);
  function predicate(table, tenantId, alias = 'r', depth = 0) {
    const scope = scopes.get(table);
    if (scope.custom === 'cache') return { sql: `${alias}.${purgeIdentifier(scope.column)} LIKE ?`, params: [scope.prefix === 'alerts-v6-' ? `${scope.prefix}${tenantId}` : `${scope.prefix}${tenantId}:%`] };
    if (scope.custom === 'exception') {
      const product = predicate('products', tenantId, `x${depth}p`, depth + 1);
      const order = predicate('orders', tenantId, `x${depth}o`, depth + 1);
      const number = `SUBSTRING_INDEX(SUBSTRING_INDEX(${alias}.task_id, ':', 2), ':', -1)`;
      return { sql: `(( ${alias}.task_id REGEXP '^stock_(local|fbp|fbs|mapping):[1-9][0-9]*:' AND EXISTS (SELECT 1 FROM products x${depth}p WHERE x${depth}p.id = CAST(${number} AS UNSIGNED) AND ${product.sql})) OR (${alias}.task_id REGEXP '^(profit|deadline|deadline_warning|order_binding|order_stock_shortage):[1-9][0-9]*:' AND EXISTS (SELECT 1 FROM orders x${depth}o WHERE x${depth}o.id = CAST(${number} AS UNSIGNED) AND ${order.sql})))`, params: [...product.params, ...order.params] };
    }
    if (scope.column) return { sql: `${alias}.${purgeIdentifier(scope.column)} = ?`, params: [String(tenantId)] };
    const params = [];
    const parts = scope.parents.map(([field, parent, parentKey = 'id'], index) => {
      const next = `p${depth}_${index}`;
      const own = predicate(parent, tenantId, next, depth + 1);
      params.push(...own.params);
      const parentColumn = `${next}.${purgeIdentifier(parentKey)}`, childColumn = `${alias}.${purgeIdentifier(field)}`;
      const textualKey = /char|text/.test(types.get(`${parent}.${parentKey}`) || '') || parentKey !== 'id';
      const relation = textualKey ? `CAST(${parentColumn} AS BINARY) = CAST(${childColumn} AS BINARY)` : `${parentColumn} = ${childColumn}`;
      return `EXISTS (SELECT 1 FROM ${purgeIdentifier(parent)} ${next} WHERE ${relation} AND (${own.sql}))`;
    });
    return { sql: `(${parts.join(' OR ')})`, params };
  }
  return { tables, order: ordered.reverse(), predicate };
}

async function mysqlQuery(sql, params = []) {
  const pool = await import('../mysql-pool.js');
  return pool.mysqlQuery(sql, params);
}

const resources = Object.freeze({
  product: 'products', supplier: 'suppliers', shop: 'shops', mapping: 'sku_mappings',
  request: 'procurement_requests', purchase: 'purchase_orders', purchaseItem: 'purchase_order_items',
  inbound: 'inbound_records', movement: 'inventory_movements', costVersion: 'purchase_cost_versions',
  platformOrder: 'procurement_platform_orders', payment: 'procurement_payment_transactions'
});

// For existing composable SQL fragments. Both values come from the resolved DB row;
// user filters and record IDs must continue using query bindings.
export function inventoryTenantSql(scope, alias = '') {
  if (!Number.isSafeInteger(scope?.id) || scope.id <= 0 || (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))) throw new Error('Invalid inventory tenant scope');
  const column = `${alias ? `${alias}.` : ''}tenant_id`;
  return `(${column} = ${scope.id}${scope.isDefault ? ` OR ${column} IS NULL` : ''})`;
}

export async function resolveInventoryTenantScope(tenantId, query = mysqlQuery) {
  const raw = String(tenantId ?? '').trim();
  if (raw !== 'admin' && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0)) {
    throw Object.assign(new Error('当前企业上下文无效，无法访问库存或采购数据'), { statusCode: 403 });
  }
  const rows = await query(raw === 'admin'
    ? "SELECT id, slug FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1"
    : "SELECT id, slug FROM tenants WHERE id = ? AND status = 'active' LIMIT 1", raw === 'admin' ? [] : [Number(raw)]);
  const row = rows[0];
  if (!Number.isSafeInteger(Number(row?.id)) || Number(row.id) <= 0) {
    throw Object.assign(new Error('当前企业不存在或已停用，无法访问库存或采购数据'), { statusCode: 403 });
  }
  const id = Number(row.id), isDefault = row.slug === 'default';
  return {
    id, isDefault,
    predicate(alias = '') {
      if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid tenant table alias');
      const column = `${alias ? `${alias}.` : ''}tenant_id`;
      return { sql: `(${column} = ?${isDefault ? ` OR ${column} IS NULL` : ''})`, params: [id] };
    }
  };
}

export async function assertInventoryRecord(scope, resource, recordId, query = mysqlQuery, { lock = false, optional = false } = {}) {
  const id = Number(recordId || 0);
  if (!id && optional) return null;
  if (!Number.isSafeInteger(id) || id <= 0 || (!resources[resource] && !['order', 'orderItem', 'online', 'fbpOrder', 'fbpItem', 'transfer'].includes(resource))) {
    throw Object.assign(new Error('库存或采购记录编号无效'), { statusCode: 400 });
  }
  const shopResources = {
    order: ['orders', 'owned.shop_id', ''],
    orderItem: ['order_items', 'own_order.shop_id', 'JOIN orders own_order ON own_order.id = owned.order_id'],
    online: ['online_products', 'owned.shop_id', ''],
    fbpOrder: ['fbp_replenishment_orders', 'owned.shop_id', ''],
    fbpItem: ['fbp_replenishment_order_items', 'own_order.shop_id', 'JOIN fbp_replenishment_orders own_order ON own_order.id = owned.order_id AND own_order.shop_id = owned.shop_id']
  };
  let rows;
  if (shopResources[resource]) {
    const [table, shopId, joins] = shopResources[resource];
    rows = await query(`SELECT owned.* FROM ${table} owned ${joins} JOIN shops owner_shop ON owner_shop.id = ${shopId}
      WHERE owned.id = ? AND ${scope.predicate('owner_shop').sql} LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, scope.id]);
  } else if (resource === 'transfer') {
    rows = await query(`SELECT owned.* FROM fbp_transfer_records owned JOIN products p ON p.id = owned.product_id
      LEFT JOIN shops s ON s.id = owned.shop_id WHERE owned.id = ? AND ${scope.predicate('p').sql}
      AND (owned.shop_id IS NULL OR ${scope.predicate('s').sql}) LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, scope.id, scope.id]);
  } else {
    const table = resources[resource], tenant = scope.predicate('owned');
    rows = await query(`SELECT owned.* FROM ${table} owned WHERE owned.id = ? AND ${tenant.sql} LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, ...tenant.params]);
  }
  if (!rows[0]) throw Object.assign(new Error('记录不存在或不属于当前企业，请刷新后重试'), { statusCode: 404 });
  const row = rows[0];
  const parents = {
    mapping: [['product_id', 'product'], ['shop_id', 'shop'], ['online_product_id', 'online']],
    request: [['product_id', 'product'], ['supplier_id', 'supplier'], ['purchase_order_id', 'purchase'], ['source_order_id', 'order'], ['source_order_item_id', 'orderItem']],
    purchaseItem: [['product_id', 'product'], ['purchase_order_id', 'purchase']],
    inbound: [['product_id', 'product'], ['purchase_order_item_id', 'purchaseItem'], ['procurement_request_id', 'request']],
    movement: [['product_id', 'product'], ['shop_id', 'shop']],
    costVersion: [['product_id', 'product'], ['purchase_order_id', 'purchase']],
    fbpItem: [['product_id', 'product'], ['mapping_id', 'mapping']],
    transfer: [['product_id', 'product'], ['mapping_id', 'mapping']]
  };
  for (const [field, originalKind] of parents[resource] || []) if (row[field]) {
    const kind = resource === 'request' && row.source_type === 'fbp'
      ? field === 'source_order_id' ? 'fbpOrder' : field === 'source_order_item_id' ? 'fbpItem' : originalKind
      : originalKind;
    await assertInventoryRecord(scope, kind, row[field], query, { lock });
  }
  return row;
}

export async function assertInventoryMember(scope, personId, query = mysqlQuery, { optional = false } = {}) {
  const id = Number(personId || 0);
  if (!id && optional) return null;
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('请选择当前企业的有效成员'), { statusCode: 400 });
  const rows = await query(`SELECT p.id FROM people p JOIN tenant_members tm ON tm.person_id = p.id
    WHERE tm.tenant_id = ? AND tm.person_id = ? AND tm.active = 1 AND p.active != 0 LIMIT 1`, [scope.id, id]);
  if (!rows.length) throw Object.assign(new Error('所选人员不是当前企业的有效成员'), { statusCode: 400 });
  return id;
}

// Only known business references are inspected; a client tenant selector never supplies scope.
export async function assertInventoryReferences(scope, body = {}, query = mysqlQuery) {
  const fields = {
    product_id: 'product', productId: 'product', target_product_id: 'product', component_product_id: 'product',
    supplier_id: 'supplier', supplierId: 'supplier', shop_id: 'shop', shopId: 'shop',
    sku_mapping_id: 'mapping', skuMappingId: 'mapping', mapping_id: 'mapping', mappingId: 'mapping', procurement_request_id: 'request',
    purchase_order_id: 'purchase', purchaseOrderId: 'purchase', purchase_order_item_id: 'purchaseItem',
    inbound_record_id: 'inbound', platform_order_id: 'platformOrder', source_order_id: 'order',
    source_order_item_id: 'orderItem', online_product_id: 'online', order_item_id: 'orderItem',
    related_order_item_id: 'orderItem', source_selection_id: 'product', parent_product_id: 'product'
  };
  for (const [field, originalKind] of Object.entries(fields)) {
    if (body[field] !== undefined && body[field] !== null && String(body[field]).trim() && Number(body[field])) {
      const kind = body.source_type === 'fbp' ? field === 'source_order_id' ? 'fbpOrder' : field === 'source_order_item_id' ? 'fbpItem' : originalKind : originalKind;
      await assertInventoryRecord(scope, kind, body[field], query);
    }
  }
  for (const field of ['person_id', 'personId', 'owner_person_id', 'created_by_person_id']) {
    if (body[field]) await assertInventoryMember(scope, body[field], query);
  }
  for (const key of ['items', 'components', 'composition_items', 'allocations', 'extra_sources', 'rows']) {
    if (Array.isArray(body[key])) for (const item of body[key]) await assertInventoryReferences(scope, item, query);
  }
}

function pick(source = {}, keys = []) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function inventoryStocktakeBody(body = {}) {
  if (body.action_type !== 'stocktake') throw Object.assign(new Error('库存明细仅支持更新仓库实物数或剩余可用数；采购与历史核对请到采购工作台操作'), { statusCode: 403 });
  return pick(body, ['action_type', 'product_id', 'revision', 'request_key', 'stocktake_type', 'counted_quantity',
    'available_quantity', 'reason_code', 'reason_note', 'reason']);
}

export function inventoryLedgerView(value = {}) {
  return {
    product: pick(value.product, ['id', 'name', 'code', 'inventory_number', 'stock_unit', 'image_url']),
    ...pick(value, ['revision', 'local_stock', 'physical_estimate', 'open_order_deducted', 'available_estimate',
      'open_order_demand', 'fbp_reserved', 'current_stock_reserved', 'incoming_quantity', 'current_incoming',
      'current_shortage', 'stocktake_id', 'last_stocktake_at']),
    orders: (value.orders || []).map((row) => pick(row, ['order_id', 'order_item_id', 'posting_number', 'ordered_at',
      'transport_at', 'needs_fulfillment', 'entered_transport', 'stock_location', 'quantity', 'stock_quantity',
      'incoming_quantity', 'shortage_quantity', 'outbound_quantity', 'quantity_needs_review'])),
    movements: (value.movements || []).map((row) => pick(row, ['source_type', 'stock_location', 'quantity_delta',
      'last_id', 'last_created_at', 'record_count'])),
    actions: (value.actions || []).filter((row) => row.action_type === 'stocktake').map((row) => {
      const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json || {};
      return { ...pick(row, ['id', 'action_type', 'person_name', 'reason', 'created_at']),
        result_json: pick(result, ['physical_before', 'physical_after', 'stocktake_delta', 'available_before',
          'available_after', 'open_order_demand', 'fbp_reserved', 'stocktake_type']) };
    }),
    fbp_inventory: value.fbp_inventory ? {
      ...pick(value.fbp_inventory, ['present', 'available', 'incomplete']),
      rows: (value.fbp_inventory.rows || []).map((row) => pick(row, ['shop_id', 'shop_name', 'ozon_sku', 'product_name',
        'warehouse_name', 'present', 'available', 'per_set_quantity', 'inventory_quantity', 'synced_at']))
    } : null
  };
}

export function inventoryStocktakePreviewView(value = {}) {
  return pick(value, ['revision', 'reason', 'reason_code', 'physical_before', 'physical_after', 'available_before',
    'available_after', 'open_order_demand', 'order_reserved', 'fbp_reserved', 'stocktake_delta', 'cost_task_quantity']);
}

export function inventoryStocktakeResultView(value = {}) {
  return pick(value, ['ok', 'action_id', 'action_type', 'physical_before', 'physical_after', 'available_before',
    'available_after', 'stocktake_delta', 'cost_task_quantity']);
}

export async function loadWarehouseFacts(query, productIds, localPredicate) {
  const ids = [...new Set(productIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const [stock, incoming, transfers, reserved] = await Promise.all([
    query(`SELECT product_id, SUM(quantity_delta) AS quantity FROM inventory_movements
      WHERE product_id IN (${marks}) AND status = 'posted' AND ${localPredicate}
        AND source_type NOT IN ('fbp_replenishment_reserve', 'fbp_replenishment_reserve_release') GROUP BY product_id`, ids),
    query(`SELECT product_id, SUM(quantity) AS quantity FROM inbound_records
      WHERE product_id IN (${marks}) AND status = 'pending_arrival' GROUP BY product_id`, ids),
    query(`SELECT * FROM (
      SELECT product_id, shop_id, ozon_sku, quantity, listed_quantity, status, shipped_at,
        DENSE_RANK() OVER (PARTITION BY product_id ORDER BY shipped_at DESC) AS latest_product,
        DENSE_RANK() OVER (PARTITION BY product_id, shop_id, ozon_sku ORDER BY shipped_at DESC) AS latest_sku
      FROM fbp_transfer_records WHERE product_id IN (${marks})
        AND status NOT IN ('draft', 'cancelled') AND shipped_at IS NOT NULL
      ) shipments WHERE latest_product = 1 OR latest_sku = 1 OR status IN ('sent', 'in_transit', 'received')`, ids),
    query(`SELECT i.product_id, SUM(GREATEST(i.approved_qty + COALESCE(a.quantity, 0), 0)) AS quantity
      FROM fbp_replenishment_order_items i JOIN fbp_replenishment_orders o ON o.id = i.order_id
      LEFT JOIN (SELECT item_id, SUM(adjustment_qty) AS quantity FROM fbp_replenishment_item_adjustments GROUP BY item_id) a ON a.item_id = i.id
      WHERE i.product_id IN (${marks}) AND o.status IN ('approved', 'ozon_created') GROUP BY i.product_id`, ids)
  ]);
  const result = new Map(ids.map(id => [id, { ledger_stock: 0, procurement_incoming: 0, fbp_pending: 0, reserved_fbp: 0, last_shipped_qty: 0, last_shipped_at: null, sku_shipments: {} }]));
  for (const row of stock) result.get(Number(row.product_id)).ledger_stock = Number(row.quantity);
  for (const row of incoming) result.get(Number(row.product_id)).procurement_incoming = Number(row.quantity);
  for (const row of reserved) result.get(Number(row.product_id)).reserved_fbp = Number(row.quantity);
  for (const row of transfers) {
    const fact = result.get(Number(row.product_id));
    if (['sent', 'in_transit', 'received'].includes(row.status)) fact.fbp_pending += Math.max(0, Number(row.quantity) - Number(row.listed_quantity));
    if (Number(row.latest_product) === 1) { fact.last_shipped_qty += Number(row.quantity); fact.last_shipped_at = row.shipped_at; }
    if (Number(row.latest_sku) === 1) {
      const key = `${row.shop_id}:${row.ozon_sku}`;
      const previous = fact.sku_shipments[key] || { quantity: 0, shipped_at: row.shipped_at };
      previous.quantity += Number(row.quantity);
      fact.sku_shipments[key] = previous;
    }
  }
  return result;
}

export function validatePrintRecord(body) {
  const quantity = Number(body.quantity);
  const itemId = Number(body.item_id), orderId = Number(body.order_id);
  const key = String(body.request_key || '');
  const preparationQuantity = Number(body.preparation_quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('本次已打印数量（quantity）须为 1～999 张，请按实际出纸数量填写；超过 999 张请分批打印。');
  if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(orderId) || orderId < 1) throw new Error('缺少备货单明细（item_id/order_id），请重新打开打印窗口。');
  if (!/^[\w-]{16,96}$/.test(key)) throw new Error('打印确认标识（request_key）已失效，请刷新页面重新打开打印窗口。');
  if (!Number.isSafeInteger(preparationQuantity) || preparationQuantity < 1) throw new Error('打印时的备货数量（preparation_quantity）无效，请重新打开打印窗口。');
  return { quantity, itemId, orderId, key, preparationQuantity };
}

export async function appendPrintRecord(connection, body, userId) {
  const { quantity, itemId, orderId, key, preparationQuantity } = validatePrintRecord(body);
  const [rows] = await connection.execute('SELECT * FROM fbp_replenishment_order_items WHERE id = ? AND order_id = ? FOR UPDATE', [itemId, orderId]);
  if (!rows.length) throw new Error('备货明细已删除，无法登记打印，请联系操作人核对已打印标签。');
  const [previous] = await connection.execute('SELECT * FROM fbp_replenishment_print_records WHERE request_key = ?', [key]);
  if (previous.length) {
    if (Number(previous[0].item_id) !== itemId || Number(previous[0].quantity) !== quantity || Number(previous[0].preparation_quantity) !== preparationQuantity) throw new Error('同一打印确认不能改成其他数量，请先刷新打印记录。');
    return { ok: true, duplicate: true, barcode_printed_qty: Number(rows[0].barcode_printed_qty) };
  }
  await connection.execute(`INSERT INTO fbp_replenishment_print_records
    (request_key, order_id, item_id, shop_id, ozon_sku, quantity, preparation_quantity, created_by, print_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [key, orderId, itemId, rows[0].shop_id, rows[0].ozon_sku, quantity, preparationQuantity, userId || null,
    Number(rows[0].barcode_printed_qty || 0) >= preparationQuantity + 2 ? 'reprint' : 'initial']);
  await connection.execute(`UPDATE fbp_replenishment_order_items SET barcode_printed_qty = barcode_printed_qty + ?,
    barcode_printed_at = CURRENT_TIMESTAMP, barcode_printed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND order_id = ?`,
  [quantity, userId || null, itemId, orderId]);
  await connection.execute('UPDATE fbp_replenishment_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [orderId]);
  return { ok: true, barcode_printed_qty: Number(rows[0].barcode_printed_qty || 0) + quantity };
}

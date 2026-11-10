export const ORDER_BINDING_IGNORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS order_inventory_binding_ignores (
  tenant_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  person_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, order_id, ozon_sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Only dismiss the binding reminder. This never creates a product/mapping,
// releases stock, marks an order ready, or changes future orders for the SKU.
export function createOrderBindingIgnoreService({ query, execute, scope, predicate, person, invalidate }) {
  let schemaReady;
  const ensure = () => schemaReady ||= execute(ORDER_BINDING_IGNORE_SCHEMA).catch(error => {
    schemaReady = null;
    throw error;
  });
  async function set(orderId, body = {}, userId, tenantId, options = {}) {
    const id = Number(orderId);
    const sku = String(body.ozon_sku || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !sku || sku.length > 128 || typeof body.ignored !== 'boolean') {
      throw Object.assign(new Error('请选择订单商品，并明确设置忽略或恢复库存绑定提醒'), { statusCode: 400 });
    }
    const tenant = await scope(tenantId, options);
    const owned = await query(`SELECT oi.id FROM order_items oi
      JOIN orders o ON o.id = oi.order_id JOIN shops s ON s.id = o.shop_id
      WHERE oi.order_id = ? AND oi.ozon_sku = ? AND ${predicate('s', tenant)} LIMIT 1`, [id, sku]);
    if (!owned.length) throw Object.assign(new Error('订单商品不存在或不属于当前企业'), { statusCode: 404 });
    const personId = await person(userId);
    await ensure();
    if (body.ignored) {
      await execute(`INSERT INTO order_inventory_binding_ignores (tenant_id, order_id, ozon_sku, person_id)
        VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE person_id = VALUES(person_id)`, [tenant.id, id, sku, personId]);
    } else {
      await execute('DELETE FROM order_inventory_binding_ignores WHERE tenant_id = ? AND order_id = ? AND ozon_sku = ?', [tenant.id, id, sku]);
    }
    invalidate();
    return { ok: true, order_id: id, ozon_sku: sku, ignored: body.ignored };
  }
  return { ensure, set };
}

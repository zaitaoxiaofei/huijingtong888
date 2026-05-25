export function syncOutboundForOpenOrders(deps) {
  const cancelledRows = deps.all(`
    SELECT oi.id AS order_item_id, oi.quantity, o.posting_number, o.shop_id,
      sm.id AS mapping_id, sm.product_id, sm.person_id, sm.online_product_id,
      p.purchase_cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE LOWER(o.status) LIKE '%cancel%'
       OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
  `);
  for (const row of cancelledRows) {
    const outboundMovement = deps.get(`
      SELECT id, product_id, shop_id, sku_mapping_id, owner_person_id, quantity_delta, unit_cost, status
      FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.order_item_id]);
    if (!outboundMovement) {
      continue;
    }
    const restoreProductId = outboundMovement.product_id || row.product_id;
    const restoreShopId = outboundMovement.shop_id || row.shop_id;
    const restoreMappingId = outboundMovement.sku_mapping_id || row.mapping_id;
    const restorePersonId = outboundMovement.owner_person_id || row.person_id;
    const restoreUnitCost = Number(outboundMovement.unit_cost || row.purchase_cost || 0);
    const restoreQuantity = Math.abs(Number(outboundMovement.quantity_delta || row.quantity || 1));
    if (!restoreProductId) continue;
    deps.db.prepare(`
      UPDATE outbound_records
      SET status = 'cancelled', reason = 'cancelled_order', note = 'Order cancelled, inventory restored'
      WHERE order_item_id = ? OR (order_item_id IS NULL AND order_ref = ? AND product_id = ?)
    `).run(row.order_item_id, row.posting_number, restoreProductId);
    deps.db.prepare(`
      UPDATE inventory_movements
      SET status = 'posted', note = 'Cancelled order outbound, restored by return movement'
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
    `).run(row.order_item_id);
    const returnSourceRef = `cancel_${row.order_item_id}`;
    const existingReturn = deps.get(`
      SELECT id, product_id
      FROM inventory_movements
      WHERE source_type = 'return_in' AND source_ref = ?
      LIMIT 1
    `, [returnSourceRef]);
    if (existingReturn) {
      deps.db.prepare(`
        UPDATE inventory_movements
        SET product_id = ?, shop_id = ?, sku_mapping_id = ?, owner_person_id = ?,
          quantity_delta = ?, unit_cost = ?, amount = ?, status = 'posted', note = 'Order cancelled, inventory restored'
        WHERE id = ?
      `).run(
        restoreProductId,
        restoreShopId,
        restoreMappingId,
        restorePersonId,
        restoreQuantity,
        restoreUnitCost,
        restoreQuantity * restoreUnitCost,
        existingReturn.id
      );
      deps.rebuildInventoryCurrentForProduct(existingReturn.product_id);
    } else {
      deps.postInventory({
        product_id: restoreProductId,
        shop_id: restoreShopId,
        sku_mapping_id: restoreMappingId,
        owner_person_id: restorePersonId,
        source_type: "return_in",
        source_ref: returnSourceRef,
        quantity_delta: restoreQuantity,
        unit_cost: restoreUnitCost,
        amount: restoreQuantity * restoreUnitCost,
        related_order_item_id: row.order_item_id,
        note: "Order cancelled, inventory restored"
      });
    }
    deps.rebuildInventoryCurrentForProduct(restoreProductId);
  }

  const rows = deps.all(`
    SELECT oi.*, o.shop_id, o.posting_number, o.status AS order_status, o.tracking_stage,
      sm.id AS mapping_id, sm.product_id, sm.person_id, sm.online_product_id,
      p.purchase_cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE LOWER(o.status) NOT LIKE '%cancel%'
      AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
  `);
  let deducted = 0;
  let pending = 0;
  for (const row of rows) {
    if (!row.mapping_id || !row.product_id) {
      deps.recordOrderException({
        store_id: row.shop_id,
        order_item_id: row.id,
        posting_number: row.posting_number,
        ozon_sku: row.ozon_sku,
        exception_type: "OUTBOUND_UNBOUND_SKU",
        message: `Order is waiting for outbound, but Ozon SKU ${row.ozon_sku} is not bound to an inventory product`
      });
      pending += 1;
      continue;
    }
    if (Number(row.sku_mapping_id || 0) !== Number(row.mapping_id)) {
      deps.db.prepare("UPDATE order_items SET sku_mapping_id = ? WHERE id = ?").run(row.mapping_id, row.id);
    }
    const existed = deps.get(`
      SELECT id, status, product_id FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.id]);
    if (existed) {
      if (existed.status !== "posted" || Number(existed.product_id) !== Number(row.product_id)) {
        deps.db.prepare(`
          UPDATE inventory_movements
          SET product_id = ?, shop_id = ?, sku_mapping_id = ?, owner_person_id = ?,
            quantity_delta = ?, unit_cost = ?, amount = ?, status = 'posted', note = 'Restored by outbound sync'
          WHERE id = ?
        `).run(
          row.product_id,
          row.shop_id,
          row.mapping_id,
          row.person_id,
          -Math.abs(Number(row.quantity || 1)),
          row.purchase_cost || row.frozen_purchase_cost || 0,
          Math.abs(Number(row.quantity || 1)) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
          existed.id
        );
        deps.rebuildInventoryCurrentForProduct(existed.product_id);
        deps.rebuildInventoryCurrentForProduct(row.product_id);
      }
      continue;
    }
    const qty = -Math.abs(Number(row.quantity || 1));
    deps.postInventory({
      product_id: row.product_id,
      shop_id: row.shop_id,
      sku_mapping_id: row.mapping_id,
      owner_person_id: row.person_id,
      source_type: "order_outbound",
      source_ref: row.posting_number,
      quantity_delta: qty,
      unit_cost: row.purchase_cost || row.frozen_purchase_cost || 0,
      amount: Math.abs(qty) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
      related_posting_number: row.posting_number,
      related_order_item_id: row.id,
      note: "Created by outbound sync"
    });
    const outboundExists = deps.get(`
      SELECT id FROM outbound_records
      WHERE (order_item_id = ? OR (order_item_id IS NULL AND order_ref = ? AND product_id = ? AND (COALESCE(ozon_sku, '') = '' OR ozon_sku = ?)))
        AND status != 'cancelled'
      LIMIT 1
    `, [row.id, row.posting_number, row.product_id, row.ozon_sku || ""]);
    if (outboundExists) {
      deps.db.prepare(`
        UPDATE outbound_records
        SET shop_id = ?, online_product_id = ?, order_item_id = ?, ozon_sku = ?, person_id = ?, quantity = ?, reason = 'order', status = 'deducted', note = 'Updated by outbound sync'
        WHERE id = ?
      `).run(row.shop_id, row.online_product_id, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), outboundExists.id);
    } else {
      deps.db.prepare(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `).run(row.product_id, row.shop_id, row.online_product_id, row.posting_number, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), "Created by outbound sync");
    }
    deps.db.prepare(`
      UPDATE order_exceptions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND posting_number = ? AND ozon_sku = ? AND exception_type IN ('UNMAPPED_SKU', 'OUTBOUND_UNBOUND_SKU')
    `).run(row.shop_id, row.posting_number, row.ozon_sku);
    deducted += 1;
  }
  return { deducted, pending };
}

export function recalculateOrderProfitsForProduct(deps, productId) {
  const product = deps.get("SELECT id FROM products WHERE id = ? AND active = 1", [Number(productId)]);
  if (!product) throw new Error("库存产品不存在或已隐藏");
  const mappings = deps.all("SELECT id FROM sku_mappings WHERE product_id = ? AND active = 1", [Number(productId)]);
  let updated = 0;
  for (const mapping of mappings) {
    updated += deps.recalculateOrderItemsForMapping(mapping.id).updated;
  }
  syncOutboundForOpenOrders(deps);
  deps.refreshProfitAnalyticsSnapshots({});
  deps.invalidateExceptionWorkbenchCache();
  const eligible = deps.get(`
    SELECT COUNT(*) AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    WHERE sm.product_id = ?
      AND sm.active = 1
      AND COALESCE(o.sync_state, 'open') != 'final'
  `, [Number(productId)])?.count || 0;
  return { ok: true, product_id: Number(productId), updated, mappings: mappings.length, scope: "open_orders_only", eligible_items: eligible };
}

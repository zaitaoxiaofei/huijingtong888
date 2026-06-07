function estimatedProfitValue(deps, { item, product, estimated, returnLossEstimate }) {
  return deps.roundMoney(
    Number(item.sale_price || 0) * Number(item.quantity || 1)
    - (Number(product.purchase_cost || 0) + Number(product.domestic_shipping || 0) + Number(estimated.freight || product.international_shipping || 0)) * Number(item.quantity || 1)
    - deps.packagingFeeForSaleAmount(Number(item.sale_price || 0) * Number(item.quantity || 1))
    - Number(estimated.commission || 0)
    - Number(estimated.paymentFee || 0)
    - Number(estimated.withdrawalFee || 0)
    - returnLossEstimate
    - Number(estimated.advertisingCost || 0)
  );
}

function persistedPlatformFee(estimated, returnLossEstimate) {
  return (estimated.commission || 0) + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + returnLossEstimate;
}

function persistRecalculatedItem(deps, { itemId, mapping, product, estimated, settlement, returnLossEstimate, estimatedProfit, quantity, salePrice, order = null, item = null }) {
  deps.db.prepare(`
    UPDATE order_items SET
      sku_mapping_id = ?,
      estimated_commission = ?,
      platform_fee_actual = CASE WHEN ? = 'accrued' AND COALESCE(actual_profit, 0) = 0 THEN ? ELSE platform_fee_actual END,
      aftersale_loss = ?,
      estimated_profit = ?,
      actual_profit = CASE WHEN ? = 'accrued' THEN ? ELSE 0 END,
      settlement_state = ?
    WHERE id = ?
  `).run(
    mapping.id,
    estimated.commission || 0,
    settlement,
    persistedPlatformFee(estimated, returnLossEstimate),
    returnLossEstimate,
    estimatedProfit,
    settlement,
    estimatedProfit,
    settlement,
    itemId
  );
  deps.saveProfitItem({
    orderItemId: itemId,
    product,
    estimated,
    quantity,
    salePrice,
    settlement,
    order,
    item
  });
  deps.syncOrderItemProfitFromBreakdown(itemId, settlement);
}

export function recalculateOrderItemsForMapping(deps, mappingId) {
  const mapping = deps.get(`
    SELECT sm.*, op.commissions_json AS commissions_json
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    WHERE sm.id = ? AND sm.active = 1
  `, [Number(mappingId)]);
  if (!mapping) return { updated: 0 };
  const product = deps.get("SELECT * FROM products WHERE id = ?", [mapping.product_id]);
  if (!product) return { updated: 0 };
  const rows = deps.all(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.shop_id = ? AND oi.ozon_sku = ?
      AND COALESCE(o.sync_state, 'open') != 'final'
  `, [mapping.shop_id, mapping.ozon_sku]);
  let updated = 0;
  for (const item of rows) {
    const estimated = deps.estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = deps.resolveProfitSettlementStatus(item);
    const returnLossEstimate = deps.estimateOrderItemReturnLoss({ order: null, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price });
    const estimatedProfit = estimatedProfitValue(deps, { item, product, estimated, returnLossEstimate });
    persistRecalculatedItem(deps, {
      itemId: item.id,
      mapping,
      product,
      estimated,
      settlement,
      returnLossEstimate,
      estimatedProfit,
      quantity: item.quantity,
      salePrice: item.sale_price,
      item
    });
    updated += 1;
  }
  return { updated };
}

export function recalculateOrderProfit(deps, orderId) {
  const order = deps.get("SELECT * FROM orders WHERE id = ?", [Number(orderId)]);
  if (!order) throw new Error("订单不存在");
  const rows = deps.all(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.order_id = ?
  `, [Number(orderId)]);
  let updated = 0;
  let unbound = 0;
  for (const item of rows) {
    const mapping = deps.get(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.active = 1
        AND sm.shop_id = ?
        AND sm.ozon_sku = ?
      ORDER BY CASE WHEN sm.id = ? THEN 0 ELSE 1 END, sm.id DESC
      LIMIT 1
    `, [order.shop_id, item.ozon_sku, Number(item.sku_mapping_id || 0)]);
    if (!mapping) {
      unbound += 1;
      continue;
    }
    const product = deps.get("SELECT * FROM products WHERE id = ? AND active = 1", [mapping.product_id]);
    if (!product) {
      unbound += 1;
      continue;
    }
    const estimated = deps.estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = deps.resolveProfitSettlementStatus({ ...order, ...item });
    const returnLossEstimate = deps.estimateOrderItemReturnLoss({ order, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price });
    const estimatedProfit = estimatedProfitValue(deps, { item, product, estimated, returnLossEstimate });
    persistRecalculatedItem(deps, {
      itemId: item.id,
      mapping,
      product,
      estimated,
      settlement,
      returnLossEstimate,
      estimatedProfit,
      quantity: item.quantity,
      salePrice: item.sale_price,
      order,
      item
    });
    updated += 1;
  }
  deps.syncOutboundForOpenOrders();
  const orderedDateKey = deps.chinaDateKey(order.ordered_at);
  if (orderedDateKey) deps.refreshProfitAnalyticsSnapshots({ from: orderedDateKey, to: orderedDateKey });
  return { ok: true, updated, unbound };
}

export function recalculateAllMappedOrderProfits(deps) {
  const mappings = deps.all("SELECT id FROM sku_mappings WHERE active = 1");
  let updated = 0;
  for (const mapping of mappings) {
    updated += recalculateOrderItemsForMapping(deps, mapping.id).updated;
  }
  const eligible = deps.get(`
    SELECT COUNT(*) AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE COALESCE(o.sync_state, 'open') != 'final'
  `)?.count || 0;
  return { updated, mappings: mappings.length, scope: "open_orders_only", eligible_items: eligible };
}

export function recalculateHistoricalOrderProfits(deps, body = {}) {
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const onlyFinal = Number(body.only_final ?? 1) !== 0;
  const onlyWithFinance = Number(body.only_with_finance ?? 1) !== 0;
  const filters = [];
  const params = [];

  if (from) {
    filters.push(`${deps.chinaDateSql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    filters.push(`${deps.chinaDateSql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  if (onlyFinal) filters.push("COALESCE(o.sync_state, 'open') = 'final'");
  if (onlyWithFinance) {
    filters.push(`EXISTS (
      SELECT 1
      FROM ozon_finance_items ofi
      WHERE ofi.shop_id = o.shop_id
        AND ofi.posting_number = o.posting_number
    )`);
  }

  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orders = deps.all(`
    SELECT o.id, ${deps.chinaDateSql("o.ordered_at")} AS order_date
    FROM orders o
    ${whereSql}
    ORDER BY ${deps.chinaDateSql("o.ordered_at")} ASC, o.id ASC
  `, params);

  let updatedOrders = 0;
  let updatedItems = 0;
  let unbound = 0;
  const dateKeys = new Set();
  for (const order of orders) {
    const result = recalculateOrderProfit(deps, order.id);
    updatedOrders += 1;
    updatedItems += Number(result.updated || 0);
    unbound += Number(result.unbound || 0);
    if (order.order_date) dateKeys.add(order.order_date);
  }

  const applied = deps.reapplySyncedOzonFinance({ from, to });
  if (dateKeys.size) {
    const sortedDates = [...dateKeys].sort();
    deps.refreshProfitAnalyticsSnapshots({
      from: from || sortedDates[0],
      to: to || sortedDates[sortedDates.length - 1]
    });
  } else if (from || to) {
    deps.refreshProfitAnalyticsSnapshots({ from, to });
  }
  deps.invalidateExceptionWorkbenchCache();
  return {
    ok: true,
    scope: onlyFinal ? "final_orders" : "all_orders",
    only_with_finance: onlyWithFinance,
    from,
    to,
    orders: orders.length,
    updated_orders: updatedOrders,
    updated_items: updatedItems,
    unbound,
    finance_reapplied: applied
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(reason || "本次拉取已取消");
}

function executeStatement(deps, sql, params = []) {
  if (typeof deps.execute === "function") {
    return deps.execute(sql, params);
  }
  return deps.db.prepare(sql).run(...params);
}

function insertAndGetId(deps, sql, params = []) {
  if (typeof deps.insertAndGetId === "function") {
    return Number(deps.insertAndGetId(sql, params));
  }
  return Number(deps.db.prepare(sql).run(...params).lastInsertRowid);
}

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

function emptySyncAggregate(mode, from, to) {
  return { mode, inserted: 0, updated: 0, fetched: 0, requests: 0, from, to, shops: [], errors: [] };
}

function normalizeSyncDateTime(value) {
  if (!value) return "";
  const raw = String(value);
  const date = new Date(raw.includes("T") ? raw : `${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function normalizeShanghaiDateBoundary(value, boundary = "start") {
  if (!value) return "";
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
  const date = new Date(`${raw}T${time}+08:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function latestOrderSyncStart(deps, shopId, fallbackFrom, overlapMinutes = 15) {
  const latest = deps.get("SELECT ordered_at FROM orders WHERE shop_id = ? ORDER BY ordered_at DESC LIMIT 1", [shopId]);
  const latestDate = latest?.ordered_at ? new Date(latest.ordered_at) : null;
  if (!latestDate || Number.isNaN(latestDate.getTime())) return fallbackFrom;
  const overlapMs = Math.min(Math.max(Number(overlapMinutes || 0), 0), 24 * 60) * 60 * 1000;
  return new Date(latestDate.getTime() - overlapMs).toISOString();
}

function mergeSyncAggregate(target, result, reason) {
  target.inserted += Number(result.inserted || 0);
  target.updated += Number(result.updated || 0);
  target.fetched += Number(result.fetched || 0);
  target.requests += Number(result.requests || 0);
  target.errors.push(...(result.errors || []));
  for (const shop of result.shops || []) target.shops.push({ ...shop, reason });
}

function saveRawPosting(deps, shop, posting) {
  executeStatement(deps, `
    INSERT INTO ozon_orders_raw (store_id, posting_number, order_id, status, substatus, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, posting_number) DO UPDATE SET
      order_id = excluded.order_id,
      status = excluded.status,
      substatus = excluded.substatus,
      raw_json = excluded.raw_json,
      fetched_at = CURRENT_TIMESTAMP
  `, [
    shop.id,
    posting.posting_number,
    posting.order_id || posting.order_number || "",
    posting.status || "",
    posting.substatus || posting.logistics_status || "",
    JSON.stringify(posting)
  ]);
}

function accrueDeliveredItems(deps, orderId) {
  const order = deps.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order || order.status !== "delivered") return;
  executeStatement(deps, `
    UPDATE order_items
    SET actual_profit = 0,
      settlement_state = CASE WHEN COALESCE(settlement_state, '') = 'accrued' THEN settlement_state ELSE 'pending' END
    WHERE order_id = ?
      AND COALESCE(settlement_state, '') != 'accrued'
  `, [orderId]);
  executeStatement(deps, `
    UPDATE order_profit_items
    SET profit_status = CASE WHEN COALESCE(profit_status, '') = 'accrued' THEN profit_status ELSE 'estimated' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE order_item_id IN (
      SELECT id FROM order_items WHERE order_id = ?
    )
      AND COALESCE(profit_status, '') != 'accrued'
  `, [orderId]);
}

function upsertOnlineProductFromOrderItem(deps, shop, item) {
  if (!item?.ozon_sku) return null;
  const existing = deps.get("SELECT * FROM online_products WHERE shop_id = ? AND ozon_sku = ?", [shop.id, item.ozon_sku]);
  if (existing) {
    executeStatement(deps, `
      UPDATE online_products
      SET offer_id = COALESCE(NULLIF(?, ''), offer_id),
        ozon_product_id = COALESCE(NULLIF(?, ''), ozon_product_id),
        name = CASE WHEN name = '' OR name LIKE 'Ozon product %' THEN COALESCE(NULLIF(?, ''), name) ELSE name END,
        image_url = COALESCE(NULLIF(?, ''), image_url),
        primary_image = COALESCE(NULLIF(?, ''), primary_image),
        sale_price = CASE WHEN sale_price = 0 THEN ? ELSE sale_price END,
        published_at = COALESCE(published_at, NULLIF(?, '')),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [item.offer_id || "", item.ozon_product_id || "", item.name || "", item.image_url || "", item.image_url || "", Number(item.sale_price || 0), item.published_at || item.created_at || "", existing.id]);
    return existing;
  }
  const onlineProductId = insertAndGetId(deps, `
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price, currency_code, status, visibility, raw_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUB', 'historical', 'order_snapshot', ?, ?)
  `, [
    shop.id,
    item.ozon_sku,
    item.offer_id || "",
    item.ozon_product_id || "",
    item.name || `Ozon SKU ${item.ozon_sku}`,
    item.image_url || "",
    item.image_url || "",
    Number(item.sale_price || 0),
    JSON.stringify(item),
    item.published_at || item.created_at || ""
  ]);
  return { id: onlineProductId, shop_id: shop.id, ozon_sku: item.ozon_sku };
}

function orderLifecycle(posting) {
  const statusText = `${posting.status || ""} ${posting.substatus || ""} ${posting.tracking_stage || ""}`.toLowerCase();
  const orderedAt = new Date(posting.ordered_at);
  const safeOrderedAt = Number.isNaN(orderedAt.getTime()) ? new Date() : orderedAt;
  const ageDays = Math.floor((Date.now() - safeOrderedAt.getTime()) / (24 * 60 * 60 * 1000));
  const isCancelled = statusText.includes("cancel");
  const isDelivered = statusText.includes("delivered") || statusText.includes("签收");
  if (isCancelled) {
    return { syncState: "final", finalizedAt: new Date().toISOString(), note: "cancelled order archived" };
  }
  if (isDelivered && ageDays >= 45) {
    return { syncState: "final", finalizedAt: new Date().toISOString(), note: "delivered order older than 45 days archived" };
  }
  if (!isDelivered && ageDays >= 60) {
    return { syncState: "exception", finalizedAt: null, note: "open logistics order older than 60 days" };
  }
  return { syncState: "open", finalizedAt: null, note: "" };
}

function isQualityPosting(deps, posting) {
  const postingNumber = String(posting.posting_number || posting.order_number || "").trim();
  if (!postingNumber) return false;
  return deps.orderQualityPrefixes().some((prefix) => postingNumber.startsWith(prefix));
}

function orderCancelLossApplies(deps, posting) {
  if (typeof deps.classifyOrderAccounting === "function") {
    return deps.classifyOrderAccounting(posting, { qualityPrefixes: deps.orderQualityPrefixes() }).loss_profile_code !== "none";
  }
  if (isQualityPosting(deps, posting)) return false;
  const outcome = deps.classifyOrderOutcome(posting);
  const cancellation = deps.describeCancellation({ ...posting, outcome_type: outcome });
  const profile = deps.resolveOrderLossProfile({ ...posting, outcome_type: outcome, ...cancellation });
  return profile.code !== "none";
}

function upsertPosting(deps, shop, posting) {
  saveRawPosting(deps, shop, posting);
  const exists = deps.get("SELECT * FROM orders WHERE shop_id = ? AND posting_number = ?", [shop.id, posting.posting_number])
    || deps.get("SELECT * FROM orders WHERE posting_number = ?", [posting.posting_number]);
  let orderId = exists?.id;
  const lifecycle = orderLifecycle(posting);
  const cancelLossApplies = orderCancelLossApplies(deps, posting);
  let inserted = 0;
  let updated = 0;
  if (!orderId) {
    orderId = insertAndGetId(deps, `
      INSERT INTO orders
      (shop_id, posting_number, order_number, status, logistics_status, tracking_stage, ordered_at, delivered_at, accrued_at,
       buyer_region, tracking_number, external_tracking_url, cancel_reason_id, cancel_reason, cancel_initiator, cancel_type,
       cancelled_after_ship, cancel_loss_applies, sync_state, finalized_at, last_synced_at, last_status_changed_at, sync_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `, [
      shop.id,
      posting.posting_number,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      posting.ordered_at,
      posting.delivered_at,
      posting.status === "delivered" ? posting.delivered_at : null,
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      lifecycle.finalizedAt,
      lifecycle.note
    ]);
    inserted = 1;
  } else {
    const statusChanged = String(exists.status || "") !== String(posting.status || "") || String(exists.tracking_stage || "") !== String(posting.tracking_stage || posting.status || "");
    executeStatement(deps, `
      UPDATE orders SET
        shop_id = ?, order_number = ?, status = ?, logistics_status = ?, tracking_stage = ?,
        delivered_at = COALESCE(?, delivered_at), buyer_region = ?, tracking_number = ?,
        external_tracking_url = ?, cancel_reason_id = ?, cancel_reason = ?, cancel_initiator = ?, cancel_type = ?,
        cancelled_after_ship = ?, cancel_loss_applies = ?, sync_state = ?, finalized_at = COALESCE(finalized_at, ?),
        last_synced_at = CURRENT_TIMESTAMP,
        last_status_changed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_status_changed_at END,
        sync_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      shop.id,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      posting.delivered_at,
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      lifecycle.finalizedAt,
      statusChanged ? 1 : 0,
      lifecycle.note,
      orderId
    ]);
    updated = 1;
  }

  let insertedItems = 0;
  for (const item of posting.items || []) {
    upsertOnlineProductFromOrderItem(deps, shop, item);
    const mapping = deps.get(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    `, [shop.id, item.ozon_sku]);
    const product = mapping ? deps.get("SELECT * FROM products WHERE id = ?", [mapping.product_id]) : null;
    const existingItem = deps.get("SELECT id, quantity FROM order_items WHERE order_id = ? AND ozon_sku = ?", [orderId, item.ozon_sku]);
    if (existingItem) {
      const previousQuantity = Number(existingItem.quantity || 0);
      const nextQuantity = Number(item.quantity || 1);
      executeStatement(deps, `
        UPDATE order_items
        SET sku_mapping_id = COALESCE(?, sku_mapping_id),
          ozon_name = COALESCE(NULLIF(?, ''), ozon_name),
          ozon_image_url = COALESCE(NULLIF(?, ''), ozon_image_url),
          ozon_product_id = COALESCE(NULLIF(?, ''), ozon_product_id),
          quantity = ?,
          sale_price = ?
        WHERE id = ?
      `, [mapping?.id || null, item.name || "", item.image_url || "", item.ozon_product_id || "", nextQuantity, item.sale_price, existingItem.id]);
      if (product && mapping && previousQuantity !== nextQuantity) {
        const quantityDelta = previousQuantity - nextQuantity;
        deps.postInventory({
          product_id: product.id,
          shop_id: shop.id,
          sku_mapping_id: mapping.id,
          owner_person_id: mapping.person_id,
          source_type: "order_outbound_adjustment",
          source_ref: posting.posting_number,
          quantity_delta: quantityDelta,
          unit_cost: product.purchase_cost,
          amount: Math.abs(quantityDelta) * Number(product.purchase_cost || 0),
          related_posting_number: posting.posting_number,
          related_order_item_id: existingItem.id,
          note: "Ozon order item quantity changed during sync"
        });
        executeStatement(deps, `
          UPDATE outbound_records
          SET quantity = ?, note = ?
          WHERE order_item_id = ? AND status = 'deducted'
        `, [nextQuantity, "Updated by Ozon sync", existingItem.id]);
      }
      continue;
    }
    const estimated = product && mapping ? deps.estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping }) : { commission: 0, profit: 0 };
    const settlement = deps.resolveProfitSettlementStatus(posting);
    const returnLossEstimate = product && mapping
      ? deps.estimateOrderItemReturnLoss({ order: posting, item, product, estimated, quantity: item.quantity, salePrice: item.sale_price })
      : 0;
    const estimatedProfit = product && mapping
      ? estimatedProfitValue(deps, { item, product, estimated, returnLossEstimate })
      : 0;

    const orderItemId = insertAndGetId(deps, `
      INSERT INTO order_items
      (order_id, sku_mapping_id, ozon_sku, ozon_name, ozon_image_url, ozon_product_id, quantity, sale_price, frozen_purchase_cost, frozen_domestic_shipping,
       frozen_international_shipping, frozen_handling_fee, estimated_commission, platform_fee_actual, aftersale_loss,
        estimated_profit, actual_profit, settlement_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId,
      mapping?.id || null,
      item.ozon_sku,
      item.name || "",
      item.image_url || "",
      item.ozon_product_id || "",
      item.quantity,
      item.sale_price,
      product?.purchase_cost || 0,
      product?.domestic_shipping || 0,
      estimated.freight || product?.international_shipping || 0,
      product?.handling_fee || 0,
      estimated.commission,
      settlement === "accrued" ? estimated.commission + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + returnLossEstimate : 0,
      0,
      estimatedProfit,
      settlement === "accrued" ? estimatedProfit : 0,
      settlement
    ]);

    if (!mapping) {
      deps.recordOrderException({
        store_id: shop.id,
        order_item_id: orderItemId,
        posting_number: posting.posting_number,
        ozon_sku: item.ozon_sku,
        exception_type: "UNMAPPED_SKU",
        message: `Ozon SKU ${item.ozon_sku} is not bound to a real product`
      });
    }

    if (product && mapping) {
      deps.saveProfitItem({
        orderItemId,
        product,
        estimated,
        quantity: item.quantity,
        salePrice: item.sale_price,
        settlement,
        order: posting,
        item
      });
      deps.syncOrderItemProfitFromBreakdown(orderItemId, settlement);
      const qty = -Number(item.quantity);
      deps.postInventory({
        product_id: product.id,
        shop_id: shop.id,
        sku_mapping_id: mapping.id,
        owner_person_id: mapping.person_id,
        source_type: "order_outbound",
        source_ref: posting.posting_number,
        quantity_delta: qty,
        unit_cost: product.purchase_cost,
        amount: Math.abs(qty) * product.purchase_cost,
        related_posting_number: posting.posting_number,
        related_order_item_id: orderItemId,
        note: "Ozon order outbound"
      });
      executeStatement(deps, `
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `, [product.id, shop.id, mapping.online_product_id, posting.posting_number, orderItemId, item.ozon_sku, mapping.person_id, item.quantity, "Created by Ozon sync"]);
    }
    insertedItems += 1;
  }
  accrueDeliveredItems(deps, orderId);
  return { inserted, updated, insertedItems };
}

export async function syncDemoOrders(deps, body = {}, options = {}) {
  const targetShopId = deps.nullable(body.shop_id);
  const activeShops = deps.shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  const rawFrom = body.from || body.date_from || body.dateFrom;
  const rawTo = body.to || body.date_to || body.dateTo;
  const rawFromDateTime = body.from_datetime || body.fromDateTime || "";
  const rawToDateTime = body.to_datetime || body.toDateTime || "";
  const statuses = Array.isArray(body.statuses)
    ? body.statuses.map((item) => String(item || "").trim()).filter(Boolean)
    : String(body.status || "").split(",").map((item) => item.trim()).filter(Boolean);
  const from = deps.normalizeSyncDate(rawFromDateTime || rawFrom);
  const to = deps.normalizeSyncDate(rawToDateTime || rawTo);
  const fetchFrom = normalizeSyncDateTime(rawFromDateTime) || normalizeShanghaiDateBoundary(rawFrom, "start") || from;
  const fetchTo = normalizeSyncDateTime(rawToDateTime) || normalizeShanghaiDateBoundary(rawTo, "end") || to;
  if (from && to && from > to) throw new Error("结束日期不能早于开始日期");
  throwIfAborted(options.signal);
  let inserted = 0;
  let updated = 0;
  let fetched = 0;
  let requests = 0;
  const shopResults = [];
  const errors = [];
  for (const shop of activeShops) {
    try {
      throwIfAborted(options.signal);
      const result = await deps.fetchOzonPostings(shop, { from: fetchFrom, to: fetchTo, statuses, chunkDays: 14, signal: options.signal });
      throwIfAborted(options.signal);
      const postings = Array.isArray(result) ? result : result.postings || [];
      const shopStats = {
        shop_id: shop.id,
        shop_name: shop.name,
        fetched: postings.length,
        inserted: 0,
        updated: 0,
        inserted_items: 0,
        requests: result.requests || 0,
        ranges: result.ranges || 0
      };
      fetched += postings.length;
      requests += result.requests || 0;
      for (const posting of postings) {
        throwIfAborted(options.signal);
        const stats = upsertPosting(deps, shop, posting);
        shopStats.inserted += stats.inserted;
        shopStats.updated += stats.updated;
        shopStats.inserted_items += stats.insertedItems;
      }
      inserted += shopStats.inserted_items;
      updated += shopStats.updated;
      shopResults.push(shopStats);
      deps.invalidateExceptionWorkbenchCache();
    } catch (error) {
      const message = `${shop.name}: ${error.message}`;
      errors.push(message);
      shopResults.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message });
    }
  }
  const status = errors.length ? "partial_error" : "ok";
  const message = `Range ${from || "last_30_days"}~${to || "now"}; fetched ${fetched}, inserted item(s) ${inserted}, updated order(s) ${updated}, requests ${requests}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  executeStatement(deps, "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders', ?, ?)", [status, message]);
  deps.syncOutboundForOpenOrders();
  deps.refreshProfitAnalyticsSnapshots({ from: from || "", to: to || "" });
  deps.invalidateExceptionWorkbenchCache();
  if (errors.length && fetched === 0) throw new Error(errors.join(" | "));
  return { inserted, updated, fetched, requests, from: from || "", to: to || "", shops: shopResults, errors };
}

export async function syncOzonIncrementalOrders(deps, body = {}, options = {}) {
  const targetShopId = deps.nullable(body.shop_id);
  const activeShops = deps.shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  const fromLatest = body.from_latest === true || body.fromLatest === true || body.mode === "new";
  const recentDays = Math.min(Math.max(Number(body.recent_days || body.fallback_days || 7), 1), 60);
  const overlapMinutes = Math.min(Math.max(Number(body.overlap_minutes || 15), 0), 24 * 60);
  const to = deps.todayDateKey();
  const recentFrom = deps.dateKeyDaysAgo(recentDays);
  const aggregate = emptySyncAggregate(fromLatest ? "new_orders" : "incremental", fromLatest ? "latest_local_order" : recentFrom, to);

  for (const shop of activeShops) {
    throwIfAborted(options.signal);
    const start = fromLatest ? latestOrderSyncStart(deps, shop.id, recentFrom, overlapMinutes) : recentFrom;
    const ranges = [{ from: start, to, reason: fromLatest ? "latest" : "recent" }];
    const seen = new Set();
    for (const range of ranges) {
      throwIfAborted(options.signal);
      const key = `${range.from}~${range.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const result = await syncDemoOrders(deps, fromLatest ? {
          shop_id: shop.id,
          from_datetime: start,
          to
        } : {
          shop_id: shop.id,
          from: range.from,
          to: range.to
        }, options);
        mergeSyncAggregate(aggregate, result, range.reason || "open");
      } catch (error) {
        aggregate.errors.push(`${shop.name} ${range.from}~${range.to}: ${error.message}`);
        aggregate.shops.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message, reason: range.reason || "open" });
      }
    }
  }

  const status = aggregate.errors.length ? "partial_error" : "ok";
  const message = `Incremental sync; fetched ${aggregate.fetched}, inserted item(s) ${aggregate.inserted}, updated order(s) ${aggregate.updated}, requests ${aggregate.requests}${aggregate.errors.length ? `; ${aggregate.errors.join(" | ")}` : ""}`;
  executeStatement(deps, "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders_incremental', ?, ?)", [status, message]);
  deps.invalidateExceptionWorkbenchCache();
  if (aggregate.errors.length && aggregate.fetched === 0) throw new Error(aggregate.errors.join(" | "));
  return aggregate;
}

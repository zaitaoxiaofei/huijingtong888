function historicalReviewBaseFilters({ from = "", to = "", onlyFinal = true, reviewStatus = "all" } = {}) {
  const filters = [
    "COALESCE(opi.return_loss_cny, 0) > 0",
    "COALESCE(o.cancel_reason, '') = ''",
    "COALESCE(o.cancel_type, '') = ''",
    "COALESCE(o.cancel_initiator, '') = ''",
    "(COALESCE(o.status, '') = 'delivered' OR COALESCE(o.delivered_at, '') != '' OR COALESCE(o.accrued_at, '') != '' OR COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued')"
  ];
  const params = [];
  if (from) {
    filters.push("substr(o.ordered_at, 1, 10) >= ?");
    params.push(from);
  }
  if (to) {
    filters.push("substr(o.ordered_at, 1, 10) <= ?");
    params.push(to);
  }
  if (onlyFinal) filters.push("COALESCE(o.sync_state, 'open') = 'final'");
  if (reviewStatus === "pending") filters.push("COALESCE(hpr.review_status, 'pending') = 'pending'");
  if (reviewStatus === "kept") filters.push("COALESCE(hpr.review_status, 'pending') = 'kept'");
  if (reviewStatus === "cleared") filters.push("COALESCE(hpr.review_status, 'pending') = 'cleared'");
  return { filters, params };
}

function historicalReviewBucket(row = {}) {
  const financeRows = Number(row.finance_rows || 0);
  const financeAftersaleRows = Number(row.finance_aftersale_rows || 0);
  if (financeAftersaleRows > 0) return "finance_aftersale_present";
  if (financeRows > 0) return "finance_present_without_aftersale";
  if (String(row.profit_status || "") === "accrued" || String(row.status || "") === "delivered") return "delivered_without_finance";
  return "status_mismatch";
}

function historicalReviewBucketLabel(bucket = "") {
  return {
    finance_aftersale_present: "已有真实售后财务",
    finance_present_without_aftersale: "有财务但无售后项",
    delivered_without_finance: "已签收但无财务售后",
    status_mismatch: "状态待人工判断"
  }[bucket] || "待人工判断";
}

function historicalReviewOrderItemIds(body = {}) {
  const list = Array.isArray(body.order_item_ids) ? body.order_item_ids : [];
  return [...new Set(list.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

function executeStatement(deps, sql, params = []) {
  if (typeof deps.execute === "function") {
    return deps.execute(sql, params);
  }
  return deps.db.prepare(sql).run(...params);
}

function executeBatchStatements(deps, statements = []) {
  for (const statement of statements) {
    executeStatement(deps, statement.sql, statement.params || []);
  }
}

function runInTransaction(deps, callback) {
  if (typeof deps.runInTransaction === "function") {
    return deps.runInTransaction(callback);
  }
  deps.db.exec("BEGIN");
  try {
    const result = callback();
    deps.db.exec("COMMIT");
    return result;
  } catch (error) {
    deps.db.exec("ROLLBACK");
    throw error;
  }
}

function upsertHistoricalProfitReview(deps, orderItemId, reviewStatus, note = "", userId = null) {
  executeStatement(deps, `
    INSERT INTO historical_profit_reviews (order_item_id, review_status, note, updated_by_person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(order_item_id) DO UPDATE SET
      review_status = excluded.review_status,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `, [Number(orderItemId), reviewStatus, String(note || "").trim(), deps.nullable(userId)]);
}

function recalculateNetProfitWithoutReturnLoss(deps, row = {}) {
  return deps.roundMoney(
    Number(row.sale_amount_cny || 0)
    - Number(row.purchase_cost_cny || 0)
    - Number(row.domestic_shipping_cny || 0)
    - Number(row.international_shipping_cny || 0)
    - Number(row.packaging_cost_cny || 0)
    - Number(row.commission_fee_cny || 0)
    - Number(row.ozon_service_fee_cny || 0)
    - Number(row.advertising_cost_cny || 0)
    - Number(row.other_fee_cny || 0)
  );
}

function historicalReviewRowsSql(whereSql, limitSql = "") {
  return `
    SELECT
      o.id AS order_id,
      oi.id AS order_item_id,
      substr(o.ordered_at, 1, 10) AS order_date,
      o.ordered_at,
      o.delivered_at,
      o.accrued_at,
      o.posting_number,
      o.status,
      o.tracking_stage,
      COALESCE(o.sync_state, 'open') AS sync_state,
      s.name AS shop_name,
      oi.ozon_sku,
      COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '未命名商品') AS ozon_name,
      oi.quantity,
      COALESCE(NULLIF(p.name, ''), '') AS product_name,
      COALESCE(NULLIF(p.code, ''), '') AS product_code,
      COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(p.image_url, ''), '') AS image_url,
      COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS sale_amount_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS net_profit_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS profit_status,
      COALESCE(hpr.review_status, 'pending') AS review_status,
      COALESCE(hpr.note, '') AS review_note,
      hpr.updated_at AS review_updated_at,
      COALESCE(fin.finance_rows, 0) AS finance_rows,
      COALESCE(fin.finance_aftersale_rows, 0) AS finance_aftersale_rows,
      COALESCE(fin.finance_service_names, '') AS finance_service_names
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN historical_profit_reviews hpr ON hpr.order_item_id = oi.id
    LEFT JOIN (
      SELECT
        shop_id,
        posting_number,
        COUNT(*) AS finance_rows,
        SUM(CASE
          WHEN LOWER(COALESCE(service_type, '')) LIKE '%return%'
            OR LOWER(COALESCE(service_name, '')) LIKE '%return%'
            OR LOWER(COALESCE(service_name, '')) LIKE '%возврат%'
            OR LOWER(COALESCE(service_name, '')) LIKE '%недовлож%'
          THEN 1 ELSE 0 END) AS finance_aftersale_rows,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(service_name, ''), service_type)) AS finance_service_names
      FROM ozon_finance_items
      GROUP BY shop_id, posting_number
    ) fin ON fin.shop_id = o.shop_id AND fin.posting_number = o.posting_number
    ${whereSql}
    ORDER BY
      CASE COALESCE(hpr.review_status, 'pending')
        WHEN 'pending' THEN 0
        WHEN 'kept' THEN 1
        WHEN 'cleared' THEN 2
        ELSE 3
      END ASC,
      COALESCE(opi.return_loss_cny, 0) DESC,
      o.ordered_at DESC,
      oi.id DESC
    ${limitSql}
  `;
}

function refreshHistoricalReviewDerivedFields(rows = []) {
  return rows.map((row) => {
    const bucket = historicalReviewBucket(row);
    return {
      ...row,
      bucket,
      bucket_label: historicalReviewBucketLabel(bucket)
    };
  });
}

function refreshHistoricalReviewArtifacts(deps, dateKeys = [], fallbackRange = {}) {
  if (dateKeys.length) {
    const sortedDates = [...new Set(dateKeys.filter(Boolean))].sort();
    deps.refreshProfitAnalyticsSnapshots({
      from: fallbackRange.from || sortedDates[0],
      to: fallbackRange.to || sortedDates[sortedDates.length - 1]
    });
  } else if (fallbackRange.from || fallbackRange.to) {
    deps.refreshProfitAnalyticsSnapshots({ from: fallbackRange.from || "", to: fallbackRange.to || "" });
  }
  deps.invalidateExceptionWorkbenchCache();
}

export function historicalProfitReview(deps, query = {}) {
  const from = String(query.from || "").trim();
  const to = String(query.to || "").trim();
  const onlyFinal = Number(query.only_final ?? 1) !== 0;
  const reviewStatus = String(query.review_status || "all").trim() || "all";
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  const { filters, params } = historicalReviewBaseFilters({ from, to, onlyFinal, reviewStatus });
  const whereSql = `WHERE ${filters.join(" AND ")}`;

  const summary = deps.get(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(opi.return_loss_cny), 0) AS total_return_loss_cny,
      SUM(CASE WHEN COALESCE(hpr.review_status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_rows,
      SUM(CASE WHEN COALESCE(hpr.review_status, 'pending') = 'kept' THEN 1 ELSE 0 END) AS kept_rows,
      SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM ozon_finance_items ofi
        WHERE ofi.shop_id = o.shop_id
          AND ofi.posting_number = o.posting_number
      ) THEN 1 ELSE 0 END) AS finance_rows
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN historical_profit_reviews hpr ON hpr.order_item_id = oi.id
    ${whereSql}
  `, params) || {};

  const rows = refreshHistoricalReviewDerivedFields(
    deps.all(historicalReviewRowsSql(whereSql, "LIMIT ?"), [...params, limit])
  );
  const bucketSummary = rows.reduce((acc, row) => {
    acc[row.bucket] = Number(acc[row.bucket] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    from,
    to,
    only_final: onlyFinal,
    review_status: reviewStatus,
    limit,
    summary: {
      total_rows: Number(summary.total_rows || 0),
      order_count: Number(summary.order_count || 0),
      total_return_loss_cny: deps.roundMoney(summary.total_return_loss_cny || 0),
      pending_rows: Number(summary.pending_rows || 0),
      kept_rows: Number(summary.kept_rows || 0),
      finance_rows: Number(summary.finance_rows || 0),
      bucket_summary: bucketSummary
    },
    rows
  };
}

export function cleanupHistoricalDeliveredReturnLoss(deps, body = {}) {
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const onlyFinal = Number(body.only_final ?? 1) !== 0;
  const filters = [
    "COALESCE(opi.return_loss_cny, 0) > 0",
    "COALESCE(o.cancel_reason, '') = ''",
    "COALESCE(o.cancel_type, '') = ''",
    "COALESCE(o.cancel_initiator, '') = ''",
    "(COALESCE(o.status, '') = 'delivered' OR COALESCE(o.delivered_at, '') != '' OR COALESCE(o.accrued_at, '') != '' OR COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued')",
    `NOT EXISTS (
      SELECT 1
      FROM ozon_finance_items ofi
      WHERE ofi.shop_id = o.shop_id
        AND ofi.posting_number = o.posting_number
        AND (
          LOWER(COALESCE(ofi.service_type, '')) LIKE '%return%'
          OR LOWER(COALESCE(ofi.service_name, '')) LIKE '%return%'
          OR LOWER(COALESCE(ofi.service_name, '')) LIKE '%возврат%'
          OR LOWER(COALESCE(ofi.service_name, '')) LIKE '%недовлож%'
        )
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM historical_profit_reviews hpr
      WHERE hpr.order_item_id = oi.id
        AND hpr.review_status = 'kept'
    )`
  ];
  const params = [];

  if (from) {
    filters.push("substr(o.ordered_at, 1, 10) >= ?");
    params.push(from);
  }
  if (to) {
    filters.push("substr(o.ordered_at, 1, 10) <= ?");
    params.push(to);
  }
  if (onlyFinal) filters.push("COALESCE(o.sync_state, 'open') = 'final'");

  const rows = deps.all(`
    SELECT o.id AS order_id,
      substr(o.ordered_at, 1, 10) AS order_date,
      oi.id AS order_item_id,
      COALESCE(opi.sale_amount_cny, 0) AS sale_amount_cny,
      COALESCE(opi.purchase_cost_cny, 0) AS purchase_cost_cny,
      COALESCE(opi.domestic_shipping_cny, 0) AS domestic_shipping_cny,
      COALESCE(opi.international_shipping_cny, 0) AS international_shipping_cny,
      COALESCE(opi.packaging_cost_cny, 0) AS packaging_cost_cny,
      COALESCE(opi.commission_fee_cny, 0) AS commission_fee_cny,
      COALESCE(opi.ozon_service_fee_cny, 0) AS ozon_service_fee_cny,
      COALESCE(opi.advertising_cost_cny, 0) AS advertising_cost_cny,
      COALESCE(opi.other_fee_cny, 0) AS other_fee_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS settlement_state
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    WHERE ${filters.join(" AND ")}
    ORDER BY substr(o.ordered_at, 1, 10) ASC, o.id ASC, oi.id ASC
  `, params);

  if (!rows.length) {
    return { ok: true, from, to, only_final: onlyFinal, updated_items: 0, updated_orders: 0, cleared_return_loss_cny: 0 };
  }

  let updatedItems = 0;
  let clearedReturnLoss = 0;
  const updatedOrders = new Set();
  const dateKeys = new Set();

  runInTransaction(deps, () => {
    for (const row of rows) {
      const nextProfit = recalculateNetProfitWithoutReturnLoss(deps, row);
      executeBatchStatements(deps, [
        {
          sql: `
            UPDATE order_profit_items
            SET return_loss_cny = 0,
              net_profit_cny = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE order_item_id = ?
          `,
          params: [nextProfit, row.order_item_id]
        },
        String(row.settlement_state || "") === "accrued"
          ? {
            sql: `
              UPDATE order_items
              SET estimated_profit = ?,
                actual_profit = ?,
                aftersale_loss = 0,
                settlement_state = 'accrued'
              WHERE id = ?
            `,
            params: [nextProfit, nextProfit, row.order_item_id]
          }
          : {
            sql: `
              UPDATE order_items
              SET estimated_profit = ?,
                actual_profit = 0,
                aftersale_loss = 0,
                settlement_state = ?
              WHERE id = ?
            `,
            params: [nextProfit, row.settlement_state || "estimated", row.order_item_id]
          }
      ]);
      upsertHistoricalProfitReview(deps, row.order_item_id, "cleared", "system_cleanup", null);
      updatedItems += 1;
      clearedReturnLoss += Number(row.return_loss_cny || 0);
      updatedOrders.add(Number(row.order_id));
      if (row.order_date) dateKeys.add(row.order_date);
    }
  });

  refreshHistoricalReviewArtifacts(deps, [...dateKeys], { from, to });
  return {
    ok: true,
    from,
    to,
    only_final: onlyFinal,
    updated_items: updatedItems,
    updated_orders: updatedOrders.size,
    cleared_return_loss_cny: deps.roundMoney(clearedReturnLoss)
  };
}

export function applyHistoricalProfitReviewAction(deps, body = {}, userId = null) {
  const action = String(body.action || "").trim();
  const orderItemIds = historicalReviewOrderItemIds(body);
  if (!action) throw new Error("缺少复核动作");
  if (!orderItemIds.length) throw new Error("请先选择要处理的历史异常明细");
  const placeholders = orderItemIds.map(() => "?").join(",");
  const rows = deps.all(`
    SELECT
      o.id AS order_id,
      oi.id AS order_item_id,
      substr(o.ordered_at, 1, 10) AS order_date,
      COALESCE(opi.sale_amount_cny, 0) AS sale_amount_cny,
      COALESCE(opi.purchase_cost_cny, 0) AS purchase_cost_cny,
      COALESCE(opi.domestic_shipping_cny, 0) AS domestic_shipping_cny,
      COALESCE(opi.international_shipping_cny, 0) AS international_shipping_cny,
      COALESCE(opi.packaging_cost_cny, 0) AS packaging_cost_cny,
      COALESCE(opi.commission_fee_cny, 0) AS commission_fee_cny,
      COALESCE(opi.ozon_service_fee_cny, 0) AS ozon_service_fee_cny,
      COALESCE(opi.advertising_cost_cny, 0) AS advertising_cost_cny,
      COALESCE(opi.other_fee_cny, 0) AS other_fee_cny,
      COALESCE(opi.return_loss_cny, 0) AS return_loss_cny,
      COALESCE(opi.profit_status, oi.settlement_state, 'estimated') AS settlement_state
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.id IN (${placeholders})
  `, orderItemIds);
  if (!rows.length) throw new Error("没有找到可处理的订单商品");

  if (action === "keep") {
    for (const row of rows) upsertHistoricalProfitReview(deps, row.order_item_id, "kept", "manual_keep", userId);
    deps.invalidateExceptionWorkbenchCache();
    return { ok: true, action, updated_items: rows.length };
  }

  if (action === "reset") {
    executeStatement(deps, `DELETE FROM historical_profit_reviews WHERE order_item_id IN (${placeholders})`, orderItemIds);
    deps.invalidateExceptionWorkbenchCache();
    return { ok: true, action, updated_items: rows.length };
  }

  if (action === "clear") {
    let clearedReturnLoss = 0;
    const dateKeys = [];
    runInTransaction(deps, () => {
      for (const row of rows) {
        const nextProfit = recalculateNetProfitWithoutReturnLoss(deps, row);
        executeBatchStatements(deps, [
          {
            sql: `
              UPDATE order_profit_items
              SET return_loss_cny = 0,
                net_profit_cny = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE order_item_id = ?
            `,
            params: [nextProfit, row.order_item_id]
          },
          String(row.settlement_state || "") === "accrued"
            ? {
              sql: `
                UPDATE order_items
                SET estimated_profit = ?,
                  actual_profit = ?,
                  aftersale_loss = 0,
                  settlement_state = 'accrued'
                WHERE id = ?
              `,
              params: [nextProfit, nextProfit, row.order_item_id]
            }
            : {
              sql: `
                UPDATE order_items
                SET estimated_profit = ?,
                  actual_profit = 0,
                  aftersale_loss = 0,
                  settlement_state = ?
                WHERE id = ?
              `,
              params: [nextProfit, row.settlement_state || "estimated", row.order_item_id]
            }
        ]);
        upsertHistoricalProfitReview(deps, row.order_item_id, "cleared", "manual_clear", userId);
        clearedReturnLoss += Number(row.return_loss_cny || 0);
        if (row.order_date) dateKeys.push(row.order_date);
      }
    });
    refreshHistoricalReviewArtifacts(deps, dateKeys, {});
    return {
      ok: true,
      action,
      updated_items: rows.length,
      updated_orders: new Set(rows.map((row) => Number(row.order_id))).size,
      cleared_return_loss_cny: deps.roundMoney(clearedReturnLoss)
    };
  }

  if (action === "recalculate") {
    const uniqueOrders = [...new Set(rows.map((row) => Number(row.order_id)).filter(Boolean))];
    const dateKeys = [];
    let updatedItems = 0;
    let unbound = 0;
    for (const orderId of uniqueOrders) {
      const result = deps.recalculateOrderProfit(orderId);
      updatedItems += Number(result.updated || 0);
      unbound += Number(result.unbound || 0);
    }
    for (const row of rows) if (row.order_date) dateKeys.push(row.order_date);
    const sortedDates = [...new Set(dateKeys)].sort();
    const applied = deps.reapplySyncedOzonFinance({
      from: sortedDates[0] || "",
      to: sortedDates[sortedDates.length - 1] || ""
    });
    refreshHistoricalReviewArtifacts(deps, dateKeys, {});
    return {
      ok: true,
      action,
      updated_orders: uniqueOrders.length,
      updated_items: updatedItems,
      unbound,
      finance_reapplied: applied
    };
  }

  throw new Error("不支持的复核动作");
}

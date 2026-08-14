export async function orderProfitDetailSnapshotMysqlService(deps, orderId) {
  const row = await deps.queryOne("SELECT * FROM order_profit_detail_snapshots WHERE order_id = ?", [Number(orderId)]);
  if (!row) return null;
  return {
    ...row,
    actual_profit_ready: Boolean(row.actual_profit_ready),
    summary: deps.parseJson(row.summary_json, {}),
    rows: deps.parseJson(row.detail_rows_json, []),
    finance_totals: deps.parseJson(row.finance_totals_json, {})
  };
}

export async function refreshOrderProfitDetailSnapshotsMysqlService(deps, body = {}) {
  const from = deps.normalizeDate(body.from);
  const to = deps.normalizeDate(body.to);
  const explicitIds = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  const limit = Math.min(Math.max(Number(body.limit || 5000), 1), 50000);
  const where = [];
  const params = [];
  if (explicitIds.length) {
    where.push(`o.id IN (${explicitIds.map(() => "?").join(",")})`);
    params.push(...explicitIds);
  } else {
    if (from) {
      where.push(`${deps.chinaDateSql("o.ordered_at")} >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`${deps.chinaDateSql("o.ordered_at")} <= ?`);
      params.push(to);
    }
    if (Number(body.final_only ?? 1) !== 0) {
      where.push(`(
        LOWER(COALESCE(o.status, '')) LIKE '%deliver%'
        OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%deliver%'
        OR LOWER(COALESCE(o.status, '')) LIKE '%cancel%'
        OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
        OR EXISTS (SELECT 1 FROM ozon_finance_items ofi WHERE ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number)
      )`);
    }
  }
  const orders = await deps.query(`
    SELECT o.id
    FROM orders o
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY o.ordered_at DESC
    LIMIT ?
  `, [...params, limit]);

  let refreshed = 0;
  for (const orderRow of orders) {
    const detail = await deps.orderDetail(Number(orderRow.id));
    if (!detail?.order) continue;
    const payload = deps.buildPayload(detail.order, detail.items, detail.finance);
    await deps.execute(`
      INSERT INTO order_profit_detail_snapshots (
        order_id, shop_id, posting_number, order_status, outcome_type, sale_amount_cny,
        estimated_profit_cny, estimated_cost_total_cny, actual_profit_cny, actual_profit_rate,
        actual_cost_total_cny, finance_match_status, finance_rows, actual_profit_ready,
        summary_json, detail_rows_json, finance_totals_json, refreshed_at, source_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON DUPLICATE KEY UPDATE
        shop_id = VALUES(shop_id),
        posting_number = VALUES(posting_number),
        order_status = VALUES(order_status),
        outcome_type = VALUES(outcome_type),
        sale_amount_cny = VALUES(sale_amount_cny),
        estimated_profit_cny = VALUES(estimated_profit_cny),
        estimated_cost_total_cny = VALUES(estimated_cost_total_cny),
        actual_profit_cny = VALUES(actual_profit_cny),
        actual_profit_rate = VALUES(actual_profit_rate),
        actual_cost_total_cny = VALUES(actual_cost_total_cny),
        finance_match_status = VALUES(finance_match_status),
        finance_rows = VALUES(finance_rows),
        actual_profit_ready = VALUES(actual_profit_ready),
        summary_json = VALUES(summary_json),
        detail_rows_json = VALUES(detail_rows_json),
        finance_totals_json = VALUES(finance_totals_json),
        refreshed_at = CURRENT_TIMESTAMP,
        source_updated_at = VALUES(source_updated_at)
    `, [
      payload.order_id,
      payload.shop_id,
      payload.posting_number,
      payload.order_status,
      payload.outcome_type,
      payload.sale_amount_cny,
      payload.estimated_profit_cny,
      payload.estimated_cost_total_cny,
      payload.actual_profit_cny,
      payload.actual_profit_rate,
      payload.actual_cost_total_cny,
      payload.finance_match_status,
      payload.finance_rows,
      payload.actual_profit_ready,
      JSON.stringify(payload.summary),
      JSON.stringify(payload.detailRows),
      JSON.stringify(payload.financeTotals),
      deps.normalizeDateTime(detail.order.updated_at || detail.order.last_synced_at || detail.order.ordered_at)
    ]);
    refreshed += 1;
  }

  return {
    ok: true,
    matched: orders.length,
    refreshed,
    from,
    to,
    final_only: Number(body.final_only ?? 1) !== 0,
    db: "mysql"
  };
}

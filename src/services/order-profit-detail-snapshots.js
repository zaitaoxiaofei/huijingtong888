function executeStatement(deps, sql, params = []) {
  if (typeof deps.execute === "function") return deps.execute(sql, params);
  return deps.db.prepare(sql).run(...params);
}

function queryAll(deps, sql, params = []) {
  if (typeof deps.queryAll === "function") return deps.queryAll(sql, params);
  if (typeof deps.all === "function") return deps.all(sql, params);
  return deps.db.prepare(sql).all(...params);
}

function queryOne(deps, sql, params = []) {
  if (typeof deps.queryOne === "function") return deps.queryOne(sql, params);
  if (typeof deps.get === "function") return deps.get(sql, params);
  return deps.db.prepare(sql).get(...params);
}

function roundMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : 0;
}

function positiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function nullableNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function itemQuantity(item = {}) {
  return Math.max(Number(item.quantity || 1), 1);
}

function saleAmount(item = {}) {
  return positiveAmount(item.sale_amount_cny) || Number(item.sale_price || 0) * itemQuantity(item);
}

function estimatedPurchase(item = {}) {
  return positiveAmount(item.frozen_purchase_cost) * itemQuantity(item) || positiveAmount(item.purchase_cost_cny);
}

function estimatedDomestic(item = {}) {
  return positiveAmount(item.frozen_domestic_shipping) * itemQuantity(item) || positiveAmount(item.domestic_shipping_cny);
}

function estimatedInternational(item = {}) {
  return positiveAmount(item.frozen_international_shipping) * itemQuantity(item) || positiveAmount(item.international_shipping_cny);
}

function financeCategory(row = {}) {
  const raw = String(row.service_name || row.operation_type_name || row.service_type || row.operation_type || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("sale_commission") || raw === "Ozon 销售佣金") return "commission";
  if (normalized.includes("marketplaceredistributionofacquiringoperation")) return "collecting_fee";
  if (normalized.includes("return_delivery_charge") || normalized.includes("returnflowlogistic") || normalized.includes("returnnotdelivtocustomer")) return "aftersale_loss";
  if (normalized.includes("delivery_charge")) return "platform_delivery";
  if (raw === "Перевыставление услуг доставки" || raw.includes("достав")) return "platform_delivery";
  if (raw.includes("международ") || raw.includes("транспортно-экспедиционных")) return "international_transport";
  if (raw.includes("Частичная компенсация покупателю") || raw.includes("возврат") || raw.includes("недовлож")) return "aftersale_loss";
  return "other";
}

function sumRows(rows = [], getter = () => 0) {
  return roundMoney(rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0));
}

function hasFinanceActualProfit(item = {}) {
  const statusText = [item.settlement_state, item.profit_status].map((value) => String(value || "").toLowerCase()).join(" ");
  return statusText.includes("accrued") && String(item.lock_reason || "").toLowerCase().includes("finance");
}

function hasFinanceSaleAccrual(finance = []) {
  return finance.some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
}

function isFinalProfitOutcome(order = {}) {
  const text = [
    order.outcome_type,
    order.status,
    order.tracking_stage,
    order.logistics_status,
    order.accrued_at
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return text.includes("delivered")
    || text.includes("signed")
    || text.includes("cancel")
    || text.includes("return")
    || text.includes("reject")
    || text.includes("accrued");
}

function financeCategoryTotal(finance = [], categories = []) {
  const keys = new Set(Array.isArray(categories) ? categories : [categories]);
  let matched = false;
  const total = finance.reduce((sum, row) => {
    const key = financeCategory(row);
    if (!keys.has(key)) return sum;
    matched = true;
    const feeAmount = nullableNumber(row.fee_amount_cny);
    const rawAmount = Number(row.amount_cny || 0);
    const amount = feeAmount !== null ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
    return sum + amount;
  }, 0);
  return matched ? roundMoney(total) : null;
}

function valueDiff(actual, estimated) {
  if (actual === null || actual === undefined) return null;
  return roundMoney(Number(actual || 0) - Number(estimated || 0));
}

export function buildOrderProfitDetailSnapshotPayload(order = {}, items = [], finance = []) {
  const rows = Array.isArray(items) ? items : [];
  const financeRows = Array.isArray(finance) ? finance : [];
  const hasFinalFinanceBasis = financeRows.length > 0 && (hasFinanceSaleAccrual(financeRows) || isFinalProfitOutcome(order));
  const actualProfitReady = hasFinalFinanceBasis && rows.length > 0 && rows.every((item) => hasFinanceActualProfit(item));
  const sale = sumRows(rows, saleAmount);
  const estimated = {
    sale,
    purchase: sumRows(rows, estimatedPurchase),
    domestic: sumRows(rows, estimatedDomestic),
    international: sumRows(rows, estimatedInternational),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: sumRows(rows, (item) => positiveAmount(item.estimated_commission) || positiveAmount(item.commission_fee_cny)),
    collecting: 0,
    service: sumRows(rows, (item) => positiveAmount(item.ozon_service_fee_cny)),
    aftersale: sumRows(rows, (item) => positiveAmount(item.aftersale_loss) || positiveAmount(item.return_loss_cny)),
    other: sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)),
    profit: sumRows(rows, (item) => nullableNumber(item.estimated_profit) ?? nullableNumber(item.net_profit_cny) ?? 0)
  };
  const actual = {
    sale,
    purchase: sumRows(rows, (item) => positiveAmount(item.purchase_cost_cny) || estimatedPurchase(item)),
    domestic: sumRows(rows, (item) => positiveAmount(item.domestic_shipping_cny) || estimatedDomestic(item)),
    international: financeCategoryTotal(financeRows, ["platform_delivery", "international_transport"]),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: financeCategoryTotal(financeRows, "commission"),
    collecting: financeCategoryTotal(financeRows, "collecting_fee"),
    service: financeCategoryTotal(financeRows, "other"),
    aftersale: financeCategoryTotal(financeRows, "aftersale_loss"),
    other: actualProfitReady ? sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)) : null
  };
  if (actualProfitReady) {
    actual.international = actual.international ?? 0;
    actual.commission = actual.commission ?? 0;
    actual.collecting = actual.collecting ?? 0;
    actual.service = actual.service ?? 0;
    actual.aftersale = actual.aftersale ?? 0;
  }

  const estimatedCostTotal = roundMoney(estimated.purchase + estimated.domestic + estimated.international + estimated.packaging + estimated.commission + estimated.collecting + estimated.service + estimated.aftersale + estimated.other);
  const actualCostTotal = actualProfitReady
    ? roundMoney(actual.purchase + actual.domestic + (actual.international || 0) + actual.packaging + (actual.commission || 0) + (actual.collecting || 0) + (actual.service || 0) + (actual.aftersale || 0) + (actual.other || 0))
    : null;
  const estimatedProfit = estimated.profit || roundMoney(sale - estimatedCostTotal);
  const actualProfit = actualProfitReady ? roundMoney(sale - actualCostTotal) : null;
  const actualProfitRate = actualProfitReady && sale ? actualProfit / sale * 100 : null;

  const moneyRow = (key, label) => ({
    key,
    label,
    estimated: roundMoney(estimated[key] || 0),
    actual: actual[key],
    diff: valueDiff(actual[key], estimated[key] || 0)
  });
  const detailRows = [
    moneyRow("sale", "订单金额"),
    moneyRow("purchase", "采购成本"),
    moneyRow("domestic", "国内运费"),
    moneyRow("international", "国际运费"),
    moneyRow("packaging", "包装处理费"),
    moneyRow("commission", "Ozon佣金"),
    moneyRow("collecting", "收单费"),
    moneyRow("service", "Ozon服务费"),
    moneyRow("aftersale", "售后损失"),
    moneyRow("other", "其他费用"),
    {
      key: "costTotal",
      label: "成本合计",
      estimated: estimatedCostTotal,
      actual: actualCostTotal,
      diff: valueDiff(actualCostTotal, estimatedCostTotal),
      strong: true
    },
    {
      key: "profit",
      label: "利润",
      estimated: estimatedProfit,
      actual: actualProfit,
      diff: valueDiff(actualProfit, estimatedProfit),
      strong: true
    }
  ];
  const financeTotals = financeRows.reduce((acc, row) => {
    const key = financeCategory(row);
    const feeAmount = nullableNumber(row.fee_amount_cny);
    const rawAmount = Number(row.amount_cny || 0);
    const amount = feeAmount !== null ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
    acc[key] = roundMoney(Number(acc[key] || 0) + amount);
    return acc;
  }, {});
  const financeMatchStatus = actualProfitReady ? "settled" : financeRows.length ? "matched" : "unmatched";
  return {
    order_id: Number(order.id),
    shop_id: Number(order.shop_id),
    posting_number: order.posting_number || "",
    order_status: order.status || "",
    outcome_type: order.outcome_type || "",
    sale_amount_cny: sale,
    estimated_profit_cny: estimatedProfit,
    estimated_cost_total_cny: estimatedCostTotal,
    actual_profit_cny: actualProfit,
    actual_profit_rate: actualProfitRate,
    actual_cost_total_cny: actualCostTotal,
    finance_match_status: financeMatchStatus,
    finance_rows: financeRows.length,
    actual_profit_ready: actualProfitReady ? 1 : 0,
    summary: {
      saleAmount: sale,
      estimatedProfit,
      estimatedCostTotal,
      actualProfit,
      actualProfitRate,
      actualCostTotal,
      financeRows: financeRows.length,
      actualProfitReady,
      financeMatchStatus
    },
    detailRows,
    financeTotals
  };
}

export function refreshOrderProfitDetailSnapshots(deps, body = {}) {
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
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
  const orders = queryAll(deps, `
    SELECT o.*
    FROM orders o
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY o.ordered_at DESC
    LIMIT ?
  `, [...params, limit]);

  let refreshed = 0;
  for (const order of orders) {
    const detail = deps.orderDetail(Number(order.id));
    if (!detail?.order) continue;
    const payload = buildOrderProfitDetailSnapshotPayload(detail.order, detail.items, detail.finance);
    executeStatement(deps, `
      INSERT INTO order_profit_detail_snapshots (
        order_id, shop_id, posting_number, order_status, outcome_type, sale_amount_cny,
        estimated_profit_cny, estimated_cost_total_cny, actual_profit_cny, actual_profit_rate,
        actual_cost_total_cny, finance_match_status, finance_rows, actual_profit_ready,
        summary_json, detail_rows_json, finance_totals_json, refreshed_at, source_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(order_id) DO UPDATE SET
        shop_id = excluded.shop_id,
        posting_number = excluded.posting_number,
        order_status = excluded.order_status,
        outcome_type = excluded.outcome_type,
        sale_amount_cny = excluded.sale_amount_cny,
        estimated_profit_cny = excluded.estimated_profit_cny,
        estimated_cost_total_cny = excluded.estimated_cost_total_cny,
        actual_profit_cny = excluded.actual_profit_cny,
        actual_profit_rate = excluded.actual_profit_rate,
        actual_cost_total_cny = excluded.actual_cost_total_cny,
        finance_match_status = excluded.finance_match_status,
        finance_rows = excluded.finance_rows,
        actual_profit_ready = excluded.actual_profit_ready,
        summary_json = excluded.summary_json,
        detail_rows_json = excluded.detail_rows_json,
        finance_totals_json = excluded.finance_totals_json,
        refreshed_at = CURRENT_TIMESTAMP,
        source_updated_at = excluded.source_updated_at
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
      detail.order.updated_at || detail.order.last_synced_at || detail.order.ordered_at || null
    ]);
    refreshed += 1;
  }
  return {
    ok: true,
    matched: orders.length,
    refreshed,
    from,
    to,
    final_only: Number(body.final_only ?? 1) !== 0
  };
}

export function orderProfitDetailSnapshot(deps, orderId) {
  const row = queryOne(deps, "SELECT * FROM order_profit_detail_snapshots WHERE order_id = ?", [Number(orderId)]);
  if (!row) return null;
  return {
    ...row,
    actual_profit_ready: Boolean(row.actual_profit_ready),
    summary: safeParse(row.summary_json, {}),
    rows: safeParse(row.detail_rows_json, []),
    finance_totals: safeParse(row.finance_totals_json, {})
  };
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

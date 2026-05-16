import { db } from "../db.js";
import { recalculateOrderCancelLossFlags } from "../services.js";
import { stockAlerts } from "./inventory.js";
import { describeCancellation } from "./order-cancellation.js";
import { buildOrderOutcomeSql, classifyOrderOutcome } from "./order-outcome.js";

const EXCEPTION_WORKBENCH_CACHE_MS = 30000;
let exceptionWorkbenchCache = null;

function allLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function getLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function orderOutcomeLabel(outcome = "") {
  return {
    active: "进行中",
    cancelled_pre_fulfillment: "已取消",
    rejected_unclaimed: "已拒收/未取",
    after_delivery_return: "签收后退货",
    delivered_signed: "已签收"
  }[String(outcome || "").toLowerCase()] || "进行中";
}

function orderOutcomeHint(outcome = "") {
  switch (String(outcome || "").toLowerCase()) {
    case "cancelled_pre_fulfillment":
      return "订单在实质履约损失发生前取消，真实售后损失按 0 处理。";
    case "rejected_unclaimed":
      return "当前按拒收/未取模型处理，售后损失通常包含货值和收单等拒收损失。";
    case "after_delivery_return":
      return "当前按签收后退货模型处理，售后损失通常包含货值、国内/国际运费、包装和平台费用。";
    case "delivered_signed":
      return "订单已正常签收，真实售后损失按 0 处理。";
    default:
      return "订单仍在进行中，售后损失继续按预估模型展示。";
  }
}

export function orders() {
  const rows = allLocal(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0 ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.quantity, '||') AS sku_quantities,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.sale_price || ':' || oi.quantity, '||') AS sku_prices,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), ''), '||') AS sku_names,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), ''), '||') AS sku_images,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN oi.ozon_sku || ':' || p.id END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN oi.ozon_sku || ':' || op.id END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN oi.ozon_sku || ':' || sm.id END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT oi.ozon_sku || ':' || COALESCE(stock.fbs_present, 0) || ':' || COALESCE(stock.fbp_present, 0)) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.length_cm, 0) || 'x' || COALESCE(p.width_cm, 0) || 'x' || COALESCE(p.height_cm, 0) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = o.shop_id AND stock.ozon_sku = oi.ozon_sku
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    GROUP BY o.id
    ORDER BY o.ordered_at DESC
    LIMIT 10000
  `);
  return rows.map(enrichOrderLogistics);
}

export function ordersPaged(query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const base = orderBaseSql(query);
  const counts = orderPagedSqlCounts(base);
  const filtered = orderFilteredSql(query, base);
  const total = getLocal(`SELECT COUNT(*) AS total FROM orders o ${filtered.joins} WHERE ${filtered.where}`, filtered.params)?.total || 0;
  const start = (page - 1) * pageSize;
  const sortMode = String(query.sortMode || query.sort_mode || "ordered");
  let rows;
  if (sortMode === "inventory") {
    const allIdRows = allLocal(`
      SELECT o.id
      FROM orders o
      ${filtered.joins}
      WHERE ${filtered.where}
      GROUP BY o.id
      ${orderSqlSort(query)}
    `, filtered.params);
    rows = sortPagedOrders(orderRowsByIds(allIdRows.map((row) => row.id)), query).slice(start, start + pageSize);
  } else {
    const idRows = allLocal(`
      SELECT o.id
      FROM orders o
      ${filtered.joins}
      WHERE ${filtered.where}
      GROUP BY o.id
      ${orderSqlSort(query)}
      LIMIT ? OFFSET ?
    `, [...filtered.params, pageSize, start]);
    rows = orderRowsByIds(idRows.map((row) => row.id));
  }
  return {
    rows,
    total,
    page,
    pageSize,
    counts,
    mode: "paged"
  };
}

export function updateOrderMark(orderId, body = {}, userId = null) {
  const id = Number(orderId);
  const order = getLocal("SELECT id FROM orders WHERE id = ?", [id]);
  if (!order) throw new Error("订单不存在");
  const markType = String(body.mark_type || "").trim();
  const note = String(body.note || "").trim();
  if (!markType && !note) {
    db.prepare("DELETE FROM order_marks WHERE order_id = ?").run(id);
    return { ok: true, id, mark_type: "", note: "" };
  }
  db.prepare(`
    INSERT INTO order_marks (order_id, mark_type, note, updated_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      mark_type = excluded.mark_type,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, markType, note, nullable(userId));
  return { ok: true, id, mark_type: markType, note };
}

export function orderQualityRules() {
  return allLocal("SELECT * FROM order_quality_rules ORDER BY active DESC, prefix ASC, id ASC");
}

export function markOrderLabelsPrinted(body = {}, userId = null) {
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw new Error("请选择需要记录打印状态的订单");
  const rows = allLocal(`SELECT id FROM orders WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) throw new Error("订单不存在");
  const stmt = db.prepare(`
    INSERT INTO order_label_prints (order_id, printed_at, printed_by_person_id)
    VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(order_id) DO UPDATE SET printed_at = CURRENT_TIMESTAMP, printed_by_person_id = excluded.printed_by_person_id
  `);
  for (const row of rows) stmt.run(row.id, nullable(userId));
  return { ok: true, count: rows.length };
}

export function saveOrderQualityRules(body = {}) {
  qualityPrefixCache = null;
  const prefixes = Array.isArray(body.prefixes) ? body.prefixes : String(body.prefixes || "").split(/[\s,，;；]+/);
  const cleaned = [...new Set(prefixes.map((item) => String(item || "").trim()).filter(Boolean))];
  db.prepare("UPDATE order_quality_rules SET active = 0, updated_at = CURRENT_TIMESTAMP").run();
  const stmt = db.prepare(`
    INSERT INTO order_quality_rules (prefix, label, note, active, updated_at)
    VALUES (?, '质检单', ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(prefix) DO UPDATE SET
      label = excluded.label,
      note = excluded.note,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  const note = String(body.note || "疑似 Ozon 仓库质检单：不要正常发货，按仓库要求拍照处理。");
  for (const prefix of cleaned) stmt.run(prefix, note);
  recalculateOrderCancelLossFlags();
  return { ok: true, rules: orderQualityRules() };
}

export function orderDetail(id) {
  const order = getLocal("SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?", [id]);
  if (!order) return null;
  const items = allLocal(`
    SELECT oi.*, sm.ozon_sku AS mapped_ozon_sku, sm.offer_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name, pe.name AS owner_name,
      p.shipping_method,
      p.package_weight_g,
      p.length_cm,
      p.width_cm,
      p.height_cm,
      p.return_rate,
      opi.sale_amount_cny,
      opi.purchase_cost_cny,
      opi.domestic_shipping_cny,
      opi.international_shipping_cny,
      opi.packaging_cost_cny,
      opi.commission_fee_cny,
      opi.ozon_service_fee_cny,
      opi.return_loss_cny,
      opi.advertising_cost_cny,
      opi.other_fee_cny,
      opi.gross_profit_cny,
      opi.net_profit_cny,
      opi.profit_status
    FROM order_items oi
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN people pe ON pe.id = sm.person_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.order_id = ?
  `, [id]);
  const finance = orderDetailFinance(order, items);
  const outcomeType = classifyOrderOutcome(order);
  const cancellation = describeCancellation(order);
  order.outcome_type = outcomeType;
  order.outcome_label = orderOutcomeLabel(outcomeType);
  order.outcome_hint = orderOutcomeHint(outcomeType);
  order.cancel_initiator_label = cancellation.initiator_label;
  order.cancel_reason_label = cancellation.reason_label;
  order.cancel_reason_code = cancellation.reason_code;
  order.cancel_reason_group_label = cancellation.reason_group_label;
  order.cancel_accounting_hint = cancellation.accounting_hint;
  order.loss_profile_code = cancellation.loss_profile_code;
  order.loss_profile_label = cancellation.loss_profile_label;
  order.loss_formula_text = cancellation.loss_formula_text;
  return { order, items, finance };
}

function orderDetailFinance(order, items = []) {
  const directRows = allLocal(`
    SELECT service_type, service_name,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(amount_cny), 0) AS amount_cny,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
      COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny,
      COALESCE(MAX(exchange_rate), 0) AS exchange_rate,
      COALESCE(MAX(currency_code), 'RUB') AS currency_code,
      COUNT(*) AS rows,
      MAX(operation_date) AS operation_date
    FROM ozon_finance_items
    WHERE shop_id = ? AND posting_number = ?
    GROUP BY service_type, service_name
  `, [order.shop_id, order.posting_number]);

  const parentPosting = trimOrderPostingSuffix(order.posting_number);
  const extraRows = parentPosting && parentPosting !== order.posting_number
    ? allLocal(`
      SELECT service_type, service_name,
        COALESCE(SUM(amount), 0) AS amount,
        COALESCE(SUM(amount_cny), 0) AS amount_cny,
        COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
        COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny,
        COALESCE(MAX(exchange_rate), 0) AS exchange_rate,
        COALESCE(MAX(currency_code), 'RUB') AS currency_code,
        COUNT(*) AS rows,
        MAX(operation_date) AS operation_date
      FROM ozon_finance_items
      WHERE shop_id = ?
        AND posting_number = ?
        AND LOWER(COALESCE(service_name, '')) LIKE '%marketplaceredistributionofacquiringoperation%'
      GROUP BY service_type, service_name
    `, [order.shop_id, parentPosting])
    : [];

  const exactRows = new Set((directRows || []).map((row) => `${row.service_type}||${row.service_name}`));
  const totalSale = (items || []).reduce((sum, item) => sum + Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 0))), 0);
  const orderSale = totalSale || (items?.length ? 1 : 0);
  const siblingRows = parentPosting && parentPosting !== order.posting_number
    ? allLocal(`
      SELECT o.id, o.posting_number,
        COALESCE(SUM(opi.sale_amount_cny), SUM(oi.sale_price * oi.quantity), 0) AS sale_amount_cny
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE o.shop_id = ? AND o.posting_number LIKE ?
      GROUP BY o.id, o.posting_number
    `, [order.shop_id, `${parentPosting}-%`])
    : [];
  const siblingTotalSale = siblingRows.reduce((sum, row) => sum + Number(row.sale_amount_cny || 0), 0);
  const share = siblingTotalSale > 0
    ? orderSale / siblingTotalSale
    : siblingRows.length > 0 ? 1 / siblingRows.length : 1;

  const financeMap = new Map();
  for (const row of directRows || []) {
    const key = `${row.service_type}||${row.service_name}`;
    financeMap.set(key, { ...row });
  }
  for (const row of extraRows || []) {
    const key = `${row.service_type}||${row.service_name}`;
    if (exactRows.has(key)) continue;
    financeMap.set(key, scaleFinanceRow(row, share));
  }
  return [...financeMap.values()].sort((a, b) => {
    const feeDiff = Number(b.fee_amount_cny || 0) - Number(a.fee_amount_cny || 0);
    if (feeDiff) return feeDiff;
    const amountDiff = Math.abs(Number(b.amount_cny || 0)) - Math.abs(Number(a.amount_cny || 0));
    if (amountDiff) return amountDiff;
    return String(a.service_name || "").localeCompare(String(b.service_name || ""));
  });
}

function scaleFinanceRow(row = {}, share = 1) {
  const ratio = Number.isFinite(Number(share)) ? Number(share) : 1;
  return {
    ...row,
    amount: roundFinanceAmount(Number(row.amount || 0) * ratio),
    amount_cny: roundFinanceAmount(Number(row.amount_cny || 0) * ratio),
    fee_amount: roundFinanceAmount(Number(row.fee_amount || 0) * ratio),
    fee_amount_cny: roundFinanceAmount(Number(row.fee_amount_cny || 0) * ratio),
    rows: Number(row.rows || 0),
    derived_from_parent_posting: 1
  };
}

function trimOrderPostingSuffix(value = "") {
  const text = String(value || "").trim();
  const matched = text.match(/^(.*)-\d+$/);
  return matched?.[1] || text;
}

function roundFinanceAmount(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function exceptionWorkbench(query = {}) {
  if (query.refresh || query.forceRefresh || query.force_refresh) invalidateExceptionWorkbenchCache();
  const view = normalizeExceptionWorkbenchView(query.view || query.exceptionView || query.exception_view);
  const search = String(query.search || query.searchQuery || query.search_query || "").trim();
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 50), 1), 200);
  const requestedPage = Math.max(Number(query.page || 1), 1);
  const sortField = normalizeExceptionWorkbenchSortField(query.sortField || query.sort_field);
  const sortDirection = normalizeExceptionWorkbenchSortDirection(query.sortDirection || query.sort_direction);
  const dateFrom = normalizeSyncDate(query.dateFrom || query.date_from) || dateKeyDaysAgo(90);
  const dateTo = normalizeSyncDate(query.dateTo || query.date_to) || exceptionTodayDateKey();
  const workbench = exceptionWorkbenchBase();
  const { openTasks, resolvedTasks, counts, generatedAt } = workbench;
  const scopedOpenTasks = filterExceptionTasksByDate(openTasks, dateFrom, dateTo);
  const scopedResolvedTasks = filterExceptionTasksByDate(resolvedTasks, dateFrom, dateTo);
  const scopedCounts = exceptionWorkbenchCounts(scopedOpenTasks);
  const viewTasks = exceptionTasksForView({ view, openTasks: scopedOpenTasks, resolvedTasks: scopedResolvedTasks });
  const filteredTasks = filterExceptionWorkbenchTasks(viewTasks, search);
  const sortedTasks = sortExceptionWorkbenchTasks(filteredTasks, sortField, sortDirection);
  const total = sortedTasks.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = sortedTasks.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return {
    rows,
    resolved_rows: scopedResolvedTasks,
    total,
    resolved_total: scopedResolvedTasks.length,
    page,
    pageSize,
    view,
    search,
    sort_field: sortField,
    sort_direction: sortDirection,
    counts: scopedCounts,
    date_from: dateFrom,
    date_to: dateTo,
    generated_at: generatedAt
  };
}

export function invalidateExceptionWorkbenchCache() {
  exceptionWorkbenchCache = null;
}

function filterExceptionTasksByDate(tasks = [], dateFrom = "", dateTo = "") {
  return tasks.filter((task) => {
    const dateKey = chinaDateKey(task.ordered_at || task.created_at || "");
    if (!dateKey) return true;
    if (dateFrom && dateKey < dateFrom) return false;
    if (dateTo && dateKey > dateTo) return false;
    return true;
  });
}

function exceptionWorkbenchCounts(openTasks = []) {
  return {
    danger: openTasks.filter((item) => item.level === "danger").length,
    warning: openTasks.filter((item) => item.level === "warning").length,
    info: openTasks.filter((item) => item.level === "info").length,
    order: openTasks.filter((item) => item.type.startsWith("order") || ["print", "profit", "deadline"].includes(item.type)).length,
    stock: openTasks.filter((item) => item.type === "order_stock_shortage" || item.type.startsWith("stock")).length,
    profit: openTasks.filter((item) => item.type === "profit").length,
    deadline: openTasks.filter((item) => item.type === "deadline").length,
    delivery_timeout: openTasks.filter((item) => item.type === "deadline" && ["delivery", "fulfillment"].includes(item.deadline_kind) && item.level === "danger").length,
    delivery_warning: openTasks.filter((item) => item.type === "deadline" && ["delivery", "fulfillment"].includes(item.deadline_kind) && item.level !== "danger").length,
    pickup_timeout: openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "pickup").length,
    receipt_timeout: openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "receipt").length,
    payment_timeout: openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "payment").length,
    cancelled: openTasks.filter((item) => item.type === "cancelled_order").length,
    binding: openTasks.filter((item) => item.type === "order_binding").length
  };
}

export function exceptionWorkbenchSyncWindow() {
  const workbench = exceptionWorkbenchBase();
  const orderTimes = (workbench.openTasks || [])
    .map((task) => parseDate(task.ordered_at))
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  const from = orderTimes[0] ? orderTimes[0].toISOString().slice(0, 10) : dateKeyDaysAgo(30);
  return {
    from,
    to: exceptionTodayDateKey(),
    task_count: workbench.openTasks?.length || 0
  };
}

function exceptionWorkbenchBase() {
  const now = Date.now();
  if (exceptionWorkbenchCache && now - exceptionWorkbenchCache.createdAt < EXCEPTION_WORKBENCH_CACHE_MS) {
    return exceptionWorkbenchCache.payload;
  }
  const tasks = [];
  const orderRows = orders().filter((row) => orderMatchesBaseQuery(row, {
    dateFrom: dateKeyDaysAgo(180),
    dateTo: exceptionTodayDateKey()
  }));
  for (const row of orderRows) {
    const work = orderTaskState(row);
    const context = exceptionOrderContext(row);
    const profitValue = Number(row.actual_profit || row.estimated_profit || 0);
    if (orderIsCancelledForDeadlineV2(row)) {
      tasks.push(exceptionTask({
        type: "cancelled_order",
        level: "info",
        title: "订单已取消/拒收",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${formatDateText(row.ordered_at)}`,
        detail: "订单当前状态为取消、拒收或退回，不应继续按运输/签收超时处理。",
        action: "order-overdue",
        orderId: row.id,
        ...context
      }));
      continue;
    }
    if (orderHasUnboundStockQuery(row)) {
      tasks.push(exceptionTask({
        type: "order_binding",
        level: "warning",
        title: "订单待绑定库存",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${formatDateText(row.ordered_at)}`,
        detail: "订单 SKU 还没有绑定实际库存，利润和出库都会不准。",
        action: "order-unbound",
        orderId: row.id,
        ...context
      }));
    } else if (work.key === "stock_issue") {
      tasks.push(exceptionTask({
        type: "order_stock_shortage",
        level: "danger",
        title: "订单库存不足",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${formatDateText(row.ordered_at)}`,
        detail: "已绑定库存但数量不足，需要采购或调整库存。",
        action: "order-unbound",
        orderId: row.id,
        ...context
      }));
    }
    if (profitValue < 0 && !["cancelled", "unbound"].includes(work.key)) {
      tasks.push(exceptionTask({
        type: "profit",
        level: "danger",
        title: "订单利润为负",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ¥${profitValue.toFixed(2)}`,
        detail: "通常是库存绑定、克重、佣金或物流规则异常，需要核验并重算利润。",
        action: "order-profit",
        orderId: row.id,
        ...context
      }));
    }
    const deadlineInfo = orderExceptionDeadlineInfoV4(row);
    if (deadlineInfo) {
      tasks.push(exceptionTask({
        type: "deadline",
        level: deadlineInfo.level || "danger",
        title: deadlineInfo.reason,
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${deadlineInfo.meta}`,
        detail: deadlineInfo.detail,
        action: "order-overdue",
        orderId: row.id,
        deadline_reason: deadlineInfo.reason,
        deadline_kind: deadlineInfo.kind,
        deadline_level: deadlineInfo.level,
        deadline_stage: deadlineInfo.stage,
        deadline_start_at: deadlineInfo.startAt,
        deadline_due_at: deadlineInfo.dueAt,
        deadline_elapsed_days: deadlineInfo.elapsedDays,
        deadline_standard_days: deadlineInfo.standardDays,
        deadline_overdue_days: deadlineInfo.overdueDays,
        deadline_warning_days: deadlineInfo.warningDays,
        deadline_danger_days: deadlineInfo.dangerDays,
        deadline_shipping_method: deadlineInfo.shippingMethod,
        deadline_shipping_method_key: deadlineInfo.shippingMethodKey,
        deadline_basis: deadlineInfo.basis,
        ...context
      }));
    }
  }
  for (const row of stockAlerts().rows || []) {
    for (const warning of row.warnings || []) {
      if (!["local", "fbp", "fbs", "mapping"].includes(warning.type)) continue;
      tasks.push(exceptionTask({
        type: `stock_${warning.type}`,
        level: warning.level || "warning",
        title: warning.text || "库存预警",
        subject: row.product_name || row.inventory_id || `库存 ${row.product_id}`,
        meta: `${row.inventory_id || ""} / 本地 ${row.local_stock ?? 0}`,
        detail: row.suggestion || "需要人工核验库存和 SKU 绑定关系。",
        action: `stock-${warning.type}`,
        productId: row.product_id,
        image_url: row.image_url || "",
        product_name: row.product_name || row.inventory_id || "",
        inventory_id: row.inventory_id || "",
        sku_text: stockAlertSkuText(row)
      }));
    }
  }
  tasks.sort((a, b) => exceptionPriorityValue(b) - exceptionPriorityValue(a));
  const stateMap = exceptionTaskStateMap(tasks.map((task) => task.id));
  const openTasks = [];
  const resolvedTasks = [];
  for (const task of tasks) {
    const state = stateMap.get(task.id);
    const decoratedTask = decorateExceptionTaskState(task, state);
    if (["handled", "ignored"].includes(state?.status)) resolvedTasks.push(decoratedTask);
    else openTasks.push(decoratedTask);
  }
  const payload = {
    openTasks,
    resolvedTasks,
    counts: exceptionWorkbenchCounts(openTasks),
    generatedAt: new Date().toISOString()
  };
  exceptionWorkbenchCache = { createdAt: now, payload };
  return payload;
}

export function updateExceptionTaskState(body = {}, userId = null) {
  const taskId = String(body.task_id || body.id || "").trim();
  if (!taskId) throw new Error("缺少异常任务 ID");
  const status = String(body.status || "handled").trim();
  if (!["open", "handled", "ignored"].includes(status)) throw new Error("异常任务状态不正确");
  if (status === "open") {
    db.prepare("DELETE FROM exception_task_states WHERE task_id = ?").run(taskId);
    return { ok: true, task_id: taskId, status };
  }
  db.prepare(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(taskId, status, String(body.note || ""), userId || null);
  return { ok: true, task_id: taskId, status };
}

let qualityPrefixCache = null;

function exceptionTaskStateMap(taskIds = []) {
  const ids = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = allLocal(`
    SELECT task_id, status, note, updated_at
    FROM exception_task_states
    WHERE task_id IN (${ids.map(() => "?").join(",")})
  `, ids);
  return new Map(rows.map((row) => [row.task_id, row]));
}

function exceptionTask(values) {
  return { id: randomTaskId(values), ...values };
}

function decorateExceptionTaskState(task, state) {
  if (!state?.status) return { ...task, task_state: "open", task_state_label: "" };
  const labels = {
    handled: "已处理",
    ignored: "已忽略"
  };
  return {
    ...task,
    task_state: state.status,
    task_state_label: labels[state.status] || state.status,
    task_state_updated_at: state.updated_at || ""
  };
}

function exceptionOrderContext(row) {
  const productName = firstCsvValue(row.product_names) || firstMappedValue(row.sku_names) || row.posting_number || "";
  const skuText = firstCsvValue(row.skus || row.unbound_skus);
  const inventoryId = firstCsvValue(row.inventory_ids || row.product_codes);
  const orderImageUrl = firstCsvValue(row.order_image_urls) || firstMappedValue(row.sku_images);
  const inventoryImageUrl = firstCsvValue(row.inventory_image_urls);
  const imageUrl = orderImageUrl || inventoryImageUrl || firstCsvValue(row.image_urls);
  const weight = firstCsvValue(row.package_weights);
  const dimensions = firstCsvValue(row.package_dimensions);
  const skuStock = firstSkuStockSummary(row.sku_stock_summaries, skuText);
  const revenue = Number(row.revenue || 0);
  const profit = displayOrderProfitValue(row);
  const margin = revenue ? profit / revenue * 100 : 0;
  const realShipping = resolvedExceptionShippingMethodLabel(row);
  const inventoryShipping = shippingMethodText(row.product_shipping_methods);
  const shippingDiff = realShipping && inventoryShipping && realShipping !== inventoryShipping;
  const shippingBadge = shippingDiff ? `真实 ${realShipping} / 库存 ${inventoryShipping}` : (realShipping || inventoryShipping || "未标明");
  const costLines = [
    ["采购成本", row.profit_purchase_cost],
    ["国内运费", row.profit_domestic_shipping],
    ["国际运费", row.profit_international_shipping],
    ["佣金", row.profit_commission_fee],
    ["Ozon服务费", row.profit_ozon_service_fee],
    ["退货损失", row.profit_return_loss]
  ].map(([label, value]) => `${label} ${moneyTextCompact(value)}`);
  return {
    image_url: imageUrl,
    order_image_url: orderImageUrl || imageUrl,
    inventory_image_url: inventoryImageUrl,
    product_name: productName === "Unbound product" ? "待绑定库存商品" : productName,
    sku_text: skuText,
    inventory_id: inventoryId && inventoryId !== "UNBOUND" ? inventoryId : "",
    dimensions_text: [weight ? `克重 ${weight}g` : "", dimensions && dimensions !== "0x0x0" ? `尺寸 ${dimensions}cm` : ""].filter(Boolean).join(" / "),
    profit_context_text: profitExceptionContextText(row),
    shop_name: row.shop_name || "",
    order_ref: row.posting_number || row.order_number || "",
    tracking_number: row.tracking_number || "",
    external_tracking_url: row.external_tracking_url || "",
    ordered_at: row.ordered_at || row.created_at || "",
    delivered_at: row.delivered_at || "",
    accrued_at: row.accrued_at || "",
    delivery_date_begin: row.delivery_date_begin || "",
    delivery_date_end: row.delivery_date_end || "",
    delivery_type: row.delivery_type || "",
    delivery_city: row.delivery_city || "",
    order_status_text: orderExceptionStatusText(row),
    current_order_shipping_text: realShipping || inventoryShipping || "",
    delivery_method_name: row.delivery_method_name || "",
    logistics_channel: row.logistics_channel || "",
    warehouse_name: row.warehouse_name || "",
    weight_text: weight ? `${weight}g` : "",
    size_text: dimensions && dimensions !== "0x0x0" ? `${dimensions}cm` : "",
    shipping_method_text: shippingBadge,
    shipping_method_real_text: realShipping,
    shipping_method_inventory_text: inventoryShipping,
    shipping_method_mismatch: shippingDiff,
    profit_formula_lines: [
      `售价 ${moneyTextCompact(revenue)}`,
      `利润 ${moneyTextCompact(profit)}`,
      `利润率 ${numText(margin, 2)}%`
    ],
    profit_cost_lines: costLines,
    mappingId: Number(firstMappedId(row.sku_mapping_ids, skuText)) || undefined,
    onlineProductId: Number(firstMappedId(row.sku_online_product_ids, skuText)) || undefined,
    sku_stock_fbs: skuStock.fbs,
    sku_stock_fbp: skuStock.fbp,
    productId: Number(firstCsvValue(row.product_ids)) || undefined
  };
}

function profitExceptionContextText(row) {
  const revenue = Number(row.revenue || 0);
  const profit = displayOrderProfitValue(row);
  const margin = revenue ? profit / revenue * 100 : 0;
  const shipping = resolvedExceptionShippingMethodLabel(row) || shippingMethodText(row.product_shipping_methods);
  const costs = [
    ["采购", row.profit_purchase_cost],
    ["国内", row.profit_domestic_shipping],
    ["国际", row.profit_international_shipping],
    ["佣金", row.profit_commission_fee],
    ["Ozon服务估算", row.profit_ozon_service_fee],
    ["退货", row.profit_return_loss]
  ].map(([label, value]) => `${label}¥${roundMoney(value)}`).join(" / ");
  return `销售¥${roundMoney(revenue)} / 利润¥${roundMoney(profit)} / 利润率${roundMoney(margin)}% / 运送方式${shipping || "未标明"} / ${costs}`;
}

function displayOrderProfitValue(row = {}) {
  return Number(row.actual_profit || row.estimated_profit || 0);
}

function shippingMethodText(value) {
  const labels = {
    air: "空运",
    air_land: "陆空",
    land: "陆运"
  };
  const methods = [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  return methods.map((method) => labels[method] || method).join("+");
}

function exceptionShippingMethodLabel(row) {
  const text = `${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`.toLowerCase();
  if (text.includes("land") || text.includes("陆运")) return "陆运";
  if (text.includes("air land") || text.includes("air_land") || text.includes("陆空")) return "陆空";
  if (text.includes("air") || text.includes("空运")) return "空运";
  return "";
}

function detectExceptionShippingMethodKey(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.includes("air_land") || text.includes("air land") || text.includes("\u9646+\u7a7a") || text.includes("\u9646\u7a7a")) return "air_land";
  if (text.includes("\u9646\u8fd0") || text.includes("economy") || text.includes("budget") || text.includes("\u90ae\u653f") || /(^|[^a-z])land([^a-z]|$)/.test(text)) return "land";
  if (text.includes("standard") && (text.includes("extra small") || text.includes("fbp") || text.includes("pudo") || text.includes("courier"))) return "air_land";
  if (text.includes("\u7a7a\u8fd0") || /(^|[^a-z])air([^a-z]|$)/.test(text)) return "air";
  return "";
}

function resolvedExceptionShippingMethodLabel(row) {
  const key = detectExceptionShippingMethodKey(`${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`);
  if (key === "land") return "\u9646\u8fd0";
  if (key === "air_land") return "\u9646\u7a7a";
  if (key === "air") return "\u7a7a\u8fd0";
  return "";
}

function moneyTextCompact(value) {
  return `¥${roundMoney(value)}`;
}

function numText(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function firstCsvValue(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean)[0] || "";
}

function firstMappedValue(value) {
  const first = String(value || "").split("||").map((item) => item.trim()).filter(Boolean)[0] || "";
  const index = first.indexOf(":");
  return index >= 0 ? first.slice(index + 1).trim() : first;
}

function firstMappedId(value, preferredKey = "") {
  const entries = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const preferred = entries.find((item) => preferredKey && item.startsWith(`${preferredKey}:`));
  const first = preferred || entries[0] || "";
  const index = first.indexOf(":");
  return index >= 0 ? first.slice(index + 1).trim() : first;
}

function firstSkuStockSummary(value, preferredKey = "") {
  const entries = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const preferred = entries.find((item) => preferredKey && item.startsWith(`${preferredKey}:`));
  const first = preferred || entries[0] || "";
  const parts = first.split(":");
  return {
    fbs: Number(parts[1] || 0),
    fbp: Number(parts[2] || 0)
  };
}

function stockAlertSkuText(row) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  return skus.slice(0, 3).map((item) => [item.shop_name, item.ozon_sku, item.name].filter(Boolean).join(" / ")).join("；");
}

function randomTaskId(values) {
  return [values.type, values.orderId || values.productId || values.subject || "", values.title || ""].join(":");
}

function normalizeExceptionWorkbenchView(value) {
  return ["handled", "profit", "deadline", "deadline_warning", "pickup", "receipt", "payment", "cancelled", "stock", "binding"].includes(String(value || "")) ? String(value || "") : "profit";
}

function normalizeExceptionWorkbenchSortField(value) {
  if (String(value || "") === "elapsed") return "elapsed";
  return String(value || "") === "ordered_at" ? "ordered_at" : "priority";
}

function normalizeExceptionWorkbenchSortDirection(value) {
  return String(value || "").toLowerCase() === "asc" ? "asc" : "desc";
}

function exceptionTasksForView({ view = "profit", openTasks = [], resolvedTasks = [] } = {}) {
  if (view === "handled") return resolvedTasks;
  if (view === "profit") return openTasks.filter((item) => item.type === "profit");
  if (view === "deadline") return openTasks.filter((item) => item.type === "deadline" && ["delivery", "fulfillment"].includes(item.deadline_kind) && item.level === "danger");
  if (view === "deadline_warning") return openTasks.filter((item) => item.type === "deadline" && ["delivery", "fulfillment"].includes(item.deadline_kind) && item.level !== "danger");
  if (view === "pickup") return openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "pickup");
  if (view === "receipt") return openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "receipt");
  if (view === "payment") return openTasks.filter((item) => item.type === "deadline" && item.deadline_kind === "payment");
  if (view === "cancelled") return openTasks.filter((item) => item.type === "cancelled_order");
  if (view === "stock") return openTasks.filter((item) => item.type === "order_stock_shortage" || item.type?.startsWith("stock"));
  if (view === "binding") return openTasks.filter((item) => item.type === "order_binding");
  return openTasks.filter((item) => item.type === "profit");
}

function filterExceptionWorkbenchTasks(tasks = [], search = "") {
  const keyword = String(search || "").trim().toLowerCase();
  if (!keyword) return tasks;
  return tasks.filter((task) => exceptionWorkbenchSearchText(task).includes(keyword));
}

function exceptionWorkbenchSearchText(task = {}) {
  return [
    task.title,
    task.subject,
    task.meta,
    task.detail,
    task.product_name,
    task.sku_text,
    task.inventory_id,
    task.order_ref,
    task.shop_name,
    task.order_status_text,
    task.current_order_shipping_text,
    task.shipping_method_text
  ].filter(Boolean).join(" ").toLowerCase();
}

function sortExceptionWorkbenchTasks(tasks = [], sortField = "priority", sortDirection = "desc") {
  const factor = sortDirection === "asc" ? 1 : -1;
  return [...tasks].sort((left, right) => {
    if (sortField === "ordered_at") {
      const orderedDiff = compareExceptionWorkbenchTimes(left.ordered_at, right.ordered_at);
      if (orderedDiff) return orderedDiff * factor;
      const priorityDiff = exceptionPriorityValue(right) - exceptionPriorityValue(left);
      if (priorityDiff) return priorityDiff;
      return compareExceptionWorkbenchTimes(right.task_state_updated_at, left.task_state_updated_at);
    }
    if (sortField === "elapsed") {
      const elapsedDiff = Number(left.deadline_elapsed_days || 0) - Number(right.deadline_elapsed_days || 0);
      if (elapsedDiff) return elapsedDiff * factor;
      const overdueDiff = Number(left.deadline_overdue_days || 0) - Number(right.deadline_overdue_days || 0);
      if (overdueDiff) return overdueDiff * factor;
      const priorityDiff = exceptionPriorityValue(right) - exceptionPriorityValue(left);
      if (priorityDiff) return priorityDiff;
      return compareExceptionWorkbenchTimes(right.ordered_at, left.ordered_at);
    }
    const priorityDiff = exceptionPriorityValue(right) - exceptionPriorityValue(left);
    if (priorityDiff) return priorityDiff;
    return compareExceptionWorkbenchTimes(right.ordered_at, left.ordered_at);
  });
}

function compareExceptionWorkbenchTimes(leftValue, rightValue) {
  const left = parseDate(leftValue)?.getTime() || 0;
  const right = parseDate(rightValue)?.getTime() || 0;
  return left - right;
}

function exceptionPriorityValue(task) {
  const level = { danger: 3, warning: 2, info: 1 }[task.level] || 0;
  const typeBoost = task.type === "deadline" && task.deadline_kind === "fulfillment"
    ? 1.2
    : task.type === "deadline" && task.deadline_kind === "receipt"
      ? 1
    : task.type === "deadline" && task.deadline_kind === "payment"
      ? 0.9
    : task.type === "deadline" && task.deadline_kind === "pickup"
      ? 0.8
    : task.type === "deadline" && task.deadline_kind === "delivery"
      ? 0.6
      : task.type === "order_binding" ? 0.4 : task.type === "profit" ? 0.3 : 0;
  return level + typeBoost;
}

function orderMatchesBaseQuery(row, query) {
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all" && String(row.shop_id) !== shopId) return false;
  const value = chinaDateKey(row.ordered_at || row.created_at || "");
  const from = String(query.dateFrom || query.date_from || "");
  const to = String(query.dateTo || query.date_to || "");
  if (from && (!value || value < from)) return false;
  if (to && (!value || value > to)) return false;
  return orderMatchesSearchQuery(row, query);
}

function orderMatchesSearchQuery(row, query) {
  const text = String(query.searchQuery || query.search_query || "").trim().toLowerCase();
  if (!text) return true;
  const type = String(query.searchType || query.search_type || "order");
  if (type === "sku") return `${row.skus || ""} ${row.product_codes || ""} ${row.product_names || ""}`.toLowerCase().includes(text);
  if (type === "order") return `${row.posting_number || ""} ${row.order_number || ""}`.toLowerCase().includes(text);
  if (type === "product") return `${row.product_ids || ""} ${row.inventory_ids || ""} ${row.product_codes || ""} ${row.product_names || ""}`.toLowerCase().includes(text);
  if (type === "offer") return `${row.offer_ids || ""} ${row.product_codes || ""}`.toLowerCase().includes(text);
  if (type === "tracking") return `${row.tracking_number || ""} ${row.logistics_channel || ""}`.toLowerCase().includes(text);
  if (type === "purchaseTracking") return `${row.purchase_tracking_numbers || ""} ${row.purchase_order_numbers || ""}`.toLowerCase().includes(text);
  return true;
}

function orderTaskState(row) {
  const outcome = classifyOrderOutcome(row);
  if (outcome === "cancelled_pre_fulfillment") return { key: "cancelled", label: "已取消" };
  if (outcome === "rejected_unclaimed") return { key: "cancelled", label: "已拒收/未取" };
  if (outcome === "after_delivery_return") return { key: "cancelled", label: "签收后退货" };
  if (outcome === "delivered_signed") return { key: "delivered", label: "已签收" };
  if (orderMatchesStatusQuery(row, "cancelled")) return { key: "cancelled", label: "已取消/退货" };
  if (orderMatchesStatusQuery(row, "dispute")) return { key: "dispute", label: "有争议" };
  if (orderMatchesStatusQuery(row, "delivered")) return { key: "delivered", label: "已签收" };
  if (orderHasUnboundStockQuery(row)) return { key: "unbound", label: "待绑定库存" };
  if (orderHasStockIssue(row)) return { key: "stock_issue", label: "库存不足" };
  if (orderMatchesStatusQuery(row, "delivering")) return { key: "delivering", label: "运输中" };
  if (orderMatchesStatusQuery(row, "awaiting_deliver")) return { key: "awaiting_deliver", label: "等待发运" };
  if (orderMatchesStatusQuery(row, "awaiting_packaging")) return { key: "awaiting_packaging", label: "等待备货" };
  return { key: "awaiting_packaging", label: "等待备货" };
}

function orderExceptionDeadlineInfo(row) {
  if (orderMatchesStatusQuery(row, "cancelled") || orderMatchesStatusQuery(row, "delivered")) return null;
  const now = new Date();
  const deadline = parseDate(row.shipment_deadline_at);
  const shipped = orderMatchesStatusQuery(row, "delivering") || Boolean(row.tracking_number);
  if (!shipped && deadline && deadline < now) {
    return {
      reason: "发货超时",
      meta: `发货截止 ${formatDateText(row.shipment_deadline_at)}`,
      detail: "订单超过备货/发货截止时间仍未进入发运状态，需要优先处理。"
    };
  }
  if (!orderMatchesStatusQuery(row, "delivering")) return null;
  const orderedAt = parseDate(row.ordered_at);
  if (!orderedAt) return null;
  const shipping = resolvedExceptionShippingMethodKey(row);
  const threshold = shipping === "land" ? 20 : 15;
  const days = Math.floor((now.getTime() - orderedAt.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= threshold) return null;
  const methodLabel = shipping === "land" ? "陆运" : "陆空";
  return {
    reason: `签收超时-${methodLabel}`,
    meta: `${methodLabel} ${days} 天 / 标准 ${threshold} 天`,
    detail: `订单已进入运输但超过 ${methodLabel} 预计签收时长，需核验物流节点。`
  };
}

function orderExceptionDeadlineInfoV2(row) {
  if (orderMatchesStatusQuery(row, "cancelled") || orderIsDeliveredForDeadline(row)) return null;
  const now = new Date();
  const shipped = orderMatchesStatusQuery(row, "delivering") || Boolean(row.tracking_number);
  const fbp = logisticsModeKey(row) === "fbp";
  if (!shipped) {
    const orderedAt = parseDate(row.ordered_at || row.created_at);
    if (!orderedAt) return null;
    const standardDays = fbp ? 2 : 6;
    const dueAt = addDays(orderedAt, standardDays);
    const elapsedDays = elapsedCalendarDays(dueAt, now);
    if (elapsedDays <= 0) return null;
    return {
      kind: "fulfillment",
      stage: fbp ? "FBP备货超时" : "FBS备货超时",
      level: "danger",
      reason: fbp ? "FBP备货超时" : "FBS备货超时",
      meta: `${fbp ? "FBP" : "FBS"} 已用 ${elapsedDays} 天 / 标准 ${standardDays} 天`,
      detail: `订单还没有发走，${fbp ? "FBP" : "FBS"} 标准备货时长 ${standardDays} 天，当前已用 ${elapsedDays} 天，超出 ${elapsedDays - standardDays} 天。`,
      startAt: dueAt.toISOString(),
      dueAt: dueAt.toISOString(),
      elapsedDays,
      standardDays,
      overdueDays: elapsedDays,
      warningDays: standardDays,
      dangerDays: standardDays + 1,
      shippingMethod: fbp ? "FBP" : "FBS",
      shippingMethodKey: fbp ? "fbp" : "fbs",
      basis: "fulfillment_due_at"
    };
  }
  if (!orderMatchesStatusQuery(row, "delivering")) return null;
  const shippedAt = deliveryStartDate(row);
  if (!shippedAt) return null;
  const shipping = resolvedExceptionShippingMethodKey(row);
  const warningDays = shipping === "land" ? 20 : 15;
  const dangerDays = shipping === "land" ? 25 : 20;
  const elapsedDays = elapsedCalendarDays(shippedAt, now);
  if (elapsedDays <= warningDays) return null;
  const level = elapsedDays > dangerDays ? "danger" : "warning";
  const methodLabel = shipping === "land" ? "陆运" : "陆空";
  return {
    kind: "delivery",
    stage: level === "danger" ? "签收严重超时" : "签收预警",
    level,
    reason: level === "danger" ? `签收严重超时-${methodLabel}` : `签收预警-${methodLabel}`,
    meta: `${methodLabel} 已配送 ${elapsedDays} 天 / 预警 ${warningDays} 天 / 严重 ${dangerDays} 天`,
    detail: `订单已发走但未签收，${methodLabel} 默认配送时效 ${warningDays} 天，超过 ${dangerDays} 天按严重超时处理。当前已配送 ${elapsedDays} 天。`,
    startAt: shippedAt.toISOString(),
    dueAt: addDays(shippedAt, warningDays).toISOString(),
    elapsedDays,
    standardDays: warningDays,
    overdueDays: elapsedDays - warningDays,
    warningDays,
    dangerDays,
    shippingMethod: methodLabel,
    shippingMethodKey: shipping,
    basis: "shipping_elapsed"
  };
}

function deliveryStartDate(row) {
  return parseDate(row.shipped_at)
    || parseDate(row.delivering_date)
    || parseDate(row.in_process_at)
    || parseDate(row.shipment_deadline_at)
    || parseDate(row.ordered_at || row.created_at);
}

function orderExceptionDeadlineInfoV4(row) {
  if (orderIsCancelledForDeadlineV2(row)) return null;
  if (orderProfitAccrued(row)) return null;
  const now = new Date();
  const stageKey = orderLogisticsStageKey(row);
  if (stageKey === "received") return orderPaymentTimeoutInfo(row, now);
  const shipped = orderMatchesStatusQuery(row, "delivering") || Boolean(row.tracking_number);
  const fbp = logisticsModeKey(row) === "fbp";
  if (!shipped) return orderFulfillmentTimeoutInfo(row, now, fbp);
  if (!orderMatchesStatusQuery(row, "delivering")) return null;
  if (stageKey === "pickup_point") return orderPickupOrReceiptTimeoutInfo(row, now);
  return orderDeliveryTimeoutInfo(row, now);
}

function orderFulfillmentTimeoutInfo(row, now, fbp) {
  const orderedAt = parseDate(row.ordered_at || row.created_at);
  if (!orderedAt) return null;
  const standardDays = fbp ? 2 : 6;
  const dueAt = addDays(orderedAt, standardDays);
  const elapsedDays = elapsedCalendarDays(dueAt, now);
  if (elapsedDays <= 0) return null;
  const modeLabel = fbp ? "FBP" : "FBS";
  return {
    kind: "fulfillment",
    stage: `${modeLabel}备货超时`,
    level: "danger",
    reason: `${modeLabel}备货超时`,
    meta: `${modeLabel} 已超时 ${elapsedDays} 天 / 标准 ${standardDays} 天`,
    detail: `订单还没有发走，${modeLabel} 标准备货时长 ${standardDays} 天，已经超过应发截止 ${elapsedDays} 天。`,
    startAt: dueAt.toISOString(),
    dueAt: dueAt.toISOString(),
    elapsedDays,
    standardDays,
    overdueDays: elapsedDays,
    warningDays: standardDays,
    dangerDays: standardDays + 1,
    shippingMethod: modeLabel,
    shippingMethodKey: fbp ? "fbp" : "fbs",
    basis: "fulfillment_due_at"
  };
}

function orderDeliveryTimeoutInfo(row, now) {
  const shippedAt = deliveryStartDate(row);
  if (!shippedAt) return null;
  const shipping = resolvedExceptionShippingMethodKey(row);
  const warningDays = shipping === "land" ? 20 : 15;
  const dangerDays = shipping === "land" ? 25 : 20;
  const elapsedDays = elapsedCalendarDays(shippedAt, now);
  if (elapsedDays <= warningDays) return null;
  const level = elapsedDays > dangerDays ? "danger" : "warning";
  const methodLabel = shipping === "land" ? "陆运" : "陆空";
  const deliveryDueAt = parseDate(row.delivery_date_end) || parseDate(row.delivery_date_begin);
  const dueNote = deliveryDueAt ? `Ozon预计送达：${formatDateText(deliveryDueAt.toISOString())}` : "Ozon预计送达未标明";
  return {
    kind: "delivery",
    stage: level === "danger" ? "运输严重超时" : "运输超时预警",
    level,
    reason: level === "danger" ? `运输严重超时-${methodLabel}` : `运输超时预警-${methodLabel}`,
    meta: `${methodLabel} 已运输 ${elapsedDays} 天 / 预警 ${warningDays} 天 / 红线 ${dangerDays} 天`,
    detail: `订单已发货且仍在运输中，尚未到达取货点。${methodLabel} 超过 ${warningDays} 天进入运输超时预警，超过 ${dangerDays} 天按运输严重超时处理。${dueNote}。`,
    startAt: shippedAt.toISOString(),
    dueAt: addDays(shippedAt, warningDays).toISOString(),
    elapsedDays,
    standardDays: warningDays,
    overdueDays: elapsedDays - warningDays,
    warningDays,
    dangerDays,
    shippingMethod: methodLabel,
    shippingMethodKey: shipping,
    basis: "shipping_elapsed"
  };
}

function orderPickupOrReceiptTimeoutInfo(row, now) {
  const pickupAt = pickupPointStartDate(row);
  if (!pickupAt) return null;
  const standardDays = 3;
  const dangerDays = 5;
  const elapsedDays = elapsedCalendarDays(pickupAt, now);
  if (elapsedDays <= standardDays) return null;
  const level = elapsedDays > dangerDays ? "danger" : "warning";
  return {
    kind: level === "danger" ? "receipt" : "pickup",
    stage: level === "danger" ? "待取超时>5天" : "待取超时≤5天",
    level,
    reason: level === "danger" ? "待取超时>5天" : "待取超时≤5天",
    meta: `到达取货点 ${elapsedDays} 天 / 待取 ${standardDays} 天 / 红线 ${dangerDays} 天`,
    detail: "物流已到达取货点，客户仍未取货。超过 3 天归为待取超时，超过 5 天归为签收超时。",
    startAt: pickupAt.toISOString(),
    dueAt: addDays(pickupAt, standardDays).toISOString(),
    elapsedDays,
    standardDays,
    overdueDays: elapsedDays - standardDays,
    warningDays: standardDays,
    dangerDays,
    shippingMethod: resolvedExceptionShippingMethodLabel(row) || "未标明",
    shippingMethodKey: resolvedExceptionShippingMethodKey(row),
    basis: "pickup_point_elapsed"
  };
}

function orderPaymentTimeoutInfo(row, now) {
  const receivedAt = receivedStartDate(row);
  if (!receivedAt || orderProfitAccrued(row)) return null;
  const standardDays = 5;
  const dangerDays = 10;
  const elapsedDays = elapsedCalendarDays(receivedAt, now);
  if (elapsedDays <= standardDays) return null;
  return {
    kind: "payment",
    stage: "付款超时",
    level: elapsedDays > dangerDays ? "danger" : "warning",
    reason: "付款超时",
    meta: `已签收 ${elapsedDays} 天 / 标准 ${standardDays} 天`,
    detail: "订单已签收，但利润或结算状态还没有进入已结算，需要检查 Ozon 回款或结算数据。",
    startAt: receivedAt.toISOString(),
    dueAt: addDays(receivedAt, standardDays).toISOString(),
    elapsedDays,
    standardDays,
    overdueDays: elapsedDays - standardDays,
    warningDays: standardDays,
    dangerDays,
    shippingMethod: resolvedExceptionShippingMethodLabel(row) || "未标明",
    shippingMethodKey: resolvedExceptionShippingMethodKey(row),
    basis: "payment_after_received"
  };
}

function orderLogisticsStageKey(row) {
  if (orderProfitAccrued(row)) return "received";
  const text = deadlineStatusTextV4(row);
  if (text.includes("posting_received") || text.includes("delivered") || text.includes("received") || text.includes("pickup_code_verified")) return "received";
  if (text.includes("posting_in_pickup_point") || text.includes("pickup_point")) return "pickup_point";
  if (text.includes("customs")) return "customs";
  if (text.includes("posting_on_way_to_city") || text.includes("on_way_to_city")) return "on_way_to_city";
  if (text.includes("posting_registered") || text.includes("awaiting_deliver")) return "registered";
  return "unknown";
}

function deadlineStatusTextV4(row) {
  return [
    row.status,
    row.tracking_stage,
    row.logistics_status,
    row.raw_status,
    row.raw_substatus,
    row.raw_tracking_stage,
    row.raw_cancellation_reason,
    row.pickup_code_verified_at,
    row.settlement_states,
    row.profit_statuses
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function pickupPointStartDate(row) {
  return parseDate(row.delivery_date_begin)
    || parseDate(row.delivery_date_end)
    || parseDate(row.delivering_date)
    || deliveryStartDate(row);
}

function receivedStartDate(row) {
  return parseDate(row.delivered_at)
    || parseDate(row.pickup_code_verified_at)
    || parseDate(row.delivery_date_end)
    || parseDate(row.delivery_date_begin)
    || deliveryStartDate(row);
}

function orderProfitAccrued(row) {
  const text = `${row.settlement_states || ""} ${row.profit_statuses || ""}`.toLowerCase();
  return text.includes("accrued") && !text.includes("pending") && !text.includes("estimated");
}

function orderIsTerminalForDeadlineV2(row) {
  return orderIsCancelledForDeadlineV2(row) || orderIsDeliveredForDeadlineV2(row);
}

function orderIsCancelledForDeadlineV2(row) {
  const outcome = classifyOrderOutcome(row);
  if (["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcome)) return true;
  const text = deadlineStatusText(row);
  return text.includes("cancel")
    || text.includes("canceled")
    || text.includes("cancelled")
    || text.includes("posting_canceled")
    || text.includes("not_accepted")
    || text.includes("return")
    || text.includes("returned")
    || text.includes("refund")
    || text.includes("rejected")
    || text.includes("отмен")
    || text.includes("возврат")
    || text.includes("не удалось")
    || text.includes("отказ")
    || text.includes("не забрал")
    || text.includes("取消")
    || text.includes("退货");
}

function orderIsDeliveredForDeadlineV2(row) {
  const outcome = classifyOrderOutcome(row);
  if (outcome === "delivered_signed") return true;
  if (orderIsCancelledForDeadlineV2(row)) return false;
  const text = deadlineStatusText(row);
  return text.includes("delivered")
    || text.includes("posting_received")
    || text.includes("received")
    || text.includes("signed")
    || text.includes("pickup_code_verified")
    || text.includes("签收")
    || text.includes("已签收")
    || text.includes("已领取")
    || text.includes("已送达");
}

function deadlineStatusText(row) {
  return [
    row.status,
    row.tracking_stage,
    row.logistics_status,
    row.raw_status,
    row.raw_substatus,
    row.raw_cancellation_reason,
    row.pickup_code_verified_at
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function orderExceptionDeadlineInfoV3(row) {
  if (orderIsTerminalForDeadlineV2(row)) return null;
  const now = new Date();
  const shipped = orderMatchesStatusQuery(row, "delivering") || Boolean(row.tracking_number);
  const fbp = logisticsModeKey(row) === "fbp";
  if (!shipped) {
    const orderedAt = parseDate(row.ordered_at || row.created_at);
    if (!orderedAt) return null;
    const standardDays = fbp ? 2 : 6;
    const dueAt = addDays(orderedAt, standardDays);
    const elapsedDays = elapsedCalendarDays(dueAt, now);
    if (elapsedDays <= 0) return null;
    const modeLabel = fbp ? "FBP" : "FBS";
    return {
      kind: "fulfillment",
      stage: `${modeLabel}备货超时`,
      level: "danger",
      reason: `${modeLabel}备货超时`,
      meta: `${modeLabel} 已超时 ${elapsedDays} 天 / 标准 ${standardDays} 天`,
      detail: `订单还没有发走，${modeLabel} 标准备货时长 ${standardDays} 天，已经超过应发截止 ${elapsedDays} 天。`,
      startAt: dueAt.toISOString(),
      dueAt: dueAt.toISOString(),
      elapsedDays,
      standardDays,
      overdueDays: elapsedDays,
      warningDays: standardDays,
      dangerDays: standardDays + 1,
      shippingMethod: modeLabel,
      shippingMethodKey: fbp ? "fbp" : "fbs",
      basis: "fulfillment_due_at"
    };
  }
  if (!orderMatchesStatusQuery(row, "delivering")) return null;
  const shippedAt = deliveryStartDate(row);
  if (!shippedAt) return null;
  const shipping = resolvedExceptionShippingMethodKey(row);
  const warningDays = shipping === "land" ? 20 : 15;
  const dangerDays = shipping === "land" ? 25 : 20;
  const elapsedDays = elapsedCalendarDays(shippedAt, now);
  if (elapsedDays <= warningDays) return null;
  const level = elapsedDays > dangerDays ? "danger" : "warning";
  const methodLabel = shipping === "land" ? "陆运" : "陆空";
  return {
    kind: "delivery",
    stage: level === "danger" ? "签收严重超时" : "签收预警",
    level,
    reason: level === "danger" ? `签收严重超时-${methodLabel}` : `签收预警-${methodLabel}`,
    meta: `${methodLabel} 已配送 ${elapsedDays} 天 / 预警 ${warningDays} 天 / 严重 ${dangerDays} 天`,
    detail: `订单已发走但未签收，${methodLabel} 默认配送时效 ${warningDays} 天，超过 ${dangerDays} 天按严重超时处理。当前已配送 ${elapsedDays} 天。`,
    startAt: shippedAt.toISOString(),
    dueAt: addDays(shippedAt, warningDays).toISOString(),
    elapsedDays,
    standardDays: warningDays,
    overdueDays: elapsedDays - warningDays,
    warningDays,
    dangerDays,
    shippingMethod: methodLabel,
    shippingMethodKey: shipping,
    basis: "shipping_elapsed"
  };
}

function orderIsDeliveredForDeadline(row) {
  const text = [
    row.status,
    row.tracking_stage,
    row.logistics_status
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  if (orderMatchesStatusQuery(row, "cancelled")) return false;
  return text.includes("delivered")
    || text.includes("signed")
    || text.includes("received")
    || text.includes("签收")
    || text.includes("已签收")
    || text.includes("已领取")
    || text.includes("已送达");
}

function elapsedCalendarDays(from, to) {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

function addDays(value, days) {
  const date = new Date(value.getTime());
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

function exceptionShippingMethodKey(row) {
  const text = `${row.product_shipping_methods || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`.toLowerCase();
  if (text.includes("land") || text.includes("陆运")) return "land";
  return "air_land";
}

function exceptionTodayDateKey() {
  return chinaDateKey();
}

function resolvedExceptionShippingMethodKey(row) {
  const key = detectExceptionShippingMethodKey(`${row.product_shipping_methods || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`);
  return key === "land" ? "land" : "air_land";
}

function formatDateText(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "-";
}

function orderRowsByIds(ids) {
  const cleanIds = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!cleanIds.length) return [];
  const rows = allLocal(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 0 ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.quantity, '||') AS sku_quantities,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.sale_price || ':' || oi.quantity, '||') AS sku_prices,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), ''), '||') AS sku_names,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), ''), '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN oi.ozon_sku || ':' || p.id END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN oi.ozon_sku || ':' || op.id END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN oi.ozon_sku || ':' || sm.id END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.length_cm, 0) || 'x' || COALESCE(p.width_cm, 0) || 'x' || COALESCE(p.height_cm, 0) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    WHERE o.id IN (${cleanIds.map(() => "?").join(",")})
    GROUP BY o.id
  `, cleanIds).map(enrichOrderLogistics);
  const order = new Map(cleanIds.map((value, index) => [String(value), index]));
  return rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
}

function orderBaseSql(query = {}) {
  const where = ["1 = 1"];
  const params = [];
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all") {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  const from = normalizeSyncDate(query.dateFrom || query.date_from);
  const to = normalizeSyncDate(query.dateTo || query.date_to);
  if (from) {
    where.push(`${chinaDateSql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${chinaDateSql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  addOrderSearchSql(where, params, query);
  return { where: where.join(" AND "), params };
}

function orderFilteredSql(query, base) {
  const where = [base.where];
  const params = [...base.params];
  where.push(orderStatusSql(query.status || "all"));
  const mark = String(query.markFilter || query.mark_filter || "all");
  if (mark === "quality") {
    const prefixes = orderQualityPrefixes();
    const qualityParts = ["COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?"];
    params.push("quality");
    for (const prefix of prefixes) {
      qualityParts.push("o.posting_number LIKE ?");
      params.push(`${prefix}%`);
    }
    where.push(`(${qualityParts.join(" OR ")})`);
  } else if (mark !== "all") {
    where.push("COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?");
    params.push(mark);
  }
  const print = String(query.printFilter || query.print_filter || "all");
  if (print === "printed") where.push("EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  if (print === "unprinted") where.push("NOT EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  return { joins: "", where: where.filter(Boolean).join(" AND "), params };
}

function orderPagedSqlCounts(base) {
  const statuses = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "dispute", "delivered", "cancelled", "unbound"];
  const counts = {};
  for (const status of statuses) {
    const where = status === "all" ? base.where : `${base.where} AND ${orderStatusSql(status)}`;
    counts[status] = Number(getLocal(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, base.params)?.count || 0);
  }
  return counts;
}

function addOrderSearchSql(where, params, query) {
  const text = String(query.searchQuery || query.search_query || "").trim();
  if (!text) return;
  const like = `%${text.toLowerCase()}%`;
  const type = String(query.searchType || query.search_type || "order");
  if (type === "order") {
    where.push("(LOWER(o.posting_number) LIKE ? OR LOWER(COALESCE(o.order_number, '')) LIKE ?)");
    params.push(like, like);
    return;
  }
  if (type === "tracking") {
    where.push("(LOWER(COALESCE(o.tracking_number, '')) LIKE ? OR LOWER(COALESCE(o.logistics_status, '')) LIKE ? OR LOWER(COALESCE(o.tracking_stage, '')) LIKE ?)");
    params.push(like, like, like);
    return;
  }
  if (type === "sku") {
    where.push("EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND LOWER(oi.ozon_sku || ' ' || COALESCE(oi.ozon_name, '')) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "offer") {
    where.push("EXISTS (SELECT 1 FROM order_items oi LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id WHERE oi.order_id = o.id AND LOWER(COALESCE(sm.offer_id, '') || ' ' || oi.ozon_sku) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "product") {
    where.push(`EXISTS (
      SELECT 1 FROM order_items oi
      LEFT JOIN sku_mappings sm ON (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku)) AND sm.active = 1
      LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
      WHERE oi.order_id = o.id AND LOWER(COALESCE(p.name, '') || ' ' || COALESCE(p.code, '') || ' ' || COALESCE(p.selection_id, '') || ' ' || oi.ozon_sku) LIKE ?
    )`);
    params.push(like);
  }
}

function orderStatusSql(status) {
  if (status === "all") return "1 = 1";
  if (status === "unbound") return `EXISTS (
    SELECT 1 FROM order_items oi
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    WHERE oi.order_id = o.id AND p.id IS NULL
  )`;
  const outcome = buildOrderOutcomeSql("o");
  const state = "LOWER(COALESCE(o.status, ''))";
  const stage = "LOWER(COALESCE(o.tracking_stage, ''))";
  const value = `(${state} || ' ' || ${stage} || ' ' || LOWER(COALESCE(o.logistics_status, '')) || ' ' || LOWER(COALESCE(o.tracking_number, '')))`; 
  if (status === "awaiting_packaging") return orderSqlAnyExact([state, stage], ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"]);
  if (status === "awaiting_deliver") return `(${orderSqlAnyExact([state, stage], ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"])} AND NOT (${orderSqlFbpLogistics()}))`;
  if (status === "dispute") return `(${value} LIKE '%arbitration%' OR ${value} LIKE '%dispute%')`;
  if (status === "cancelled") return `(${outcome.cancelledPreFulfillment} OR ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn})`;
  if (status === "delivered") return `(${outcome.deliveredSigned})`;
  if (status === "cancelled") return `(${value} LIKE '%cancel%' OR ${value} LIKE '%return%' OR ${value} LIKE '%not_accepted%')`;
  if (status === "delivered") return `(${value} LIKE '%delivered%' AND NOT (${orderStatusSql("cancelled")}))`;
  if (status === "delivering") return `(
    ${value} NOT LIKE '%awaiting_packaging%' AND ${value} NOT LIKE '%awaiting_deliver%' AND ${value} NOT LIKE '%pending_stock%'
    AND (${value} LIKE '%delivering%' OR ${value} LIKE '%transferring%' OR ${value} LIKE '%carriage%' OR ${value} LIKE '%pickup%' OR ${value} LIKE '%sorting%' OR ${value} LIKE '%customs%' OR ${value} LIKE '%shipped%' OR ${value} LIKE '%sent%' OR ${value} LIKE '%on_way%' OR ${value} LIKE '%posting_in_carriage%' OR ${value} LIKE '%posting_transferring%' OR ${value} LIKE '%发往%' OR ${value} LIKE '%已上网%' OR ${value} LIKE '%发走%')
  )`;
  return "1 = 1";
}

function orderSqlFbpLogistics() {
  return `EXISTS (
    SELECT 1 FROM ozon_orders_raw raw
    WHERE raw.store_id = o.shop_id
      AND raw.posting_number = o.posting_number
      AND (
        LOWER(raw.raw_json) LIKE '%fbp%'
        OR LOWER(raw.raw_json) LIKE '%hunchun%'
        OR LOWER(raw.raw_json) LIKE '%hun chun%'
        OR raw.raw_json LIKE '%珲春%'
        OR raw.raw_json LIKE '%混春%'
        OR raw.raw_json LIKE '%混川%'
      )
  )`;
}

function orderMatchesStatusQuery(row, status) {
  if (status === "all") return true;
  if (status === "unbound") return orderHasUnboundStockQuery(row);
  const outcome = classifyOrderOutcome(row);
  if (status === "cancelled") return ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcome);
  if (status === "delivered") return outcome === "delivered_signed";
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (status === "awaiting_packaging") return values.some((value) => ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"].includes(value));
  if (status === "awaiting_deliver") return logisticsModeKey(row) !== "fbp" && values.some((value) => ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"].includes(value));
  if (status === "delivering") {
    const text = [row.status, row.tracking_stage, row.logistics_status, row.delivery_method_name, row.logistics_channel].map((value) => String(value || "").toLowerCase()).join(" ");
    if (text.includes("awaiting_packaging") || text.includes("awaiting_deliver") || text.includes("pending_stock")) return false;
    return ["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "posting_in_carriage", "posting_transferring", "发往", "已上网", "发走"].some((keyword) => text.includes(keyword));
  }
  if (status === "dispute") return values.some((value) => value.includes("arbitration") || value.includes("dispute"));
  if (status === "delivered") return values.some((value) => value.includes("delivered")) && !orderMatchesStatusQuery(row, "cancelled");
  if (status === "cancelled") return values.some((value) => value.includes("cancel") || value.includes("return") || value === "not_accepted" || value.includes("not_accepted"));
  return false;
}

function orderExceptionStatusText(row) {
  const outcome = classifyOrderOutcome(row);
  if (outcome === "cancelled_pre_fulfillment") return "已取消";
  if (outcome === "rejected_unclaimed") return "已拒收/未取";
  if (outcome === "after_delivery_return") return "签收后退货";
  if (outcome === "delivered_signed") return "已签收";
  const stageKey = orderLogisticsStageKey(row);
  if (stageKey === "received") return orderProfitAccrued(row) ? "已签收/已结算" : "已签收/待结算";
  if (stageKey === "pickup_point") return "到达取货点/待客户取件";
  if (stageKey === "customs") return "清关中";
  if (stageKey === "on_way_to_city") return "运往目的城市";
  if (stageKey === "registered") return "已登记/等待发运";
  if (orderMatchesStatusQuery(row, "cancelled")) return "已取消/退货";
  if (orderMatchesStatusQuery(row, "delivered")) return "已签收";
  if (orderMatchesStatusQuery(row, "delivering")) return "配送中";
  if (orderMatchesStatusQuery(row, "awaiting_deliver")) return "等待发运";
  if (orderMatchesStatusQuery(row, "awaiting_packaging")) return "等待备货";
  if (orderMatchesStatusQuery(row, "dispute")) return "争议中";
  return row.tracking_stage || row.status || row.logistics_status || "待处理";
}

function orderHasUnboundStockQuery(row) {
  if (Number(row.unbound_item_count || 0) > 0 || Number(row.unbound_quantity || 0) > 0) return true;
  if (String(row.unbound_skus || "").trim()) return true;
  return String(row.product_codes || "").toUpperCase().split(",").map((item) => item.trim()).includes("UNBOUND")
    || String(row.product_names || "").toLowerCase().includes("unbound product")
    || String(row.product_names || "").includes("未绑定");
}

function orderHasStockIssue(row) {
  const totalQuantity = Number(row.total_quantity || 0);
  const stockValues = String(row.available_stocks || row.current_stocks || row.stocks || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  if (!totalQuantity || !stockValues.length) return false;
  return stockValues.some((stock) => stock > 0 && stock < totalQuantity);
}

function orderSqlAnyExact(columns, values) {
  const terms = [];
  for (const column of columns) {
    terms.push(`${column} IN (${values.map((value) => `'${value}'`).join(",")})`);
  }
  return `(${terms.join(" OR ")})`;
}

function orderSqlSort(query) {
  const mode = String(query.sortMode || query.sort_mode || "ordered");
  if (mode === "inventory") return "ORDER BY o.ordered_at DESC";
  if (String(query.status || "") === "awaiting_packaging") return "ORDER BY o.ordered_at DESC";
  return "ORDER BY o.ordered_at DESC";
}

function sortPagedOrders(rows, query) {
  const mode = String(query.sortMode || query.sort_mode || "ordered");
  const status = String(query.status || "all");
  return [...rows].sort((a, b) => {
    if (mode === "inventory") {
      const key = orderInventoryPagedSortKey(a).localeCompare(orderInventoryPagedSortKey(b), "zh-Hans", { numeric: true });
      if (key) return key;
    } else if (status === "awaiting_packaging") {
      const key = logisticsModeKey(a).localeCompare(logisticsModeKey(b));
      if (key) return key;
    }
    return orderTimestampPagedValue(b) - orderTimestampPagedValue(a);
  });
}

function orderInventoryPagedSortKey(row) {
  const modePrefix = logisticsModeKey(row) === "fbp" ? "z-fbp" : "a-fbs";
  const key = String(row.inventory_ids || row.product_names || row.product_codes || row.skus || "zz-empty")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-Hans", { numeric: true }))[0] || "zz-empty";
  return `${modePrefix}-${key}`;
}

function logisticsModeKey(row) {
  const combined = `${row.warehouse_name || ""} ${row.delivery_method_name || ""}`.toLowerCase();
  return combined.includes("hun chun") || combined.includes("hunchun") || combined.includes("混春") || combined.includes("混川") || combined.includes("珲春") || combined.includes("风船") || combined.includes("風船") || combined.includes("fbp")
    ? "fbp"
    : "fbs";
}

function orderTimestampPagedValue(row) {
  const time = new Date(row.ordered_at || row.created_at || row.updated_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function orderQualityPrefixes() {
  if (qualityPrefixCache) return qualityPrefixCache;
  qualityPrefixCache = allLocal("SELECT prefix FROM order_quality_rules WHERE active != 0 ORDER BY prefix ASC")
    .map((row) => String(row.prefix || "").trim())
    .filter(Boolean);
  return qualityPrefixCache;
}

function enrichOrderLogistics(row) {
  const payload = parseJson(row.raw_json) || {};
  const raw = payload.raw || payload;
  const deliveryMethod = raw.delivery_method || {};
  const analytics = raw.analytics_data || {};
  const deadline = raw.shipment_date_without_delay || raw.shipment_date || fallbackShipDeadline(row.ordered_at);
  const remaining = deadline ? daysBetween(new Date(), new Date(deadline)) : null;
  const finished = ["delivered", "cancelled", "canceled"].includes(String(row.status || "").toLowerCase());
  const cancellation = describeCancellation({
    ...row,
    raw_cancellation_reason: raw.cancellation?.cancel_reason || raw.cancellation?.cancellation_type || ""
  });
  return {
    ...row,
    raw_json: undefined,
    raw_status: raw.status || "",
    raw_substatus: raw.substatus || "",
    raw_tracking_stage: raw.tracking_stage || "",
    raw_cancellation_reason: raw.cancellation?.cancel_reason || raw.cancellation?.cancellation_type || "",
    cancel_initiator_label: cancellation.initiator_label,
    cancel_reason_label: cancellation.reason_label,
    cancel_reason_code: cancellation.reason_code,
    cancel_reason_group_label: cancellation.reason_group_label,
    cancel_accounting_hint: cancellation.accounting_hint,
    loss_profile_code: cancellation.loss_profile_code,
    loss_profile_label: cancellation.loss_profile_label,
    loss_formula_text: cancellation.loss_formula_text,
    pickup_code_verified_at: raw.pickup_code_verified_at || "",
    delivering_date: raw.delivering_date || "",
    in_process_at: raw.in_process_at || "",
    delivery_date_begin: analytics.delivery_date_begin || "",
    delivery_date_end: analytics.delivery_date_end || "",
    delivery_type: analytics.delivery_type || "",
    delivery_city: analytics.city || "",
    delivery_schema: "FBS self-ship",
    warehouse_name: deliveryMethod.warehouse || analytics.warehouse || "",
    delivery_method_name: deliveryMethod.name || "",
    logistics_channel: deliveryMethod.tpl_provider || analytics.tpl_provider || row.tracking_number || "",
    shipment_deadline_at: deadline,
    ship_days_remaining: remaining,
    is_overdue: !finished && Number.isFinite(remaining) ? remaining < 0 : false
  };
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function fallbackShipDeadline(orderedAt) {
  const ordered = new Date(orderedAt);
  if (Number.isNaN(ordered.getTime())) return null;
  ordered.setDate(ordered.getDate() + 6);
  return ordered.toISOString();
}

function daysBetween(from, to) {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSyncDate(value) {
  if (!value) return "";
  const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return String(value).slice(0, 10);
}

function chinaDateKey(value) {
  const date = parseDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function chinaDateSql(expr) {
  return `substr(datetime(${expr}, '+8 hours'), 1, 10)`;
}

function dateKeyDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

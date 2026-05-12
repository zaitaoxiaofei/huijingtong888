import { db } from "../db.js";
import { recalculateOrderCancelLossFlags } from "../services.js";
import { stockAlerts } from "./inventory.js";

function allLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function getLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

export function orders() {
  const rows = allLocal(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      SUM(oi.estimated_profit) AS estimated_profit,
      SUM(oi.actual_profit) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
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
  const finance = allLocal(`
    SELECT service_type, service_name,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
      COUNT(*) AS rows,
      MAX(operation_date) AS operation_date
    FROM ozon_finance_items
    WHERE shop_id = ? AND posting_number = ?
    GROUP BY service_type, service_name
    ORDER BY fee_amount DESC, ABS(amount) DESC
  `, [order.shop_id, order.posting_number]);
  return { order, items, finance };
}

export function exceptionWorkbench() {
  const tasks = [];
  const orderRows = orders().filter((row) => orderMatchesBaseQuery(row, {
    dateFrom: dateKeyDaysAgo(60),
    dateTo: exceptionTodayDateKey()
  }));
  for (const row of orderRows) {
    const work = orderTaskState(row);
    const context = exceptionOrderContext(row);
    const profitValue = Number(row.actual_profit || row.estimated_profit || 0);
    if (["unbound", "stock_issue"].includes(work.key)) {
      tasks.push(exceptionTask({
        type: work.key === "stock_issue" ? "order_stock_shortage" : "order_binding",
        level: work.key === "stock_issue" ? "danger" : "warning",
        title: work.key === "stock_issue" ? "订单库存不足" : "订单待绑定库存",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${formatDateText(row.ordered_at)}`,
        detail: work.key === "stock_issue" ? "已绑定库存但数量不足，需要采购或调整库存。" : "订单 SKU 还没有绑定实际库存，利润和出库都会不准。",
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
    const deadlineInfo = orderExceptionDeadlineInfo(row);
    if (deadlineInfo) {
      tasks.push(exceptionTask({
        type: "deadline",
        level: "danger",
        title: deadlineInfo.reason,
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${deadlineInfo.meta}`,
        detail: deadlineInfo.detail,
        action: "order-overdue",
        orderId: row.id,
        deadline_reason: deadlineInfo.reason,
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
  const visibleTasks = tasks.filter((task) => !["handled", "ignored"].includes(stateMap.get(task.id)?.status));
  return {
    rows: visibleTasks,
    total: visibleTasks.length,
    hidden_total: tasks.length - visibleTasks.length,
    counts: {
      danger: visibleTasks.filter((item) => item.level === "danger").length,
      warning: visibleTasks.filter((item) => item.level === "warning").length,
      info: visibleTasks.filter((item) => item.level === "info").length,
      order: visibleTasks.filter((item) => item.type.startsWith("order") || ["print", "profit", "deadline"].includes(item.type)).length,
      stock: visibleTasks.filter((item) => item.type.startsWith("stock")).length
    },
    generated_at: new Date().toISOString()
  };
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

function exceptionOrderContext(row) {
  const productName = firstCsvValue(row.product_names) || firstMappedValue(row.sku_names) || row.posting_number || "";
  const skuText = firstCsvValue(row.skus || row.unbound_skus);
  const inventoryId = firstCsvValue(row.inventory_ids || row.product_codes);
  const imageUrl = firstCsvValue(row.image_urls) || firstMappedValue(row.sku_images);
  const weight = firstCsvValue(row.package_weights);
  const dimensions = firstCsvValue(row.package_dimensions);
  return {
    image_url: imageUrl,
    product_name: productName === "Unbound product" ? "待绑定库存商品" : productName,
    sku_text: skuText,
    inventory_id: inventoryId && inventoryId !== "UNBOUND" ? inventoryId : "",
    dimensions_text: [weight ? `克重 ${weight}g` : "", dimensions && dimensions !== "0x0x0" ? `尺寸 ${dimensions}cm` : ""].filter(Boolean).join(" / "),
    profit_context_text: profitExceptionContextText(row),
    onlineProductId: Number(firstMappedId(row.sku_online_product_ids, skuText)) || undefined,
    productId: Number(firstCsvValue(row.product_ids)) || undefined
  };
}

function profitExceptionContextText(row) {
  const revenue = Number(row.revenue || 0);
  const profit = Number(row.actual_profit || row.estimated_profit || 0);
  const margin = revenue ? profit / revenue * 100 : 0;
  const shipping = shippingMethodText(row.product_shipping_methods);
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

function shippingMethodText(value) {
  const labels = {
    air: "空运",
    air_land: "陆空",
    land: "陆运"
  };
  const methods = [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  return methods.map((method) => labels[method] || method).join("+");
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

function stockAlertSkuText(row) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  return skus.slice(0, 3).map((item) => [item.shop_name, item.ozon_sku, item.name].filter(Boolean).join(" / ")).join("；");
}

function randomTaskId(values) {
  return [values.type, values.orderId || values.productId || values.subject || "", values.title || ""].join(":");
}

function exceptionPriorityValue(task) {
  const level = { danger: 3, warning: 2, info: 1 }[task.level] || 0;
  const typeBoost = task.type === "order_binding" ? 0.4 : task.type === "profit" ? 0.3 : 0;
  return level + typeBoost;
}

function orderMatchesBaseQuery(row, query) {
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all" && String(row.shop_id) !== shopId) return false;
  const value = String(row.ordered_at || row.created_at || "").slice(0, 10);
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
  const shipping = exceptionShippingMethodKey(row);
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

function exceptionShippingMethodKey(row) {
  const text = `${row.product_shipping_methods || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`.toLowerCase();
  if (text.includes("land") || text.includes("陆运")) return "land";
  return "air_land";
}

function exceptionTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
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
      SUM(oi.estimated_profit) AS estimated_profit,
      SUM(oi.actual_profit) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
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
    where.push("o.ordered_at >= ?");
    params.push(`${from}T00:00:00.000`);
  }
  if (to) {
    where.push("o.ordered_at <= ?");
    params.push(`${to}T23:59:59.999`);
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
  const state = "LOWER(COALESCE(o.status, ''))";
  const stage = "LOWER(COALESCE(o.tracking_stage, ''))";
  const value = `(${state} || ' ' || ${stage} || ' ' || LOWER(COALESCE(o.logistics_status, '')) || ' ' || LOWER(COALESCE(o.tracking_number, '')))`; 
  if (status === "awaiting_packaging") return orderSqlAnyExact([state, stage], ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"]);
  if (status === "awaiting_deliver") return orderSqlAnyExact([state, stage], ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"]);
  if (status === "dispute") return `(${value} LIKE '%arbitration%' OR ${value} LIKE '%dispute%')`;
  if (status === "cancelled") return `(${value} LIKE '%cancel%' OR ${value} LIKE '%return%' OR ${value} LIKE '%not_accepted%')`;
  if (status === "delivered") return `(${value} LIKE '%delivered%' AND NOT (${orderStatusSql("cancelled")}))`;
  if (status === "delivering") return `(
    ${value} NOT LIKE '%awaiting_packaging%' AND ${value} NOT LIKE '%awaiting_deliver%' AND ${value} NOT LIKE '%pending_stock%'
    AND (${value} LIKE '%delivering%' OR ${value} LIKE '%transferring%' OR ${value} LIKE '%carriage%' OR ${value} LIKE '%pickup%' OR ${value} LIKE '%sorting%' OR ${value} LIKE '%customs%' OR ${value} LIKE '%shipped%' OR ${value} LIKE '%sent%' OR ${value} LIKE '%on_way%' OR ${value} LIKE '%posting_in_carriage%' OR ${value} LIKE '%posting_transferring%' OR ${value} LIKE '%发往%' OR ${value} LIKE '%已上网%' OR ${value} LIKE '%发走%')
  )`;
  return "1 = 1";
}

function orderMatchesStatusQuery(row, status) {
  if (status === "all") return true;
  if (status === "unbound") return orderHasUnboundStockQuery(row);
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (status === "awaiting_packaging") return values.some((value) => ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"].includes(value));
  if (status === "awaiting_deliver") return values.some((value) => ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"].includes(value));
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
  return {
    ...row,
    raw_json: undefined,
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

function dateKeyDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

export function filterProcurementRequestsMysql(rows = [], query = {}) {
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const status = String(query.status || "waiting_purchase");
  const urgency = String(query.urgency || "all");
  const personId = String(query.personId || query.person_id || "all");
  const productId = Number(query.productId || query.product_id || 0);
  const dateFrom = String(query.dateFrom || query.date_from || "").trim();
  const dateTo = String(query.dateTo || query.date_to || "").trim();

  const filtered = rows.filter((row) => {
    const rowStatus = String(row.status || "");
    const orderStatus = String(row.purchase_order_status || "");
    if (productId && Number(row.product_id || 0) !== productId) return false;
    if (status === "waiting_purchase") {
      if (!["pending", "suggested", "submitted", "merged"].includes(rowStatus)) return false;
      if (["purchased", "partial_inbound", "inbound_done"].includes(orderStatus)) return false;
    } else if (status === "completed_purchase") {
      if (rowStatus !== "done" && orderStatus !== "inbound_done") return false;
    } else if (status === "cancelled") {
      if (rowStatus !== "cancelled") return false;
    } else if (status !== "all" && rowStatus !== status) {
      return false;
    }
    if (urgency !== "all" && String(row.urgency || "") !== urgency) return false;
    if (personId !== "all" && String(row.person_id || "") !== personId) return false;
    const createdDate = String(row.created_at || "").slice(0, 10);
    if (dateFrom && createdDate && createdDate < dateFrom) return false;
    if (dateTo && createdDate && createdDate > dateTo) return false;
    if (!searchText) return true;
    return [
      row.product_name,
      row.raw_name,
      row.raw_spec,
      row.request_group_no,
      row.product_code,
      row.person_name,
      row.supplier_name,
      row.purchase_url,
      row.note,
      row.mapped_skus
    ].some((item) => String(item || "").toLowerCase().includes(searchText));
  });

  if (!paged) return filtered;
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    mode: "paged"
  };
}

function procurementTimeValueMysql(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  const text = String(value || "").trim();
  if (!text) return 0;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function procurementOrderActionClassMysql(row = {}) {
  const statusText = [row.source_order_status, row.source_order_tracking_stage, row.source_order_logistics_status, row.status, row.tracking_stage, row.logistics_status]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (!statusText) return "review";
  if (["cancel", "canceled", "cancelled"].some((token) => statusText.includes(token))) return "p2_cancelled";
  if (["return", "returned", "refund", "after_delivery_return"].some((token) => statusText.includes(token))) return "p2_returned";
  if (["reject", "rejected", "unclaimed", "not_accepted"].some((token) => statusText.includes(token))) return "p1_missing_record";
  if (["awaiting_packaging", "awaiting_deliver", "awaiting_registration", "awaiting_approve", "acceptance_in_progress", "posting_created", "pending_stock", "ready_to_ship"].some((token) => statusText.includes(token))) return "p0_purchase";
  if (["delivering", "delivered", "transport", "transferr", "carriage", "shipped", "sent_by_seller", "on_way", "posting_received", "transferred_to_courier", "driver_pickup"].some((token) => statusText.includes(token))) return "p1_missing_record";
  return "review";
}

export function groupProcurementRequestsMysql(rows = [], query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const grouped = new Map();
  const purchaseableRows = rows.filter((item) => {
    const rowStatus = String(item.status || "");
    const orderStatus = String(item.purchase_order_status || "");
    const realOrderRequest = Number(item.source_order_id || 0) || Number(item.source_order_item_id || 0);
    return ["pending", "suggested", "submitted"].includes(rowStatus)
      && !["purchased", "partial_inbound", "inbound_done"].includes(orderStatus)
      && (!realOrderRequest || procurementOrderActionClassMysql(item) === "p0_purchase");
  });

  for (const row of purchaseableRows) {
    const productId = Number(row.product_id || 0);
    if (!productId) continue;
    if (!grouped.has(productId)) {
      grouped.set(productId, {
        product_id: productId,
        product_name: row.product_name || "",
        product_code: row.product_code || "",
        product_image_url: row.product_image_url || row.image_url || "",
        mapped_skus: row.mapped_skus || "",
        supplier_names: [],
        requester_names: [],
        purchase_links: [],
        demand_types: [],
        link_1688: "",
        link_pdd: "",
        other_source: "",
        total_quantity: 0,
        total_amount: 0,
        total_shipping: 0,
        stock: Number(row.stock || 0),
        incoming_stock: Number(row.incoming_stock || 0),
        component_count: Number(row.component_count || 0),
        component_local_stock: Number(row.component_local_stock || 0),
        component_incoming_stock: Number(row.component_incoming_stock || 0),
        recent_7d_qty: Number(row.recent_7d_qty || 0),
        recent_15d_qty: Number(row.recent_15d_qty || 0),
        recent_30d_qty: Number(row.recent_30d_qty || 0),
        week1_qty: Number(row.week1_qty || 0),
        week2_qty: Number(row.week2_qty || 0),
        week3_qty: Number(row.week3_qty || 0),
        fbp_available: Number(row.fbp_available || 0),
        fbp_snapshot_count: Number(row.fbp_snapshot_count || 0),
        historical_avg_unit_cost: Number(row.historical_avg_unit_cost || 0),
        historical_purchase_count: Number(row.historical_purchase_count || 0),
        historical_purchased_quantity: Number(row.historical_purchased_quantity || 0),
        historical_order_count: Number(row.historical_order_count || 0),
        historical_outbound_quantity: Number(row.historical_outbound_quantity || 0),
        historical_total_order_count: Number(row.historical_total_order_count || 0),
        historical_total_quantity: Number(row.historical_total_quantity || 0),
        historical_cancelled_quantity: Number(row.historical_cancelled_quantity || 0),
        historical_returned_quantity: Number(row.historical_returned_quantity || 0),
        historical_purchase_inbound_quantity: Number(row.historical_purchase_inbound_quantity || 0),
        historical_inventory_order_outbound_quantity: Number(row.historical_inventory_order_outbound_quantity || 0),
        historical_return_in_quantity: Number(row.historical_return_in_quantity || 0),
        historical_fbp_transfer_outbound_quantity: Number(row.historical_fbp_transfer_outbound_quantity || 0),
        historical_other_inventory_quantity: Number(row.historical_other_inventory_quantity || 0),
        order_request_count: 0,
        order_demand_quantity: 0,
        all_order_demand_quantity: row.all_order_demand_quantity == null ? null : Number(row.all_order_demand_quantity || 0),
        request_count: 0,
        earliest_created_at: row.created_at || "",
        latest_created_at: row.created_at || "",
        latest_activity_at: row.updated_at || row.created_at || "",
        overdue: false,
        automation_exceptions: [],
        requests: []
      });
    }
    const target = grouped.get(productId);
    target.total_quantity += Number(row.quantity || 0);
    target.total_amount += Number(row.amount || 0);
    target.total_shipping += Number(row.shipping_amount || 0);
    target.request_count += 1;
    if (row.all_order_demand_quantity != null) {
      target.all_order_demand_quantity = Math.max(Number(target.all_order_demand_quantity || 0), Number(row.all_order_demand_quantity || 0));
    }
    if (Number(row.source_order_id || 0) || Number(row.source_order_item_id || 0)) {
      target.order_request_count += 1;
      target.order_demand_quantity += Number(row.quantity || 0);
    }
    target.requests.push(row);
    addUniqueMysql(target.demand_types, row.demand_type || (row.source_order_item_id ? "real_order" : "advance_stock"));
    if (row.automation_exception_message) addUniqueMysql(target.automation_exceptions, row.automation_exception_message);
    addUniqueMysql(target.requester_names, row.person_name);
    addUniqueMysql(target.supplier_names, row.supplier_name);
    addUniqueMysql(target.purchase_links, row.purchase_url);
    addUniqueMysql(target.purchase_links, row.product_purchase_url);
    target.overdue = target.overdue || Boolean(row.overdue);
    if (!target.earliest_created_at || procurementTimeValueMysql(row.created_at) < procurementTimeValueMysql(target.earliest_created_at)) {
      target.earliest_created_at = row.created_at || "";
    }
    if (!target.latest_created_at || procurementTimeValueMysql(row.created_at) > procurementTimeValueMysql(target.latest_created_at)) {
      target.latest_created_at = row.created_at || "";
    }
    const activityAt = row.updated_at || row.created_at || "";
    if (!target.latest_activity_at || String(activityAt) > String(target.latest_activity_at)) {
      target.latest_activity_at = activityAt;
    }
    const source = String(row.source_type || row.product_source_platform || "1688").toLowerCase();
    const sourceUrl = row.purchase_url || row.product_purchase_url || "";
    if (source === "1688" && sourceUrl && !target.link_1688) target.link_1688 = sourceUrl;
    else if (source === "pdd" && sourceUrl && !target.link_pdd) target.link_pdd = sourceUrl;
    else if (!target.other_source) target.other_source = row.source_type || row.product_source_platform || "其他";
  }

  const filtered = Array.from(grouped.values())
    .map((row) => addProcurementDecisionMysql(row, query))
    .filter((row) => {
      if (!row.procurement_required) return false;
      if (!searchText) return true;
      return [
        row.product_code,
        row.product_name,
        row.mapped_skus,
        row.requester_names.join(" "),
        row.supplier_names.join(" "),
        row.purchase_links.join(" ")
      ].some((item) => String(item || "").toLowerCase().includes(searchText));
    })
    .sort((a, b) => (
      procurementTimeValueMysql(b.latest_created_at) - procurementTimeValueMysql(a.latest_created_at)
      || Number(b.product_id || 0) - Number(a.product_id || 0)
    ));

  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    mode: "grouped"
  };
}

export function procurementRealOrderShortageMysql(row = {}) {
  return procurementPriorityBreakdownMysql(row).real_order_shortage;
}

export function procurementPriorityBreakdownMysql(row = {}, targetStock = 0) {
  const hasComponents = Number(row.component_count || 0) > 0;
  const localSupply = hasComponents ? Number(row.component_local_stock || 0) : Number(row.stock || 0);
  const incomingSupply = hasComponents ? Number(row.component_incoming_stock || 0) : Number(row.incoming_stock || 0);
  const inventoryDebt = Math.max(0, -localSupply);
  const incoming = Math.max(0, incomingSupply);
  const inventoryDebtShortage = Math.max(0, inventoryDebt - incoming);
  const incomingAfterDebt = Math.max(0, incoming - inventoryDebt);
  const stockAfterDebt = Math.max(0, localSupply);
  const orderDemand = Math.max(0, Number(row.order_demand_quantity || 0));
  const realOrderShortage = Math.max(0, orderDemand - stockAfterDebt - incomingAfterDebt);
  const surplusAfterOrders = Math.max(0, stockAfterDebt + incomingAfterDebt - orderDemand);
  const safetyStockShortage = Math.max(0, Math.ceil(Number(targetStock || 0) - surplusAfterOrders));
  return {
    local_supply: localSupply, incoming_supply: incoming, inventory_debt: inventoryDebt,
    inventory_debt_shortage: inventoryDebtShortage, incoming_after_debt: incomingAfterDebt,
    order_demand: orderDemand, real_order_shortage: realOrderShortage,
    safety_stock_shortage: safetyStockShortage,
    total_priority_shortage: inventoryDebtShortage + realOrderShortage + safetyStockShortage
  };
}

function addProcurementDecisionMysql(row, query = {}) {
  const recent7d = Number(row.recent_7d_qty || 0);
  const recent30d = Number(row.recent_30d_qty || 0);
  const hasComponents = Number(row.component_count || 0) > 0;
  const localSupply = hasComponents ? Number(row.component_local_stock || 0) : Number(row.stock || 0);
  const incomingSupply = hasComponents ? Number(row.component_incoming_stock || 0) : Number(row.incoming_stock || 0);
  const availableSupply = Math.max(0, localSupply + Math.max(0, incomingSupply));
  row.effective_stock = localSupply;
  row.effective_incoming_stock = Math.max(0, incomingSupply);
  const available = Math.max(0, availableSupply);
  const dailySales = recent30d > 0 ? recent30d / 30 : 0;
  const coverageDays = dailySales > 0 ? available / dailySales : null;
  const rising = Number(row.week1_qty || 0) > Number(row.week2_qty || 0)
    && Number(row.week2_qty || 0) > Number(row.week3_qty || 0);
  const fastMoving = recent7d >= 5;
  const fbpShortage = Number(row.fbp_snapshot_count || 0) > 0
    && Math.max(0, Number(row.fbp_available || 0)) + available < recent7d;
  const inventoryWarningQualified = coverageDays !== null && coverageDays < 7
    && (fastMoving || rising || fbpShortage);
  const accelerated = recent30d > 0 && recent7d / recent30d >= 0.45;
  const targetDays = rising ? 30 : accelerated ? 14 : recent30d >= 5 ? 21 : 7;
  const replenishmentQty = dailySales > 0 ? Math.max(0, Math.ceil(dailySales * targetDays - available)) : 0;
  const priority = procurementPriorityBreakdownMysql(row, dailySales * targetDays);
  const realOrderShortage = priority.real_order_shortage;
  const manualDemandQuantity = Math.max(0, Number(row.total_quantity || 0) - Number(row.order_demand_quantity || 0));
  const onlyRealOrderRequests = Number(row.order_request_count || 0) > 0
    && Number(row.order_request_count || 0) === Number(row.request_count || 0);
  row.coverage_days = coverageDays === null ? null : Number(coverageDays.toFixed(1));
  row.target_days = targetDays;
  row.inventory_warning_qualified = inventoryWarningQualified;
  row.inventory_warning_signal = fastMoving ? "近7天销量达到5件" : rising ? "连续三周销量增长" : fbpShortage ? "FBP与本地库存不足一周" : "";
  row.real_order_shortage = realOrderShortage;
  row.inventory_debt = priority.inventory_debt;
  row.inventory_debt_shortage = priority.inventory_debt_shortage;
  row.incoming_after_debt = priority.incoming_after_debt;
  row.safety_stock_shortage = priority.safety_stock_shortage;
  row.priority_level = realOrderShortage > 0 ? "P0" : priority.inventory_debt_shortage > 0 ? "P1" : "P2";
  row.priority_label = realOrderShortage > 0 ? "订单履约优先" : priority.inventory_debt_shortage > 0 ? "负库存恢复" : "安全库存补货";
  const realOrderOnlyView = String(query.demandType || query.demand_type || "all") === "real_order";
  row.suggested_purchase_qty = realOrderOnlyView
    ? realOrderShortage
    : Math.max(manualDemandQuantity, priority.total_priority_shortage, inventoryWarningQualified ? replenishmentQty : 0);
  row.procurement_required = realOrderOnlyView
    ? realOrderShortage > 0
    : Boolean(row.automation_exceptions?.length) || !onlyRealOrderRequests || realOrderShortage > 0;
  if (row.automation_exceptions?.length) {
    row.demand_reason = `采购异常：${row.automation_exceptions.join("；")}`;
    return row;
  }
  row.demand_reason = [
    realOrderShortage > 0 ? `待发订单缺口 ${realOrderShortage} 件` : "",
    priority.inventory_debt_shortage > 0 ? `在途抵扣后仍欠库存 ${priority.inventory_debt_shortage} 件` : "",
    priority.safety_stock_shortage > 0 ? `安全库存缺口 ${priority.safety_stock_shortage} 件` : ""
  ].filter(Boolean).join("；") || "现货与在途可以覆盖当前需求";
  return row;
}

function addUniqueMysql(target, value) {
  const text = String(value || "").trim();
  if (text && !target.includes(text)) target.push(text);
}

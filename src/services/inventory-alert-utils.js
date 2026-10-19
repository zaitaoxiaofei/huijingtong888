import { searchInventoryRows } from "./inventory-search.js";
import { shanghaiDateDaysAgo } from "../shanghai-time.js";

const flattenedSnapshots = new WeakMap();

const FBS_VIRTUAL_STOCK_WARNING_THRESHOLD = 10;
const FBP_COVERAGE_DAYS_SHORTAGE = 15;
const FBP_COVERAGE_DAYS_URGENT = 7;

export function completedBeijingSalesWindow(anchor = new Date()) {
  return {
    from30: shanghaiDateDaysAgo(30, anchor),
    from15: shanghaiDateDaysAgo(15, anchor),
    from7: shanghaiDateDaysAgo(7, anchor),
    through: shanghaiDateDaysAgo(1, anchor)
  };
}

export function applyStockAlertQuery(rows, query = {}) {
  const mode = String(query.mode || "alerts");
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const alertType = String(query.alertType || query.alert_type || "all");

  if (mode === "inventory-alerts") return applyInventoryProductAlertQuery(rows, query);

  const fbpAlertMode = mode === "fbp-alerts";
  const sourceRows = mode === "fbp" || fbpAlertMode ? flattenFbpRows(rows) : rows;
  const filtered = searchInventoryRows(sourceRows, searchText).filter((row) => {
    if (fbpAlertMode && row.alert_level === "ok") return false;
    if (mode === "fbp" || fbpAlertMode) {
      if (!matchesFbpAlertType(row, alertType)) return false;
    }
    if (shopId !== "all") {
      if (mode === "fbp" || fbpAlertMode) {
        if (String(row.shop_id || "") !== shopId) return false;
      } else {
        const matched = Array.isArray(row.skus) && row.skus.some((sku) => String(sku.shop_id || "") === shopId);
        if (!matched) return false;
      }
    }
    const dateKey = String(row.created_at || "").slice(0, 10);
    if (dateFrom && (!dateKey || dateKey < dateFrom)) return false;
    if (dateTo && (!dateKey || dateKey > dateTo)) return false;
    return true;
  });

  if (mode === "fbp" || fbpAlertMode) sortFbpRows(filtered, query, fbpAlertMode);
  const pageRows = paged ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : filtered;
  return {
    rows: pageRows,
    total: filtered.length,
    page,
    pageSize,
    mode,
    meta: {
      total: rows.length,
      warning_count: fbpAlertMode ? filtered.length : rows.filter((row) => row.alert_level !== "ok").length,
      urgent_count: filtered.filter((row) => row.alert_level === "danger").length,
      last_synced_at: rows.reduce((latest, row) => maxTextDate(latest, row.last_synced_at), "")
    }
  };
}

export function withInventoryProductAlertStatus(product = {}) {
  const recent7d = Math.max(0, Number(product.recent_7d_qty || 0));
  const recent15d = Math.max(0, Number(product.recent_15d_qty || 0));
  const recent30d = Math.max(0, Number(product.recent_30d_qty || 0));
  const leadDays = Number(product.production_lead_days || 7);
  const physicalStock = Math.max(0, Number(product.physical_stock ?? product.local_stock ?? 0));
  const availableStock = Math.max(0, Number(product.available_stock ?? product.local_available ?? physicalStock));
  const incomingStock = Math.max(0, Number(product.incoming_stock || 0));
  const alertQuantity = leadDays ? Math.ceil(recent7d / 7 * leadDays) : null;
  const outOfStock = availableStock <= 0;
  const lowStock = !outOfStock && alertQuantity !== null && availableStock < alertQuantity;
  const inTransit = incomingStock > 0;
  const healthy = !outOfStock && !lowStock && alertQuantity !== null;
  const alertType = outOfStock ? "out_of_stock" : lowStock ? "low_stock" : healthy ? "healthy" : "lead_time_missing";
  return {
    ...product,
    recent_7d_qty: recent7d,
    recent_15d_qty: recent15d,
    recent_30d_qty: recent30d,
    production_lead_days: leadDays,
    physical_stock: physicalStock,
    available_stock: availableStock,
    incoming_stock: incomingStock,
    daily_sales_7d: Number((recent7d / 7).toFixed(2)),
    alert_quantity: alertQuantity,
    suggested_purchase_qty: alertQuantity === null ? 0 : Math.max(0, alertQuantity - availableStock - incomingStock),
    alert_type: alertType,
    alert_level: outOfStock ? "danger" : lowStock ? "warning" : healthy ? "ok" : "info",
    lead_time_missing: leadDays === null,
    in_transit: inTransit
  };
}

export function applyInventoryProductAlertQuery(rows, query = {}) {
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const alertType = String(query.alertType || query.alert_type || "all");
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const prepared = rows.map(withInventoryProductAlertStatus);
  const filtered = searchInventoryRows(prepared, searchText).filter((row) => {
    if (shopId !== "all" && !row.skus?.some((sku) => String(sku.shop_id || "") === shopId)) return false;
    if (alertType === "in_transit") return row.in_transit;
    if (alertType === "lead_time_missing") return row.lead_time_missing;
    if (alertType !== "all" && row.alert_type !== alertType) return false;
    return true;
  });
  filtered.sort((left, right) => right.recent_30d_qty - left.recent_30d_qty
    || right.recent_7d_qty - left.recent_7d_qty
    || right.product_id - left.product_id);
  return {
    rows: paged ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered,
    total: filtered.length,
    page,
    pageSize,
    mode: "inventory-alerts",
    meta: {
      total: prepared.length,
      out_of_stock: prepared.filter((row) => row.alert_type === "out_of_stock").length,
      low_stock: prepared.filter((row) => row.alert_type === "low_stock").length,
      in_transit: prepared.filter((row) => row.in_transit).length,
      healthy: prepared.filter((row) => row.alert_type === "healthy").length,
      lead_time_missing: prepared.filter((row) => row.lead_time_missing).length
    }
  };
}

function flattenFbpRows(rows) {
  if (flattenedSnapshots.has(rows)) return flattenedSnapshots.get(rows);
  const result = [];
  for (const product of rows) {
    const skus = Array.isArray(product.skus) ? product.skus : [];
    for (const sku of skus) {
      if (Number(sku.fbp_snapshot_count || 0) <= 0 && Number(sku.fbp_present || 0) <= 0 && Number(sku.fbp_available || 0) <= 0) continue;
      result.push(withFbpAlertStatus({
        product_id: product.product_id,
        product_name: product.product_name,
        product_image_url: product.image_url,
        inventory_id: product.inventory_id,
        inventory_number: product.inventory_number || "",
        alert_stock: product.alert_stock,
        local_stock: product.local_stock,
        created_at: product.created_at,
        recent_3d_qty: sku.recent_3d_qty,
        recent_7d_qty: sku.recent_7d_qty,
        recent_30d_qty: sku.recent_30d_qty,
        prev_7d_qty: sku.prev_7d_qty,
        all_time_qty: sku.all_time_qty,
        free_stock_count: sku.free_stock_count,
        paid_stock_count: sku.paid_stock_count,
        expiring_stock_count: sku.expiring_stock_count,
        waitingdocs_stock_count: sku.waitingdocs_stock_count,
        paid_storage_start_at: sku.paid_storage_start_at,
        stock_days: sku.stock_days,
        average_daily_sales: sku.average_daily_sales,
        stock_level: sku.stock_level,
        ...sku
      }));
    }
  }
  flattenedSnapshots.set(rows, result);
  return result;
}

function matchesFbpAlertType(row = {}, alertType = "all") {
  if (!alertType || alertType === "all") return true;
  if (alertType === "out_of_stock") return row.alert_type === "out_of_stock";
  if (alertType === "within_7_days") return row.alert_type === "within_7_days";
  if (alertType === "within_15_days") return row.alert_type === "within_15_days";
  if (alertType === "within_30_days") return row.alert_type === "within_15_days";
  if (alertType === "slow") return false;
  return row.alert_type === alertType;
}

function sortFbpRows(rows, query = {}, alertMode = false) {
  const sortKey = String(query.sortKey || query.sort_key || "fbp_available");
  const factor = String(query.sortDir || query.sort_dir || "asc") === "desc" ? -1 : 1;
  rows.sort((left, right) => {
    if (alertMode) {
      const priority = fbpAlertPriority(left) - fbpAlertPriority(right);
      if (priority) return priority;
    }
    const a = Number(left[sortKey] || 0);
    const b = Number(right[sortKey] || 0);
    if (a === b) return Number(left.product_id || 0) - Number(right.product_id || 0);
    return (a - b) * factor;
  });
}

function fbpAlertPriority(row = {}) {
  const order = {
    out_of_stock: 0,
    within_7_days: 1,
    within_15_days: 2
  };
  return order[row.alert_type] ?? 99;
}

export function parseWarehouseBreakdown(value) {
  if (!value) return [];
  return String(value).split("||").filter(Boolean).map((part) => {
    const [name = "", present = "0", stockType = "unknown"] = part.split(":");
    const [presentQty = "0", availableQty = presentQty] = present.split("/");
    return {
      name,
      present: stockNumber(presentQty),
      available: stockNumber(availableQty),
      stock_type: stockType
    };
  });
}

function stockNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

export function withStockAlertStatus(product) {
  const warnings = [];
  if (product.all_time_qty > 0 && product.local_stock <= product.alert_stock) warnings.push({ type: "local", level: "danger", text: "本地库存不足" });
  if (product.fbp_sku_count > 0 && product.fbp_zero_sku_count > 0) warnings.push({ type: "fbp", level: "danger", text: `${product.fbp_zero_sku_count} 个 FBP SKU 库存为空` });
  if (product.fbs_low_sku_count > 0) warnings.push({ type: "fbs", level: "warning", text: `${product.fbs_low_sku_count} 个 FBS 虚拟库存小于 ${FBS_VIRTUAL_STOCK_WARNING_THRESHOLD}` });
  if (!product.skus.length) warnings.push({ type: "mapping", level: "warning", text: "未绑定 Ozon SKU" });
  if (product.recent_7d_qty > product.prev_7d_qty * 1.3 && product.recent_7d_qty >= 3) warnings.push({ type: "trend_up", level: "info", text: "近 7 天出货加快" });
  if (product.prev_7d_qty >= 3 && product.recent_7d_qty < product.prev_7d_qty * 0.7) warnings.push({ type: "trend_down", level: "info", text: "近 7 天出货下降" });
  const alertLevel = warnings.some((item) => item.level === "danger") ? "danger" : warnings.some((item) => item.level === "warning") ? "warning" : warnings.some((item) => item.level === "info") ? "info" : "ok";
  return {
    ...product,
    trend_delta: product.recent_7d_qty - product.prev_7d_qty,
    trend_rate: product.prev_7d_qty > 0 ? (product.recent_7d_qty - product.prev_7d_qty) / product.prev_7d_qty : (product.recent_7d_qty > 0 ? 1 : 0),
    alert_level: alertLevel,
    warnings,
    suggestion: stockSuggestion(warnings)
  };
}

function withFbpAlertStatus(row) {
  const available = Number(row.fbp_available || 0);
  const dailySales = dynamicFbpDailySales(row);
  const coverageDays = dailySales > 0 ? available / dailySales : null;
  const warnings = [];
  let alertType = "";
  let alertLevel = "ok";
  let alertText = "FBP库存正常";

  if (available <= 0) {
    alertType = "out_of_stock";
    alertLevel = "danger";
    alertText = "FBP已断货";
  } else if (coverageDays !== null && coverageDays <= FBP_COVERAGE_DAYS_URGENT) {
    alertType = "within_7_days";
    alertLevel = "danger";
    alertText = `预计${coverageDays.toFixed(1)}天内断货`;
  } else if (coverageDays !== null && coverageDays <= FBP_COVERAGE_DAYS_SHORTAGE) {
    alertType = "within_15_days";
    alertLevel = "warning";
    alertText = `预计${coverageDays.toFixed(1)}天内断货`;
  }

  if (alertType) warnings.push({ type: alertType, level: alertLevel, text: alertText });
  return {
    ...row,
    daily_sales_30d: dailySales,
    daily_sales_14d: dailySales,
    dynamic_daily_sales: dailySales,
    coverage_days: coverageDays,
    suggested_qty: suggestedFbpReplenishmentQty(available, dailySales),
    alert_type: alertType || "ok",
    alert_level: alertLevel,
    warnings,
    suggestion: fbpAlertSuggestion(alertType, coverageDays)
  };
}

function suggestedFbpReplenishmentQty(available, dailySales) {
  if (dailySales <= 0) return 0;
  const targetQty = Math.ceil(dailySales * 30);
  const shortage = targetQty - Number(available || 0);
  return shortage > 0 ? Math.max(1, Math.ceil(shortage)) : 0;
}

function dynamicFbpDailySales(row = {}) {
  const recent7d = Number(row.recent_7d_qty || 0);
  const prev7d = Number(row.prev_7d_qty || 0);
  if (recent7d <= 0 && prev7d <= 0) return 0;
  if (prev7d <= 0) return recent7d / 7;
  if (recent7d > prev7d) return recent7d / 7;
  return ((recent7d * 0.7) + (prev7d * 0.3)) / 7;
}

function fbpAlertSuggestion(alertType, coverageDays) {
  if (alertType === "out_of_stock") return "FBP已断货，优先补仓或调整库存策略。";
  if (alertType === "within_7_days") return "预计7天内断货，建议立即补仓。";
  if (alertType === "within_15_days") return `预计${Number(coverageDays || 0).toFixed(1)}天内断货，建议排入补货计划。`;
  return "FBP库存状态正常。";
}

function stockSuggestion(warnings) {
  if (warnings.some((item) => item.type === "mapping")) return "先绑定 SKU，才能核验 Ozon 库存。";
  if (warnings.some((item) => item.type === "local")) return "这个产品已经出过单，本地真实库存不足，优先创建采购请求。";
  if (warnings.some((item) => item.type === "fbp")) return "曾经有 FBP 库存的 SKU 现在为空，检查是否需要补 FBP 仓。";
  if (warnings.some((item) => item.type === "fbs")) return `FBS 虚拟库存小于 ${FBS_VIRTUAL_STOCK_WARNING_THRESHOLD}，检查 Ozon 后台可售库存设置。`;
  if (warnings.some((item) => item.type === "trend_up")) return "出货速度上升，可以提高本地与 FBP 备货。";
  if (warnings.some((item) => item.type === "trend_down")) return "出货下降，减少 FBP 补货降低压货风险。";
  return "库存状态正常。";
}

export function maxTextDate(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  return String(a) > String(b) ? a : b;
}

export function dateKeyDaysAgo(days) {
  return shanghaiDateDaysAgo(days);
}

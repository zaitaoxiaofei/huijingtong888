import { shanghaiDateDaysAgo } from "../shanghai-time.js";

const FBS_VIRTUAL_STOCK_WARNING_THRESHOLD = 10;

export function applyStockAlertQuery(rows, query = {}) {
  const mode = String(query.mode || "alerts");
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const shopId = String(query.shopId || query.shop_id || "all");
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);

  const sourceRows = mode === "fbp" ? flattenFbpRows(rows) : rows;
  const filtered = sourceRows.filter((row) => {
    if (shopId !== "all") {
      if (mode === "fbp") {
        if (String(row.shop_id || "") !== shopId) return false;
      } else {
        const matched = Array.isArray(row.skus) && row.skus.some((sku) => String(sku.shop_id || "") === shopId);
        if (!matched) return false;
      }
    }
    const dateKey = String(row.created_at || "").slice(0, 10);
    if (dateFrom && (!dateKey || dateKey < dateFrom)) return false;
    if (dateTo && (!dateKey || dateKey > dateTo)) return false;
    if (!searchText) return true;
    const skuText = mode === "fbp"
      ? [row.shop_name, row.name, row.ozon_sku, row.offer_id].join(" ")
      : (Array.isArray(row.skus) ? row.skus.map((sku) => `${sku.shop_name || ""} ${sku.ozon_sku || ""} ${sku.offer_id || ""}`).join(" ") : "");
    const haystack = [row.product_name, row.inventory_id, row.suggestion, skuText].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(searchText);
  });

  if (mode === "fbp") sortFbpRows(filtered, query);
  const pageRows = paged ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : filtered;
  return {
    rows: pageRows,
    total: filtered.length,
    page,
    pageSize,
    mode,
    meta: {
      total: rows.length,
      warning_count: rows.filter((row) => row.alert_level !== "ok").length,
      last_synced_at: rows.reduce((latest, row) => maxTextDate(latest, row.last_synced_at), "")
    }
  };
}

function flattenFbpRows(rows) {
  const result = [];
  for (const product of rows) {
    const skus = Array.isArray(product.skus) ? product.skus : [];
    for (const sku of skus) {
      if (Number(sku.fbp_snapshot_count || 0) <= 0 && Number(sku.fbp_present || 0) <= 0 && Number(sku.fbp_available || 0) <= 0) continue;
      result.push({
        product_id: product.product_id,
        product_name: product.product_name,
        product_image_url: product.image_url,
        inventory_id: product.inventory_id,
        alert_stock: product.alert_stock,
        local_stock: product.local_stock,
        created_at: product.created_at,
        recent_3d_qty: sku.recent_3d_qty,
        recent_7d_qty: sku.recent_7d_qty,
        recent_30d_qty: sku.recent_30d_qty,
        prev_7d_qty: sku.prev_7d_qty,
        all_time_qty: sku.all_time_qty,
        ...sku
      });
    }
  }
  return result;
}

function sortFbpRows(rows, query = {}) {
  const sortKey = String(query.sortKey || query.sort_key || "fbp_available");
  const factor = String(query.sortDir || query.sort_dir || "asc") === "desc" ? -1 : 1;
  rows.sort((left, right) => {
    const a = Number(left[sortKey] || 0);
    const b = Number(right[sortKey] || 0);
    if (a === b) return Number(left.product_id || 0) - Number(right.product_id || 0);
    return (a - b) * factor;
  });
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

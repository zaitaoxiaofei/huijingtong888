import { mysqlQuery } from "../mysql-pool.js";

function dateSql(value) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function beijingDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseBeijingDate(value, field = "date") {
  const text = String(value || "").trim();
  const start = new Date(`${text}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(start.getTime())
    || new Date(start.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== text) {
    throw new Error(`请选择有效的采购日期（${field}），按北京时间导出采购清单`);
  }
  return start;
}

export function procurementDayRange(date) {
  const start = parseBeijingDate(date, "date");
  return [dateSql(start), dateSql(new Date(start.getTime() + 86400000))];
}

export function procurementReportRange(query = {}, now = new Date()) {
  const legacyDate = String(query.date || "").trim();
  const defaultDate = legacyDate || beijingDateKey(now);
  const dateFrom = String(query.dateFrom || query.date_from || defaultDate).trim();
  const dateTo = String(query.dateTo || query.date_to || legacyDate || dateFrom).trim();
  const start = parseBeijingDate(dateFrom, "dateFrom");
  const lastDay = parseBeijingDate(dateTo, "dateTo");
  if (start.getTime() > lastDay.getTime()) throw new Error("采购开始日期不能晚于结束日期");
  return { dateFrom, dateTo, sqlRange: [dateSql(start), dateSql(new Date(lastDay.getTime() + 86400000))] };
}

function listValue(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export async function procurementDailyReport(query = {}, queryRows = mysqlQuery) {
  const { dateFrom, dateTo, sqlRange } = procurementReportRange(query);
  const params = [...sqlRange];
  const where = [
    "po.status IN ('purchased', 'partial_inbound', 'inbound_done')",
    "COALESCE(poi.status, '') != 'cancelled'",
    "COALESCE(po.purchased_at, po.created_at) >= ?",
    "COALESCE(po.purchased_at, po.created_at) < ?"
  ];
  const searchText = String(query.query || query.search || "").trim();
  const demandType = String(query.demandType || query.demand_type || "all").trim();
  const bindingStatus = String(query.bindingStatus || query.binding_status || "all").trim();
  const personId = String(query.personId || query.person_id || "all").trim();
  const supplierId = String(query.supplierId || query.supplier_id || "all").trim();
  const sourceType = String(query.sourceType || query.source_type || "all").trim().toLowerCase();
  const inventoryCategory = String(query.inventoryCategory || query.inventory_category || "").trim();
  const productName = String(query.productName || query.product_name || "").trim();
  const vehicleBrand = String(query.vehicleBrand || query.vehicle_brand || "").trim();
  const vehicleModels = listValue(query.vehicleModel || query.vehicle_model);
  const accessoryName = String(query.accessoryName || query.accessory_name || "").trim();
  const color = String(query.color || "").trim();
  const materials = listValue(query.material);
  const process = String(query.process || query.surface_process || "").trim();

  if (searchText) {
    const like = `%${searchText.toLowerCase()}%`;
    where.push(`(
      LOWER(COALESCE(po.order_no, '')) LIKE ? OR LOWER(COALESCE(p.name, '')) LIKE ?
      OR LOWER(COALESCE(p.inventory_number, '')) LIKE ? OR LOWER(COALESCE(p.code, '')) LIKE ?
      OR LOWER(COALESCE(pe.name, '')) LIKE ? OR LOWER(COALESCE(poi.note, po.note, '')) LIKE ?
      OR LOWER(COALESCE(poi.purchase_url, '')) LIKE ?
      OR EXISTS (
        SELECT 1 FROM procurement_requests search_request
        LEFT JOIN people search_person ON search_person.id = search_request.person_id
        LEFT JOIN suppliers search_supplier ON search_supplier.id = search_request.supplier_id
        WHERE search_request.purchase_order_id = po.id AND search_request.product_id = poi.product_id
          AND (LOWER(COALESCE(search_person.name, '')) LIKE ?
            OR LOWER(COALESCE(search_supplier.name, '')) LIKE ?
            OR LOWER(COALESCE(search_request.purchase_url, '')) LIKE ?)
      )
    )`);
    params.push(...Array(10).fill(like));
  }
  if (inventoryCategory) { where.push("p.inventory_category = ?"); params.push(inventoryCategory); }
  if (productName) { where.push("p.name LIKE ?"); params.push(`%${productName}%`); }
  if (vehicleBrand) {
    const brandTokens = [...new Set(vehicleBrand.split(/\s+/).filter(Boolean))];
    where.push(`(REPLACE(COALESCE(p.vehicle_brand, ''), '|', ' ') = ? OR ${brandTokens.map(() => "COALESCE(p.vehicle_brand, '') LIKE ?").join(" OR ")})`);
    params.push(vehicleBrand, ...brandTokens.map((token) => `%${token}%`));
  }
  if (vehicleModels.length) {
    where.push(`(${vehicleModels.map(() => "CONCAT('/', COALESCE(p.vehicle_model, ''), '/') LIKE ?").join(" OR ")})`);
    params.push(...vehicleModels.map((model) => `%/${model}/%`));
  }
  if (accessoryName) { where.push("p.accessory_name = ?"); params.push(accessoryName); }
  if (color) { where.push("CONCAT(',', REPLACE(COALESCE(p.color, ''), '/', ','), ',') LIKE ?"); params.push(`%,${color},%`); }
  if (materials.length) {
    where.push(`(${materials.map(() => "CONCAT('/', COALESCE(p.material, ''), '/') LIKE ?").join(" OR ")})`);
    params.push(...materials.map((material) => `%/${material}/%`));
  }
  if (process) { where.push("p.surface_process = ?"); params.push(process); }

  const requestWhere = ["filtered_request.purchase_order_id = po.id", "filtered_request.product_id = poi.product_id"];
  const requestParams = [];
  if (personId && personId !== "all") { requestWhere.push("filtered_request.person_id = ?"); requestParams.push(Number(personId)); }
  if (supplierId && supplierId !== "all") { requestWhere.push("COALESCE(filtered_request.supplier_id, p.supplier_id) = ?"); requestParams.push(Number(supplierId)); }
  if (sourceType && sourceType !== "all") {
    requestWhere.push("LOWER(COALESCE(NULLIF(filtered_request.source_type, ''), NULLIF(p.source_platform, ''), 'other')) = ?");
    requestParams.push(sourceType);
  }
  if (bindingStatus && bindingStatus !== "all") { requestWhere.push("filtered_request.binding_status = ?"); requestParams.push(bindingStatus); }
  if (demandType === "real_order") requestWhere.push("filtered_request.demand_type = 'real_order'");
  else if (["advance_stock", "inventory_warning"].includes(demandType)) requestWhere.push("filtered_request.demand_type = 'advance_stock'");
  else if (demandType === "warehouse_request") requestWhere.push("filtered_request.demand_type = 'warehouse_request'");
  if (requestWhere.length > 2) {
    where.push(`EXISTS (SELECT 1 FROM procurement_requests filtered_request WHERE ${requestWhere.join(" AND ")})`);
    params.push(...requestParams);
  }

  // One row per purchased item: request sources and inbound splits are filtered with EXISTS and never joined.
  const rows = await queryRows(`
    SELECT poi.id, poi.product_id, po.order_no AS purchase_order_no,
      p.inventory_number, p.inventory_category, p.name AS product_name,
      COALESCE(NULLIF(poi.actual_quantity, 0), poi.requested_quantity) AS quantity,
      poi.amount, COALESCE(poi.shipping_amount, 0) AS shipping_amount,
      COALESCE(po.purchased_at, po.created_at) AS purchased_at,
      pe.name AS person_name, po.status, po.note
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN products p ON p.id = poi.product_id
    LEFT JOIN people pe ON pe.id = po.created_by_person_id
    WHERE ${where.join("\n      AND ")}
    ORDER BY COALESCE(po.purchased_at, po.created_at), po.id, poi.id
  `, params);
  return { date: dateFrom === dateTo ? dateFrom : "", dateFrom, dateTo, rows };
}

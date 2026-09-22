import { mysqlQuery } from "../mysql-pool.js";

export function procurementDayRange(date) {
  const value = String(date || "");
  const start = new Date(`${value}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(start.getTime())
    || new Date(start.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== value) {
    throw new Error("请选择有效的采购日期（date），按北京时间导出每日采购清单");
  }
  return [start, new Date(start.getTime() + 86400000)]
    .map((time) => time.toISOString().slice(0, 19).replace("T", " "));
}

export async function procurementDailyReport(query = {}, queryRows = mysqlQuery) {
  const range = procurementDayRange(query.date);
  // One row per purchased item: inbound splits and request allocations must not multiply costs.
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
    WHERE po.status IN ('purchased', 'partial_inbound', 'inbound_done')
      AND COALESCE(po.purchased_at, po.created_at) >= ?
      AND COALESCE(po.purchased_at, po.created_at) < ?
    ORDER BY COALESCE(po.purchased_at, po.created_at), po.id, poi.id
  `, range);
  return { date: query.date, rows };
}

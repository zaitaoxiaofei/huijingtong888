export function normalizeFbpReplenishmentOrder(row = {}, items = []) {
  const applicantIds = [...new Set(items.map((item) => Number(item.requested_by || 0)).filter(Boolean))];
  const applicantNames = [...new Set(items.map((item) => String(item.requested_by_name || "").trim()).filter(Boolean))];
  if (!applicantIds.length && row.created_by != null) applicantIds.push(Number(row.created_by || 0));
  if (!applicantNames.length && row.created_by_name) applicantNames.push(row.created_by_name);
  return {
    id: Number(row.id || 0),
    order_no: row.order_no || "",
    shop_id: Number(row.shop_id || 0),
    shop_name: row.shop_name || "",
    batch_id: row.batch_id == null ? null : Number(row.batch_id || 0),
    batch_no: row.batch_no || "",
    order_date: row.order_date || "",
    status: row.status || "draft",
    note: row.note || "",
    created_by: row.created_by == null ? null : Number(row.created_by || 0),
    created_by_name: row.created_by_name || "",
    reviewed_by: row.reviewed_by == null ? null : Number(row.reviewed_by || 0),
    reviewed_by_name: row.reviewed_by_name || "",
    applicant_ids: applicantIds,
    applicant_names: applicantNames,
    item_count: Number(row.item_count || items.length || 0),
    total_requested_qty: Number(row.total_requested_qty || items.reduce((sum, item) => sum + Number(item.requested_qty || 0), 0)),
    total_approved_qty: Number(row.total_approved_qty || items.reduce((sum, item) => sum + Number(item.approved_qty || 0), 0)),
    total_final_qty: Number(row.total_final_qty || items.reduce((sum, item) => sum + Number(item.final_qty || item.approved_qty || 0), 0)),
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    submitted_at: row.submitted_at || "",
    reviewed_at: row.reviewed_at || "",
    closed_at: row.closed_at || "",
    items
  };
}

export function normalizeFbpReplenishmentItem(row = {}) {
  return {
    id: Number(row.id || 0),
    order_id: Number(row.order_id || 0),
    shop_id: Number(row.shop_id || 0),
    product_id: row.product_id == null ? null : Number(row.product_id || 0),
    mapping_id: row.mapping_id == null ? null : Number(row.mapping_id || 0),
    ozon_sku: row.ozon_sku || "",
    offer_id: row.offer_id || "",
    product_name: row.product_name || "",
    image_url: row.image_url || "",
    inventory_id: row.inventory_id || "",
    week1_qty: Number(row.week1_qty || 0),
    week2_qty: Number(row.week2_qty || 0),
    week3_qty: Number(row.week3_qty || 0),
    recent_7d_qty: Number(row.recent_7d_qty || 0),
    recent_30d_qty: Number(row.recent_30d_qty || 0),
    fbp_available: Number(row.fbp_available || 0),
    fbp_transfer_in_transit_qty: Number(row.fbp_transfer_in_transit_qty || 0),
    fbp_effective_available: Number(row.fbp_effective_available || row.fbp_available || 0),
    fbs_available: Number(row.fbs_available || 0),
    local_stock: Number(row.local_stock || 0),
    pending_procurement_qty: Number(row.pending_procurement_qty || 0),
    daily_sales: row.daily_sales == null ? null : Number(row.daily_sales),
    coverage_days: row.coverage_days == null ? null : Number(row.coverage_days),
    target_days: Number(row.target_days || 0),
    target_stock: Number(row.target_stock || 0),
    suggested_qty: Number(row.suggested_qty || 0),
    suggested_transfer_qty: Number(row.suggested_transfer_qty || 0),
    suggested_purchase_qty: Number(row.suggested_purchase_qty || 0),
    suggested_action: row.suggested_action || "",
    suggested_action_text: row.suggested_action_text || "",
    requested_qty: Number(row.requested_qty || 0),
    approved_qty: Number(row.approved_qty || 0),
    adjustment_qty: Number(row.adjustment_qty || 0),
    adjustment_summary: row.adjustment_summary || "",
    final_qty: Number(row.approved_qty || 0) + Number(row.adjustment_qty || 0),
    requested_by: row.requested_by == null ? null : Number(row.requested_by || 0),
    requested_by_name: row.requested_by_name || "",
    reason: row.reason || "",
    note: row.note || "",
    barcode_printed_qty: Number(row.barcode_printed_qty || 0),
    barcode_printed_at: row.barcode_printed_at || "",
    barcode_printed_by: row.barcode_printed_by == null ? null : Number(row.barcode_printed_by || 0),
    barcode_printed_by_name: row.barcode_printed_by_name || ""
  };
}

export function normalizeFbpTransferRecord(row = {}) {
  const quantity = Number(row.quantity || 0);
  const listedQuantity = Number(row.listed_quantity || 0);
  return {
    id: Number(row.id || 0),
    product_id: Number(row.product_id || 0),
    mapping_id: row.mapping_id == null ? null : Number(row.mapping_id || 0),
    shop_id: row.shop_id == null ? null : Number(row.shop_id || 0),
    shop_name: row.shop_name || "",
    ozon_sku: row.ozon_sku || "",
    product_name: row.product_name || "",
    product_image_url: row.product_image_url || "",
    inventory_id: row.inventory_id || "",
    quantity,
    listed_quantity: listedQuantity,
    in_transit_quantity: Math.max(0, quantity - listedQuantity),
    status: row.status || "draft",
    source_type: row.source_type || "",
    source_ref: row.source_ref || "",
    warehouse_name: row.warehouse_name || "",
    tracking_no: row.tracking_no || "",
    box_no: row.box_no || "",
    note: row.note || "",
    person_id: row.person_id == null ? null : Number(row.person_id || 0),
    person_name: row.person_name || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    shipped_at: row.shipped_at || "",
    expected_arrival_at: row.expected_arrival_at || "",
    closed_at: row.closed_at || ""
  };
}

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

export function groupProcurementRequestsMysql(rows = [], query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const grouped = new Map();
  const purchaseableRows = rows.filter((item) => {
    const rowStatus = String(item.status || "");
    const orderStatus = String(item.purchase_order_status || "");
    return ["pending", "suggested", "submitted"].includes(rowStatus)
      && !["purchased", "partial_inbound", "inbound_done"].includes(orderStatus);
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
        link_1688: "",
        link_pdd: "",
        other_source: "",
        total_quantity: 0,
        total_amount: 0,
        total_shipping: 0,
        request_count: 0,
        earliest_created_at: row.created_at || "",
        latest_created_at: row.created_at || "",
        latest_activity_at: row.updated_at || row.created_at || "",
        overdue: false,
        requests: []
      });
    }
    const target = grouped.get(productId);
    target.total_quantity += Number(row.quantity || 0);
    target.total_amount += Number(row.amount || 0);
    target.total_shipping += Number(row.shipping_amount || 0);
    target.request_count += 1;
    target.requests.push(row);
    addUniqueMysql(target.requester_names, row.person_name);
    addUniqueMysql(target.supplier_names, row.supplier_name);
    addUniqueMysql(target.purchase_links, row.purchase_url);
    addUniqueMysql(target.purchase_links, row.product_purchase_url);
    target.overdue = target.overdue || Boolean(row.overdue);
    if (!target.earliest_created_at || String(row.created_at || "") < String(target.earliest_created_at)) {
      target.earliest_created_at = row.created_at || "";
    }
    if (!target.latest_created_at || String(row.created_at || "") > String(target.latest_created_at)) {
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
    else if (!target.other_source) target.other_source = row.source_type || row.product_source_platform || "鍏朵粬";
  }

  const filtered = Array.from(grouped.values())
    .filter((row) => {
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
      String(b.latest_created_at || "").localeCompare(String(a.latest_created_at || ""))
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

function addUniqueMysql(target, value) {
  const text = String(value || "").trim();
  if (text && !target.includes(text)) target.push(text);
}

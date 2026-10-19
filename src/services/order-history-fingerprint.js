function fingerprintText(value) {
  return String(value ?? "");
}

function fingerprintDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  }
  const normalized = String(value).trim().replace("T", " ").replace(/Z$/, "");
  return normalized ? normalized.slice(0, 19) : null;
}

export function orderStatusHistoryBusinessFingerprint(payload = {}) {
  return JSON.stringify([
    fingerprintText(payload.status),
    fingerprintText(payload.substatus),
    fingerprintText(payload.logistics_status),
    fingerprintText(payload.tracking_stage),
    fingerprintText(payload.sync_state),
    fingerprintDateTime(payload.ordered_at),
    fingerprintDateTime(payload.delivered_at),
    fingerprintText(payload.customer_id),
    fingerprintText(payload.customer_name),
    fingerprintText(payload.buyer_city),
    fingerprintText(payload.buyer_region),
    fingerprintText(payload.buyer_country),
    fingerprintText(payload.buyer_district),
    fingerprintText(payload.buyer_zip_code),
    fingerprintText(payload.buyer_address_tail),
    fingerprintText(payload.delivery_type),
    fingerprintText(payload.delivery_city),
    fingerprintText(payload.delivery_region),
    fingerprintDateTime(payload.delivery_date_begin),
    fingerprintDateTime(payload.delivery_date_end),
    fingerprintText(payload.warehouse_name),
    fingerprintText(payload.tpl_provider),
    fingerprintText(payload.cluster_to)
  ]);
}

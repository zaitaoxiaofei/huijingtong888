export function orderPackageLabelChunksMysql(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.shop_id}||${row.ozon_client_id || ""}||${row.ozon_api_key || row.api_key_hint || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { shop: orderPackageLabelShopMysql(row), rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  const chunks = [];
  for (const group of groups.values()) {
    for (let index = 0; index < group.rows.length; index += 20) {
      chunks.push({ shop: group.shop, rows: group.rows.slice(index, index + 20) });
    }
  }
  return chunks;
}

export function orderPackageLabelFailureMysql(row, error) {
  return {
    id: row?.id,
    posting_number: row?.posting_number,
    shop_name: row?.shop_name,
    error: error?.message || "Failed to generate label"
  };
}

export function orderPackageLabelShopMysql(row = {}) {
  return {
    id: row.shop_id,
    name: row.shop_name,
    ozon_client_id: row.ozon_client_id,
    ...(row.ozon_api_key ? { ozon_api_key: row.ozon_api_key } : {}),
    api_key_hint: row.api_key_hint
  };
}

export function isDemoPackageLabelBufferMysql(value) {
  const buffer = normalizePackageLabelBufferMysql(value);
  return Boolean(buffer?.includes(Buffer.from("Demo Ozon labels", "utf8")));
}

export function normalizePackageLabelBufferMysql(value) {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

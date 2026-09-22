// Each identifier branch can use its own index; generated legacy IDs use created_at.
export function inventoryIdentifierSearch(text, mode = "auto") {
  const value = String(text || "").trim();
  const branches = [];
  const params = [];
  const add = (sql, ...values) => { branches.push(sql); params.push(...values); };
  if (!value) return { sql: "SELECT id AS product_id FROM products WHERE 0=1", params };
  if (mode !== "sku") {
    for (const field of ["inventory_number", "code", "selection_id"]) {
      add(`SELECT id AS product_id FROM products WHERE ${field} = ?`, value);
    }
    if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      add("SELECT id AS product_id FROM products WHERE id = ?", Number(value));
    }
    const legacy = /^P-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d+$/i.exec(value);
    if (legacy) {
      const [, year, month, day, hour, minute, second] = legacy;
      const timestamp = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
      const date = new Date(timestamp.replace(" ", "T") + "Z");
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19).replace("T", " ") === timestamp) {
        add(`SELECT id AS product_id FROM products WHERE created_at = ? AND
          CASE WHEN code LIKE 'P-%' THEN code
            ELSE CONCAT('P-', DATE_FORMAT(created_at, '%Y%m%d-%H%i%s'), '-', LPAD(id, 3, '0')) END = ?`, timestamp, value);
      }
    }
  }
  if (mode !== "inventory_id") {
    for (const field of ["ozon_sku", "offer_id"]) {
      add(`SELECT product_id FROM sku_mappings WHERE active = 1 AND ${field} = ?`, value);
    }
  }
  return { sql: `SELECT DISTINCT product_id FROM (${branches.join(" UNION ALL ")}) matches WHERE product_id IS NOT NULL`, params };
}

export function isInventoryIdentifier(text) {
  return /^(?:\d+(?:-\d+)?|P-\d{8}-\d{6}-\d+|SEL-.+)$/i.test(String(text || "").trim());
}

export function inventoryNamePattern(text) {
  return `%${String(text).replace(/[=%_]/g, (char) => `=${char}`)}%`;
}

// Base snapshots are immutable for their cache lifetime. Weak keys release the
// search index automatically when a refresh replaces the snapshot.
const inventoryRowIndexes = new WeakMap();

export function searchInventoryRows(rows, text) {
  const query = String(text || "").trim().toLowerCase();
  if (!query) return rows;
  let index = inventoryRowIndexes.get(rows);
  if (!index) {
    const identifiers = new Map();
    const documents = rows.map((row) => {
      const skus = Array.isArray(row.skus) ? row.skus : [];
      const keys = [row.inventory_number, row.inventory_id, row.code, row.selection_id,
        row.product_id, row.ozon_sku, row.offer_id,
        ...skus.flatMap((sku) => [sku.ozon_sku, sku.offer_id])];
      for (const key of new Set(keys.filter((value) => value != null && value !== "").map((value) => String(value).toLowerCase()))) {
        if (!identifiers.has(key)) identifiers.set(key, []);
        identifiers.get(key).push(row);
      }
      return [row.product_name, row.name, row.shop_name, row.suggestion, ...keys,
        ...skus.flatMap((sku) => [sku.shop_name, sku.name])].join(" ").toLowerCase();
    });
    index = { identifiers, documents };
    inventoryRowIndexes.set(rows, index);
  }
  if (isInventoryIdentifier(query)) return (index.identifiers.get(query) || []).slice();
  const terms = query.split(/\s+/).filter(Boolean);
  return rows.filter((row, position) => terms.every((term) => index.documents[position].includes(term)));
}

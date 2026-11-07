export function normalizeInventoryNumberInput(text) {
  return String(text || '').trim().replace(/^(\d+)_(\d+)$/, '$1-$2');
}

export function inventoryNumberQueryMode(text, mode = 'auto') {
  const value = normalizeInventoryNumberInput(text);
  if (mode === 'inventory_prefix') return 'inventory_prefix';
  if (mode === 'inventory_id') return 'inventory_id';
  if (mode !== 'auto') return null;
  if (/^\d+-\d+-$/.test(value)) return 'inventory_prefix';
  return /^(?:\d+-\d+(?:-\d+)?|P-\d{8}-\d{6}-\d+|SEL-.+)$/i.test(value) ? 'inventory_id' : null;
}

export function inventoryPrefixPattern(text) {
  const value = String(text || '').trim();
  if (!/^\d+-\d+(?:-\d*)?$/.test(value)) return null;
  return /^\d+-\d+$/.test(value) ? value + '-%' : value + '%';
}

// Validate alias ownership independently of the caller's outer tenant/active
// predicate. A legacy NULL product belongs only to the actual default tenant.
export function inventoryAliasSearch(text, alias = 'p', { fuzzy = false } = {}) {
  if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) throw new Error('Invalid product alias');
  const value = normalizeInventoryNumberInput(text);
  return { sql: `EXISTS (SELECT 1 FROM inventory_number_aliases number_alias
    JOIN tenants number_alias_tenant ON number_alias_tenant.id = number_alias.tenant_id AND number_alias_tenant.status = 'active'
    WHERE number_alias.product_id = ${alias}.id
      AND (${alias}.tenant_id = number_alias.tenant_id OR (${alias}.tenant_id IS NULL AND number_alias_tenant.slug = 'default'))
      AND number_alias.alias_number ${fuzzy ? "LIKE ? ESCAPE '='" : '= ?'})`, params: [fuzzy ? inventoryNamePattern(value) : value] };
}

// Each identifier branch can use its own index; generated legacy IDs use created_at.
export function inventoryIdentifierSearch(text, mode = "auto") {
  const value = normalizeInventoryNumberInput(text);
  const branches = [];
  const params = [];
  const add = (sql, ...values) => { branches.push(sql); params.push(...values); };
  if (!value) return { sql: "SELECT id AS product_id FROM products WHERE 0=1", params };
  if (mode === 'inventory_prefix' || inventoryNumberQueryMode(value, mode) === 'inventory_prefix') {
    const pattern = inventoryPrefixPattern(value);
    return pattern ? { sql: "SELECT id AS product_id FROM products WHERE inventory_number LIKE ? ESCAPE '='", params: [pattern] }
      : { sql: 'SELECT id AS product_id FROM products WHERE 0=1', params: [] };
  }
  if (mode !== "sku") {
    for (const field of ["inventory_number", "code", "selection_id"]) {
      add(`SELECT id AS product_id FROM products WHERE ${field} = ?`, value);
    }
    const alias = inventoryAliasSearch(value, 'alias_product');
    add(`SELECT alias_product.id AS product_id FROM products alias_product WHERE ${alias.sql}`, ...alias.params);
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
  return /^(?:\d+(?:-\d+){0,2}|P-\d{8}-\d{6}-\d+|SEL-.+)$/i.test(normalizeInventoryNumberInput(text));
}

export function inventoryNamePattern(text) {
  return `%${String(text).replace(/[=%_]/g, (char) => `=${char}`)}%`;
}

// Base snapshots are immutable for their cache lifetime. Weak keys release the
// search index automatically when a refresh replaces the snapshot.
const inventoryRowIndexes = new WeakMap();

export function searchInventoryRows(rows, text) {
  const query = normalizeInventoryNumberInput(text).toLowerCase();
  if (!query) return rows;
  if (inventoryNumberQueryMode(query) === 'inventory_prefix') {
    const prefix = inventoryPrefixPattern(query).slice(0, -1);
    return rows.filter(row => String(row.inventory_number || '').startsWith(prefix));
  }
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

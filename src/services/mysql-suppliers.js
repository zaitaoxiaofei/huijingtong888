import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { getCachedMasterData, invalidateMasterDataCache } from "./mysql-master-data-cache.js";

function ensureMysqlSuppliersEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}

async function mysqlQueryOne(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

export async function suppliersMysql(query = {}) {
  ensureMysqlSuppliersEnabled();
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const cacheableDictionaryQuery = query.__skipCache !== "1" && paged && page === 1 && pageSize === 100 && !searchText && !dateFrom && !dateTo;
  if (cacheableDictionaryQuery) {
    return getCachedMasterData("suppliers:paged:100", () => suppliersMysql({ ...query, __skipCache: "1" }));
  }
  const where = ["s.status = 'active'"];
  const params = [];
  if (dateFrom) {
    where.push("DATE(COALESCE(s.created_at, s.updated_at)) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("DATE(COALESCE(s.created_at, s.updated_at)) <= ?");
    params.push(dateTo);
  }
  if (searchText) {
    const like = `%${searchText}%`;
    where.push("(LOWER(COALESCE(s.name, '')) LIKE ? OR LOWER(COALESCE(s.contact_person, '')) LIKE ? OR LOWER(COALESCE(s.contact_phone, '')) LIKE ? OR LOWER(COALESCE(s.wechat_id, '')) LIKE ? OR LOWER(COALESCE(s.business_note, '')) LIKE ?)");
    params.push(like, like, like, like, like);
  }
  const fromSql = `
    FROM suppliers s
    WHERE ${where.join(" AND ")}
  `;
  if (!paged) {
    const rows = await mysqlQuery(`
      SELECT s.*
      ${fromSql}
      ORDER BY s.id DESC
    `, params);
    return await attachProductCounts(rows);
  }
  const offset = (page - 1) * pageSize;
  const [totalRow, rows] = await Promise.all([
    mysqlQueryOne(`
      SELECT COUNT(*) AS total
      ${fromSql}
    `, params),
    mysqlQuery(`
      SELECT s.*
      ${fromSql}
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);
  const countedRows = await attachProductCounts(rows);
  return {
    rows: countedRows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

async function attachProductCounts(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const supplierIds = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!supplierIds.length) {
    return rows.map((row) => ({ ...row, product_count: 0 }));
  }

  const placeholders = supplierIds.map(() => "?").join(", ");
  const counts = await mysqlQuery(`
    SELECT supplier_id, COUNT(*) AS product_count
    FROM products
    WHERE active = 1 AND supplier_id IN (${placeholders})
    GROUP BY supplier_id
  `, supplierIds);
  const countMap = new Map(
    counts.map((row) => [Number(row.supplier_id), Number(row.product_count || 0)])
  );

  return rows.map((row) => ({
    ...row,
    product_count: countMap.get(Number(row.id)) || 0
  }));
}

export async function createSupplierMysql(body = {}) {
  ensureMysqlSuppliersEnabled();
  const name = requiredText(body.name, "Supplier name is required");
  const contactPerson = String(body.contact_person || "");
  const contactPhone = String(body.contact_phone || "");
  const wechatId = String(body.wechat_id || "");
  const businessNote = String(body.business_note || "");

  const result = await mysqlExecute(`
    INSERT INTO suppliers (name, contact_person, contact_phone, wechat_id, business_note, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `, [name, contactPerson, contactPhone, wechatId, businessNote]);

  invalidateMasterDataCache("suppliers:paged:100");
  return { id: Number(result.insertId), name };
}

export async function updateSupplierMysql(id, body = {}) {
  ensureMysqlSuppliersEnabled();
  const supplierId = Number(id);
  const existing = await mysqlQueryOne("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
  if (!existing) throw new Error("Supplier not found");

  const payload = [
    String(body.name || existing.name),
    body.contact_person ?? existing.contact_person,
    body.contact_phone ?? existing.contact_phone,
    body.wechat_id ?? existing.wechat_id,
    body.business_note ?? existing.business_note,
    supplierId
  ];

  await mysqlExecute(`
    UPDATE suppliers SET
      name = ?, contact_person = ?, contact_phone = ?,
      wechat_id = ?, business_note = ?
    WHERE id = ?
  `, payload);

  invalidateMasterDataCache("suppliers:paged:100");
  return { ok: true };
}

export async function deleteSupplierMysql(id) {
  ensureMysqlSuppliersEnabled();
  const supplierId = Number(id);
  const linkedProducts = await mysqlQueryOne(
    "SELECT COUNT(*) AS count FROM products WHERE supplier_id = ? AND active = 1",
    [supplierId]
  );

  if (Number(linkedProducts?.count || 0) > 0) {
    throw new Error(`Supplier still has ${linkedProducts.count} active products`);
  }

  await mysqlExecute("UPDATE suppliers SET status = 'inactive' WHERE id = ?", [supplierId]);
  invalidateMasterDataCache("suppliers:paged:100");
  return { ok: true };
}

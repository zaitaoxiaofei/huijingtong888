import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { getCachedMasterData, invalidateMasterDataCachePrefix } from "./mysql-master-data-cache.js";

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

function supplierTenantScope(tenantId, hasTenantColumn, alias = "s") {
  const normalized = String(tenantId ?? "").trim();
  if (normalized === "admin") return { sql: hasTenantColumn ? `${alias}.tenant_id IS NULL` : "1 = 1", params: [] };
  const tenantPk = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(tenantPk) || tenantPk <= 0) {
    const error = new Error("当前企业上下文无效，无法访问供应商");
    error.statusCode = 403;
    throw error;
  }
  return { sql: `${alias}.tenant_id = ?`, params: [tenantPk] };
}

let supplierTenantSchemaPromise = null;
async function hasSupplierTenantSchema() {
  if (!supplierTenantSchemaPromise) {
    supplierTenantSchemaPromise = mysqlQuery("SHOW COLUMNS FROM suppliers")
      .then((columns) => columns.some((column) => column.Field === "tenant_id"))
      .catch((error) => {
      supplierTenantSchemaPromise = null;
      throw error;
    });
  }
  return supplierTenantSchemaPromise;
}

async function resolveSupplierTenantScope(tenantId, alias = "s") {
  const hasTenantColumn = await hasSupplierTenantSchema();
  if (!hasTenantColumn && String(tenantId) !== "admin") {
    const error = new Error("供应商企业隔离暂不可用：suppliers.tenant_id 尚未迁移，请管理员先完成供应商租户迁移。");
    error.statusCode = 503;
    throw error;
  }
  return { hasTenantColumn, scope: supplierTenantScope(tenantId, hasTenantColumn, alias) };
}

export async function suppliersMysql(query = {}, tenantId = "admin") {
  ensureMysqlSuppliersEnabled();
  const { hasTenantColumn, scope } = await resolveSupplierTenantScope(tenantId);
  const paged = String(query.paged || "") === "1";
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const searchText = String(query.query || query.search || "").trim().toLowerCase();
  const dateFrom = String(query.dateFrom || query.date_from || "").slice(0, 10);
  const dateTo = String(query.dateTo || query.date_to || "").slice(0, 10);
  const cacheableDictionaryQuery = query.__skipCache !== "1" && paged && page === 1 && pageSize === 100 && !searchText && !dateFrom && !dateTo;
  if (cacheableDictionaryQuery) {
    return getCachedMasterData(`suppliers:${String(tenantId)}:paged:100`, () => suppliersMysql({ ...query, __skipCache: "1" }, tenantId));
  }
  const where = ["s.status = 'active'", scope.sql];
  const params = [...scope.params];
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
    return await attachProductCounts(rows, tenantId, hasTenantColumn);
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
  const countedRows = await attachProductCounts(rows, tenantId, hasTenantColumn);
  return {
    rows: countedRows,
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

async function attachProductCounts(rows, tenantId, hasTenantColumn) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const supplierIds = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!supplierIds.length) {
    return rows.map((row) => ({ ...row, product_count: 0 }));
  }

  const placeholders = supplierIds.map(() => "?").join(", ");
  const productScope = !hasTenantColumn ? "1 = 1" : String(tenantId) === "admin" ? "tenant_id IS NULL" : "tenant_id = ?";
  const countParams = !hasTenantColumn || String(tenantId) === "admin" ? supplierIds : [Number(tenantId), ...supplierIds];
  const counts = await mysqlQuery(`
    SELECT supplier_id, COUNT(*) AS product_count
    FROM products
    WHERE active = 1 AND ${productScope} AND supplier_id IN (${placeholders})
    GROUP BY supplier_id
  `, countParams);
  const countMap = new Map(
    counts.map((row) => [Number(row.supplier_id), Number(row.product_count || 0)])
  );

  return rows.map((row) => ({
    ...row,
    product_count: countMap.get(Number(row.id)) || 0
  }));
}

export async function createSupplierMysql(body = {}, tenantId = "admin") {
  ensureMysqlSuppliersEnabled();
  const { hasTenantColumn } = await resolveSupplierTenantScope(tenantId);
  const name = requiredText(body.name, "Supplier name is required");
  const contactPerson = String(body.contact_person || "");
  const contactPhone = String(body.contact_phone || "");
  const wechatId = String(body.wechat_id || "");
  const businessNote = String(body.business_note || "");

  const result = hasTenantColumn
    ? await mysqlExecute(`
        INSERT INTO suppliers (tenant_id, name, contact_person, contact_phone, wechat_id, business_note, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `, [String(tenantId) === "admin" ? null : Number(tenantId), name, contactPerson, contactPhone, wechatId, businessNote])
    : await mysqlExecute(`
        INSERT INTO suppliers (name, contact_person, contact_phone, wechat_id, business_note, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `, [name, contactPerson, contactPhone, wechatId, businessNote]);

  invalidateSupplierCache();
  return { id: Number(result.insertId), name };
}

export async function updateSupplierMysql(id, body = {}, tenantId = "admin") {
  ensureMysqlSuppliersEnabled();
  const { scope } = await resolveSupplierTenantScope(tenantId);
  const supplierId = Number(id);
  const existing = await mysqlQueryOne(`SELECT * FROM suppliers WHERE id = ? AND ${scope.sql}`, [supplierId, ...scope.params]);
  if (!existing) throw new Error("Supplier not found");

  const payload = [
    String(body.name || existing.name),
    body.contact_person ?? existing.contact_person,
    body.contact_phone ?? existing.contact_phone,
    body.wechat_id ?? existing.wechat_id,
    body.business_note ?? existing.business_note,
    supplierId,
    ...scope.params
  ];

  await mysqlExecute(`
    UPDATE suppliers SET
      name = ?, contact_person = ?, contact_phone = ?,
      wechat_id = ?, business_note = ?
    WHERE id = ? AND ${scope.sql}
  `, payload);

  invalidateSupplierCache();
  return { ok: true };
}

export async function deleteSupplierMysql(id, tenantId = "admin") {
  ensureMysqlSuppliersEnabled();
  const { hasTenantColumn, scope } = await resolveSupplierTenantScope(tenantId);
  const supplierId = Number(id);
  const linkedProducts = await mysqlQueryOne(
    `SELECT COUNT(*) AS count FROM products WHERE supplier_id = ? AND active = 1 AND ${!hasTenantColumn ? "1 = 1" : String(tenantId) === "admin" ? "tenant_id IS NULL" : "tenant_id = ?"}`,
    !hasTenantColumn || String(tenantId) === "admin" ? [supplierId] : [supplierId, Number(tenantId)]
  );

  if (Number(linkedProducts?.count || 0) > 0) {
    throw new Error(`Supplier still has ${linkedProducts.count} active products`);
  }

  const result = await mysqlExecute(`UPDATE suppliers SET status = 'inactive' WHERE id = ? AND ${scope.sql}`, [supplierId, ...scope.params]);
  if (!Number(result.affectedRows || 0)) throw new Error("Supplier not found");
  invalidateSupplierCache();
  return { ok: true };
}

function invalidateSupplierCache() {
  invalidateMasterDataCachePrefix("suppliers:");
}

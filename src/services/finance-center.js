import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

let schemaReady = false;

function monthRange(month) {
  const value = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7);
  const [year, number] = value.split("-").map(Number);
  const next = number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, "0")}-01`;
  return { month: value, from: `${value}-01`, toExclusive: next };
}

function requiredId(value, label) {
  const id = Number(value || 0);
  if (!id) {
    const error = new Error(`${label}不能为空`);
    error.status = 400;
    throw error;
  }
  return id;
}

function normalizedFinanceTenantId(tenantId = "admin") {
  if (String(tenantId) === "admin") return null;
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("企业财务数据暂不可用：当前企业标识无效。"), { statusCode: 503 });
  return id;
}

async function requireFinanceCompany(companyId, tenantId = "admin") {
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  const rows = await mysqlQuery(`SELECT id FROM finance_companies WHERE id = ? AND status != 'deleted' ${normalizedTenantId == null ? "AND (tenant_id IS NULL OR tenant_id = 0)" : "AND tenant_id = ?"} LIMIT 1`, [Number(companyId), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
  if (!rows.length) throw Object.assign(new Error("公司档案不存在或不属于当前企业。"), { statusCode: 404 });
  return normalizedTenantId;
}

export async function ensureFinanceCenterSchema() {
  if (schemaReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS finance_companies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NULL,
      name VARCHAR(255) NOT NULL,
      tax_number VARCHAR(64) NULL,
      taxpayer_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
      bank_name VARCHAR(255) NULL,
      bank_account VARCHAR(128) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_finance_company_tenant_name (tenant_id, name),
      KEY idx_finance_company_tenant_status (tenant_id, status, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS finance_shop_company_assignments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NULL,
      shop_id BIGINT UNSIGNED NOT NULL,
      company_id BIGINT UNSIGNED NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_finance_shop_company_period (shop_id, effective_from),
      KEY idx_finance_assignment_company_period (company_id, effective_from, effective_to),
      KEY idx_finance_assignment_tenant_shop_period (tenant_id, shop_id, effective_from, effective_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS finance_expenses (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NULL,
      company_id BIGINT UNSIGNED NOT NULL,
      shop_id BIGINT UNSIGNED NULL,
      expense_date DATE NOT NULL,
      category VARCHAR(64) NOT NULL,
      counterparty VARCHAR(255) NULL,
      description VARCHAR(500) NULL,
      currency_code VARCHAR(16) NOT NULL DEFAULT 'CNY',
      original_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
      exchange_rate DECIMAL(18,8) NOT NULL DEFAULT 1,
      amount_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
      paid_by VARCHAR(255) NULL,
      advanced_by VARCHAR(255) NULL,
      is_advance_payment TINYINT(1) NOT NULL DEFAULT 0,
      payment_reference VARCHAR(255) NULL,
      voucher_status VARCHAR(32) NOT NULL DEFAULT 'missing',
      source_type VARCHAR(64) NULL,
      source_id BIGINT UNSIGNED NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_finance_expense_company_date (company_id, expense_date),
      KEY idx_finance_expense_tenant_company_date (tenant_id, company_id, expense_date, id),
      UNIQUE KEY uk_finance_expense_source (source_type, source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS finance_vouchers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NULL,
      company_id BIGINT UNSIGNED NOT NULL,
      expense_id BIGINT UNSIGNED NULL,
      voucher_type VARCHAR(64) NOT NULL,
      voucher_number VARCHAR(128) NULL,
      issue_date DATE NULL,
      seller_name VARCHAR(255) NULL,
      buyer_name VARCHAR(255) NULL,
      seller_tax_number VARCHAR(64) NULL,
      buyer_tax_number VARCHAR(64) NULL,
      currency_code VARCHAR(16) NOT NULL DEFAULT 'CNY',
      total_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
      attachment_url TEXT NULL,
      deduction_candidate VARCHAR(32) NOT NULL DEFAULT 'review',
      review_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      review_note VARCHAR(500) NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_finance_voucher_company_date (company_id, issue_date),
      KEY idx_finance_voucher_tenant_company_date (tenant_id, company_id, issue_date, id),
      KEY idx_finance_voucher_expense (expense_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS finance_periods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NULL,
      company_id BIGINT UNSIGNED NOT NULL,
      month_key CHAR(7) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'preparing',
      close_note VARCHAR(500) NULL,
      closed_by BIGINT UNSIGNED NULL,
      closed_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_finance_period (company_id, month_key),
      KEY idx_finance_period_tenant_company_month (tenant_id, company_id, month_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
  ];
  for (const sql of statements) await mysqlExecute(sql);
  for (const [table, column, definition] of [
    ["finance_companies", "tenant_id", "BIGINT UNSIGNED NULL"],
    ["finance_shop_company_assignments", "tenant_id", "BIGINT UNSIGNED NULL"],
    ["finance_expenses", "tenant_id", "BIGINT UNSIGNED NULL"],
    ["finance_vouchers", "tenant_id", "BIGINT UNSIGNED NULL"],
    ["finance_periods", "tenant_id", "BIGINT UNSIGNED NULL"]
  ]) {
    try { await mysqlExecute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  }
  for (const [table, name, definition] of [
    ["finance_companies", "idx_finance_company_tenant_status", "(tenant_id, status, id)"],
    ["finance_shop_company_assignments", "idx_finance_assignment_tenant_shop_period", "(tenant_id, shop_id, effective_from, effective_to)"],
    ["finance_expenses", "idx_finance_expense_tenant_company_date", "(tenant_id, company_id, expense_date, id)"],
    ["finance_vouchers", "idx_finance_voucher_tenant_company_date", "(tenant_id, company_id, issue_date, id)"],
    ["finance_periods", "idx_finance_period_tenant_company_month", "(tenant_id, company_id, month_key)"]
  ]) {
    try { await mysqlExecute(`ALTER TABLE ${table} ADD KEY ${name} ${definition}`); } catch (error) { if (error?.code !== "ER_DUP_KEYNAME") throw error; }
  }
  try { await mysqlExecute("ALTER TABLE finance_companies ADD UNIQUE KEY uk_finance_company_tenant_name (tenant_id, name)"); } catch (error) { if (!["ER_DUP_KEYNAME", "ER_DUP_ENTRY"].includes(error?.code)) throw error; }
  try { await mysqlExecute("ALTER TABLE finance_vouchers ADD COLUMN finance_item_id BIGINT UNSIGNED NULL AFTER expense_id"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_vouchers ADD KEY idx_finance_voucher_item (finance_item_id)"); } catch (error) { if (!["ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"].includes(error?.code)) throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD COLUMN paid_by VARCHAR(255) NULL AFTER amount_cny"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD COLUMN advanced_by VARCHAR(255) NULL AFTER paid_by"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD COLUMN is_advance_payment TINYINT(1) NOT NULL DEFAULT 0 AFTER advanced_by"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD COLUMN source_type VARCHAR(64) NULL AFTER voucher_status"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD COLUMN source_id BIGINT UNSIGNED NULL AFTER source_type"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  try { await mysqlExecute("ALTER TABLE finance_expenses ADD UNIQUE KEY uk_finance_expense_source (source_type, source_id)"); } catch (error) { if (!['ER_DUP_KEYNAME', 'ER_DUP_ENTRY'].includes(error?.code)) throw error; }
  await mysqlExecute(`INSERT INTO finance_companies (tenant_id, name)
    SELECT NULL, ? WHERE NOT EXISTS (SELECT 1 FROM finance_companies WHERE tenant_id IS NULL AND name = ?)
    UNION ALL
    SELECT NULL, ? WHERE NOT EXISTS (SELECT 1 FROM finance_companies WHERE tenant_id IS NULL AND name = ?)
  `, ["上海汇境通国际贸易有限公司", "上海汇境通国际贸易有限公司", "合肥鑫瀚电子科技有限公司", "合肥鑫瀚电子科技有限公司"]);
  await mysqlExecute(`
    INSERT IGNORE INTO finance_shop_company_assignments (shop_id, company_id, effective_from)
    SELECT s.id, c.id, '2000-01-01'
    FROM shops s CROSS JOIN finance_companies c
    WHERE c.name = '上海汇境通国际贸易有限公司'
      AND s.status != 'deleted'
      AND (UPPER(TRIM(s.name)) IN ('RUVIBE MART', 'RUVIBE MART M', 'RUVIBE MART X', 'RUVIBE MART S')
        OR UPPER(TRIM(s.name)) REGEXP '^(M|X|S)(店|店铺|SHOP)?$')
  `);
  await mysqlExecute(`
    INSERT IGNORE INTO finance_shop_company_assignments (shop_id, company_id, effective_from)
    SELECT s.id, c.id, '2000-01-01'
    FROM shops s CROSS JOIN finance_companies c
    WHERE c.name = '合肥鑫瀚电子科技有限公司'
      AND s.status != 'deleted'
      AND (UPPER(TRIM(s.name)) IN ('VELOAUTO', 'RUVIBE MART Z')
        OR UPPER(TRIM(s.name)) REGEXP '^(V|Z)(店|店铺|SHOP)?$')
  `);
  schemaReady = true;
}

export async function financeCompanies(tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  const tenantScoped = normalizedTenantId != null;
  const companyFilter = tenantScoped ? "AND tenant_id = ?" : "AND (tenant_id IS NULL OR tenant_id = 0)";
  const companies = await mysqlQuery(`SELECT * FROM finance_companies WHERE status != 'deleted' ${companyFilter} ORDER BY id`, tenantScoped ? [normalizedTenantId] : []);
  const assignments = await mysqlQuery(`
    SELECT a.*, s.name AS shop_name, c.name AS company_name
    FROM finance_shop_company_assignments a
    JOIN shops s ON s.id = a.shop_id AND s.status != 'deleted' ${tenantScoped ? "AND s.tenant_id = ?" : ""}
    JOIN finance_companies c ON c.id = a.company_id ${tenantScoped ? "AND c.tenant_id = ?" : ""}
    WHERE ${tenantScoped ? "a.tenant_id = ?" : "(a.tenant_id IS NULL OR a.tenant_id = 0)"}
    ORDER BY s.name, a.effective_from DESC
  `, tenantScoped ? [normalizedTenantId, normalizedTenantId, normalizedTenantId] : []);
  const shops = await mysqlQuery(`SELECT id, name FROM shops WHERE status != 'deleted' ${tenantScoped ? "AND tenant_id = ?" : ""} ORDER BY id`, tenantScoped ? [normalizedTenantId] : []);
  return { companies, assignments, shops };
}

export async function saveFinanceCompany(body = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const name = String(body.name || "").trim();
  if (!name) throw new Error("公司名称不能为空");
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  const tenantScoped = normalizedTenantId != null;
  if (body.id) {
    const ownership = await mysqlQuery(`SELECT id FROM finance_companies WHERE id = ? ${tenantScoped ? "AND tenant_id = ?" : "AND (tenant_id IS NULL OR tenant_id = 0)"} LIMIT 1`, [Number(body.id), ...(tenantScoped ? [normalizedTenantId] : [])]);
    if (!ownership.length) throw Object.assign(new Error("公司档案不存在或不属于当前企业。"), { statusCode: 404 });
    await mysqlExecute(`UPDATE finance_companies SET name=?, tax_number=?, taxpayer_type=?, bank_name=?, bank_account=? WHERE id=? ${tenantScoped ? "AND tenant_id = ?" : "AND (tenant_id IS NULL OR tenant_id = 0)"}`, [name, body.tax_number || null, body.taxpayer_type || "unknown", body.bank_name || null, body.bank_account || null, Number(body.id), ...(tenantScoped ? [normalizedTenantId] : [])]);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute(`INSERT INTO finance_companies (tenant_id, name, tax_number, taxpayer_type, bank_name, bank_account) VALUES (?, ?, ?, ?, ?, ?)`, [normalizedTenantId, name, body.tax_number || null, body.taxpayer_type || "unknown", body.bank_name || null, body.bank_account || null]);
  return { ok: true, id: Number(result.insertId) };
}

export async function saveShopCompanyAssignment(body = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const shopId = requiredId(body.shop_id, "店铺");
  const companyId = requiredId(body.company_id, "公司");
  const effectiveFrom = String(body.effective_from || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error("生效日期不能为空");
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  const tenantScoped = normalizedTenantId != null;
  if (tenantScoped) {
    const [shopRows, companyRows] = await Promise.all([
      mysqlQuery("SELECT id FROM shops WHERE id = ? AND tenant_id = ? AND status != 'deleted' LIMIT 1", [shopId, normalizedTenantId]),
      mysqlQuery("SELECT id FROM finance_companies WHERE id = ? AND tenant_id = ? AND status != 'deleted' LIMIT 1", [companyId, normalizedTenantId])
    ]);
    if (!shopRows.length || !companyRows.length) throw Object.assign(new Error("店铺或公司档案不存在，或不属于当前企业。"), { statusCode: 404 });
  }
  await mysqlExecute(`UPDATE finance_shop_company_assignments SET effective_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE shop_id = ? AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?) ${tenantScoped ? "AND tenant_id = ?" : "AND (tenant_id IS NULL OR tenant_id = 0)"}`, [effectiveFrom, shopId, effectiveFrom, effectiveFrom, ...(tenantScoped ? [normalizedTenantId] : [])]);
  await mysqlExecute(`INSERT INTO finance_shop_company_assignments (tenant_id, shop_id, company_id, effective_from, effective_to) VALUES (?, ?, ?, ?, NULL) ON DUPLICATE KEY UPDATE company_id=VALUES(company_id), tenant_id=VALUES(tenant_id), effective_to=NULL`, [normalizedTenantId, shopId, companyId, effectiveFrom]);
  return { ok: true };
}

export async function financeExpenses(query = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const { from, toExclusive } = monthRange(query.month);
  const companyId = requiredId(query.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const tenantFilter = normalizedTenantId == null ? "AND (e.tenant_id IS NULL OR e.tenant_id = 0)" : "AND e.tenant_id = ? AND c.tenant_id = ?";
  return mysqlQuery(`SELECT e.*, s.name AS shop_name, c.name AS company_name FROM finance_expenses e JOIN finance_companies c ON c.id=e.company_id LEFT JOIN shops s ON s.id=e.shop_id ${normalizedTenantId == null ? "" : "AND s.tenant_id = ?"} WHERE e.company_id=? ${tenantFilter} AND e.expense_date>=? AND e.expense_date<? ORDER BY e.expense_date DESC, e.id DESC`, [...(normalizedTenantId == null ? [] : [normalizedTenantId]), companyId, ...(normalizedTenantId == null ? [] : [normalizedTenantId, normalizedTenantId]), from, toExclusive]);
}

export async function saveFinanceExpense(body = {}, personId = null, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(body.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  if (normalizedTenantId != null) {
    const shopId = body.shop_id ? Number(body.shop_id) : null;
    if (shopId) {
      const shops = await mysqlQuery(`SELECT s.id FROM shops s JOIN finance_shop_company_assignments a ON a.shop_id=s.id AND a.company_id=? AND a.tenant_id=? AND a.effective_from<=? AND (a.effective_to IS NULL OR a.effective_to>=?) WHERE s.id=? AND s.tenant_id=? AND s.status!='deleted' LIMIT 1`, [companyId, normalizedTenantId, String(body.expense_date || "").slice(0, 10), String(body.expense_date || "").slice(0, 10), shopId, normalizedTenantId]);
      if (!shops.length) throw Object.assign(new Error("费用关联店铺不存在或未归属于当前企业的该公司。"), { statusCode: 404 });
    }
    if (body.id) {
      const existing = await mysqlQuery("SELECT id FROM finance_expenses WHERE id=? AND company_id=? AND tenant_id=? LIMIT 1", [Number(body.id), companyId, normalizedTenantId]);
      if (!existing.length) throw Object.assign(new Error("费用记录不存在或不属于当前企业。"), { statusCode: 404 });
    }
  }
  const amount = Number(body.original_amount || 0);
  const rate = Number(body.exchange_rate || 1);
  const params = [companyId, body.shop_id ? Number(body.shop_id) : null, String(body.expense_date || "").slice(0, 10), body.category || "other", body.counterparty || null, body.description || null, body.currency_code || "CNY", amount, rate, Number(body.amount_cny ?? amount * rate), body.paid_by || null, body.advanced_by || null, body.is_advance_payment ? 1 : 0, body.payment_reference || null, body.voucher_status || "missing"];
  if (body.id) {
    await mysqlExecute(`UPDATE finance_expenses SET company_id=?, shop_id=?, expense_date=?, category=?, counterparty=?, description=?, currency_code=?, original_amount=?, exchange_rate=?, amount_cny=?, paid_by=?, advanced_by=?, is_advance_payment=?, payment_reference=?, voucher_status=? WHERE id=? ${normalizedTenantId == null ? "AND (tenant_id IS NULL OR tenant_id=0)" : "AND tenant_id=?"}`, [...params, Number(body.id), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute(`INSERT INTO finance_expenses (tenant_id, company_id, shop_id, expense_date, category, counterparty, description, currency_code, original_amount, exchange_rate, amount_cny, paid_by, advanced_by, is_advance_payment, payment_reference, voucher_status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [normalizedTenantId, ...params, personId || null]);
  return { ok: true, id: Number(result.insertId) };
}

export async function deleteFinanceExpense(id, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  await mysqlExecute(`DELETE FROM finance_expenses WHERE id=? ${normalizedTenantId == null ? "AND (tenant_id IS NULL OR tenant_id=0)" : "AND tenant_id=?"}`, [requiredId(id, "费用"), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
  return { ok: true };
}

export async function financeVouchers(query = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(query.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const { from, toExclusive } = monthRange(query.month);
  const tenantFilter = normalizedTenantId == null ? "AND (v.tenant_id IS NULL OR v.tenant_id=0)" : "AND v.tenant_id=? AND c.tenant_id=?";
  const rows = await mysqlQuery(`SELECT v.*, e.description AS expense_description, e.category AS expense_category, ofi.operation_id, ofi.posting_number, COALESCE(NULLIF(ofi.service_name,''), ofi.service_type) AS finance_item_name FROM finance_vouchers v JOIN finance_companies c ON c.id=v.company_id LEFT JOIN finance_expenses e ON e.id=v.expense_id AND e.company_id=v.company_id ${normalizedTenantId == null ? "" : "AND e.tenant_id=?"} LEFT JOIN ozon_finance_items ofi ON ofi.id=v.finance_item_id ${normalizedTenantId == null ? "" : "AND EXISTS (SELECT 1 FROM shops s JOIN finance_shop_company_assignments a ON a.shop_id=s.id AND a.company_id=v.company_id AND a.tenant_id=? AND a.effective_from<=ofi.operation_date AND (a.effective_to IS NULL OR a.effective_to>=ofi.operation_date) WHERE s.id=ofi.shop_id AND s.tenant_id=?)"} WHERE v.company_id=? ${tenantFilter} AND COALESCE(v.issue_date, DATE(v.created_at))>=? AND COALESCE(v.issue_date, DATE(v.created_at))<? ORDER BY v.created_at DESC`, [...(normalizedTenantId == null ? [] : [normalizedTenantId, normalizedTenantId, normalizedTenantId]), companyId, ...(normalizedTenantId == null ? [] : [normalizedTenantId, normalizedTenantId]), from, toExclusive]);
  return normalizedTenantId == null ? rows : rows.map((voucher) => ({ ...voucher, attachment_url: null }));
}

export async function financePlatformItems(query = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(query.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const { from, toExclusive } = monthRange(query.month);
  return mysqlQuery(`
    SELECT ofi.id, ofi.shop_id, s.name AS shop_name, ofi.operation_id, ofi.posting_number, ofi.operation_date,
      COALESCE(NULLIF(ofi.service_name,''), ofi.service_type) AS item_name, ofi.currency_code,
      ofi.amount, ofi.amount_cny, ofi.sale_commission_cny, ofi.delivery_charge_cny,
      CASE WHEN v.id IS NULL THEN 'unmatched' ELSE v.review_status END AS voucher_status,
      v.id AS voucher_id
    FROM ozon_finance_items ofi
    JOIN shops s ON s.id=ofi.shop_id ${normalizedTenantId == null ? "" : "AND s.tenant_id=?"}
    JOIN finance_shop_company_assignments a ON a.shop_id=ofi.shop_id AND a.company_id=? AND a.effective_from<? AND (a.effective_to IS NULL OR a.effective_to>=?) ${normalizedTenantId == null ? "AND (a.tenant_id IS NULL OR a.tenant_id=0)" : "AND a.tenant_id=?"}
    LEFT JOIN finance_vouchers v ON v.finance_item_id=ofi.id AND v.company_id=a.company_id ${normalizedTenantId == null ? "AND (v.tenant_id IS NULL OR v.tenant_id=0)" : "AND v.tenant_id=?"}
    WHERE ofi.operation_date>=? AND ofi.operation_date<?
    ORDER BY ofi.operation_date DESC, ofi.id DESC LIMIT 1000
  `, [...(normalizedTenantId == null ? [] : [normalizedTenantId]), companyId, toExclusive, from, ...(normalizedTenantId == null ? [] : [normalizedTenantId, normalizedTenantId]), from, toExclusive]);
}

async function refreshExpenseVoucherStatus(expenseId, tenantId = "admin") {
  if (!expenseId) return;
  const normalizedTenantId = normalizedFinanceTenantId(tenantId);
  const tenantFilter = normalizedTenantId == null ? "AND (tenant_id IS NULL OR tenant_id=0)" : "AND tenant_id=?";
  const rows = await mysqlQuery(`SELECT COUNT(*) total, SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END) approved FROM finance_vouchers WHERE expense_id=? ${tenantFilter}`, [Number(expenseId), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
  const summary = rows[0] || {};
  const status = Number(summary.approved || 0) > 0 ? "matched" : Number(summary.total || 0) > 0 ? "pending" : "missing";
  await mysqlExecute(`UPDATE finance_expenses SET voucher_status=? WHERE id=? ${tenantFilter}`, [status, Number(expenseId), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
}

export async function saveFinanceVoucher(body = {}, personId = null, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(body.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const tenantFilter = normalizedTenantId == null ? "AND (tenant_id IS NULL OR tenant_id=0)" : "AND tenant_id=?";
  if (normalizedTenantId != null) {
    if (String(body.attachment_url || "").trim()) throw Object.assign(new Error("企业凭证附件隔离尚未完成，暂不支持关联附件或外部归档地址。"), { statusCode: 403 });
    if (body.expense_id) {
      const expense = await mysqlQuery("SELECT id FROM finance_expenses WHERE id=? AND company_id=? AND tenant_id=? LIMIT 1", [Number(body.expense_id), companyId, normalizedTenantId]);
      if (!expense.length) throw Object.assign(new Error("关联费用不存在或不属于当前企业及公司。"), { statusCode: 404 });
    }
    if (body.finance_item_id) {
      const platformItem = await mysqlQuery(`SELECT ofi.id FROM ozon_finance_items ofi JOIN shops s ON s.id=ofi.shop_id AND s.tenant_id=? JOIN finance_shop_company_assignments a ON a.shop_id=s.id AND a.company_id=? AND a.tenant_id=? AND a.effective_from<=ofi.operation_date AND (a.effective_to IS NULL OR a.effective_to>=ofi.operation_date) WHERE ofi.id=? LIMIT 1`, [normalizedTenantId, companyId, normalizedTenantId, Number(body.finance_item_id)]);
      if (!platformItem.length) throw Object.assign(new Error("关联平台流水不存在或不属于当前企业及公司。"), { statusCode: 404 });
    }
    if (body.id) {
      const existing = await mysqlQuery("SELECT id, expense_id FROM finance_vouchers WHERE id=? AND company_id=? AND tenant_id=? LIMIT 1", [Number(body.id), companyId, normalizedTenantId]);
      if (!existing.length) throw Object.assign(new Error("凭证记录不存在或不属于当前企业。"), { statusCode: 404 });
    }
  }
  const oldRows = body.id ? await mysqlQuery(`SELECT expense_id FROM finance_vouchers WHERE id=? ${tenantFilter}`, [Number(body.id), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]) : [];
  const oldExpenseId = oldRows[0]?.expense_id || null;
  const params = [companyId, body.expense_id ? Number(body.expense_id) : null, body.finance_item_id ? Number(body.finance_item_id) : null, body.voucher_type || "other", body.voucher_number || null, body.issue_date || null, body.seller_name || null, body.buyer_name || null, body.seller_tax_number || null, body.buyer_tax_number || null, body.currency_code || "CNY", Number(body.total_amount || 0), Number(body.tax_amount || 0), body.attachment_url || null, body.deduction_candidate || "review", body.review_status || "pending", body.review_note || null];
  if (body.id) {
    await mysqlExecute(`UPDATE finance_vouchers SET company_id=?, expense_id=?, finance_item_id=?, voucher_type=?, voucher_number=?, issue_date=?, seller_name=?, buyer_name=?, seller_tax_number=?, buyer_tax_number=?, currency_code=?, total_amount=?, tax_amount=?, attachment_url=?, deduction_candidate=?, review_status=?, review_note=? WHERE id=? ${tenantFilter}`, [...params, Number(body.id), ...(normalizedTenantId == null ? [] : [normalizedTenantId])]);
    await refreshExpenseVoucherStatus(oldExpenseId, tenantId);
    await refreshExpenseVoucherStatus(body.expense_id, tenantId);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute(`INSERT INTO finance_vouchers (tenant_id, company_id, expense_id, finance_item_id, voucher_type, voucher_number, issue_date, seller_name, buyer_name, seller_tax_number, buyer_tax_number, currency_code, total_amount, tax_amount, attachment_url, deduction_candidate, review_status, review_note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [normalizedTenantId, ...params, personId || null]);
  await refreshExpenseVoucherStatus(body.expense_id, tenantId);
  return { ok: true, id: Number(result.insertId) };
}

function xmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function excelCell(value, type = "String") {
  return `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;
}

function excelSheet(name, headers, rows) {
  const header = `<Row>${headers.map((item) => excelCell(item)).join("")}</Row>`;
  const body = rows.map((row) => `<Row>${row.map((value) => excelCell(value, typeof value === "number" ? "Number" : "String")).join("")}</Row>`).join("");
  return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${header}${body}</Table></Worksheet>`;
}

export async function financeMonthlyExport(query = {}, tenantId = "admin") {
  const companyId = requiredId(query.company_id, "公司");
  const { month } = monthRange(query.month);
  const [report, expenses, vouchers, platformItems] = await Promise.all([
    financeMonthlyReport({ company_id: companyId, month }, tenantId), financeExpenses({ company_id: companyId, month }, tenantId), financeVouchers({ company_id: companyId, month }, tenantId), financePlatformItems({ company_id: companyId, month }, tenantId)
  ]);
  const sheets = [
    excelSheet("月度汇总", ["公司", "月份", "科目", "来源", "金额（人民币）"], report.rows.map((row) => [report.company?.name || "", month, row.label, row.source, Number(row.amount || 0)])),
    excelSheet("人工费用", ["日期", "类别", "店铺", "对方单位", "说明", "币种", "原币金额", "人民币金额", "凭证状态", "付款参考"], expenses.map((row) => [String(row.expense_date || "").slice(0,10), row.category, row.shop_name || "公司共用", row.counterparty || "", row.description || "", row.currency_code, Number(row.original_amount || 0), Number(row.amount_cny || 0), row.voucher_status, row.payment_reference || ""])),
    excelSheet("凭证目录", ["开具日期", "凭证类型", "凭证号码", "开具方", "购买方", "金额", "税额", "审核状态", "关联费用", "关联平台流水", "附件"], vouchers.map((row) => [String(row.issue_date || "").slice(0,10), row.voucher_type, row.voucher_number || "", row.seller_name || "", row.buyer_name || "", Number(row.total_amount || 0), Number(row.tax_amount || 0), row.review_status, row.expense_description || "", row.finance_item_name || "", row.attachment_url || ""])),
    excelSheet("缺口清单", ["类型", "日期", "店铺", "业务内容", "金额（人民币）", "缺口"], [
      ...expenses.filter((row) => row.voucher_status !== "matched").map((row) => ["人工费用", String(row.expense_date || "").slice(0,10), row.shop_name || "公司共用", row.description || row.category, Number(row.amount_cny || 0), row.voucher_status === "pending" ? "凭证待审核" : "缺少凭证"]),
      ...platformItems.filter((row) => row.voucher_status === "unmatched" && Number(row.amount_cny || 0) < 0).map((row) => ["平台费用", String(row.operation_date || "").slice(0,10), row.shop_name, row.item_name, Math.abs(Number(row.amount_cny || 0)), "未匹配平台账单或法律凭证"])
    ])
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets.join("")}</Workbook>`;
  return { buffer: Buffer.from(xml, "utf8"), filename: `财务报账-${report.company?.name || companyId}-${month}.xls` };
}

export async function financeMonthlyReport(query = {}, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(query.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const tenantScoped = normalizedTenantId != null;
  const { month, from, toExclusive } = monthRange(query.month);
  const assignmentJoin = `JOIN finance_shop_company_assignments a ON a.shop_id = source.shop_id AND a.company_id = ? AND a.effective_from < ? AND (a.effective_to IS NULL OR a.effective_to >= ?) ${tenantScoped ? "AND a.tenant_id = ?" : "AND (a.tenant_id IS NULL OR a.tenant_id = 0)"} ${tenantScoped ? "JOIN shops finance_tenant_shop ON finance_tenant_shop.id = source.shop_id AND finance_tenant_shop.tenant_id = ?" : ""}`;
  const assignmentParams = [companyId, toExclusive, from, ...(tenantScoped ? [normalizedTenantId, normalizedTenantId] : [])];
  const companyFilter = tenantScoped ? "AND tenant_id = ?" : "AND (tenant_id IS NULL OR tenant_id = 0)";
  const companyParams = tenantScoped ? [companyId, normalizedTenantId] : [companyId];
  const [companyRows, shops, commerceRows, financeRows, adRows, profitRows, expenseRows, voucherRows, periodRows] = await Promise.all([
    mysqlQuery(`SELECT * FROM finance_companies WHERE id=? ${companyFilter}`, companyParams),
    mysqlQuery(`SELECT DISTINCT s.id, s.name FROM shops s JOIN finance_shop_company_assignments a ON a.shop_id=s.id AND a.company_id=? AND a.effective_from<? AND (a.effective_to IS NULL OR a.effective_to>=?) ${tenantScoped ? "AND a.tenant_id=? AND s.tenant_id=?" : "AND (a.tenant_id IS NULL OR a.tenant_id=0)"} ORDER BY s.name`, [companyId, toExclusive, from, ...(tenantScoped ? [normalizedTenantId, normalizedTenantId] : [])]),
    mysqlQuery(`SELECT COALESCE(SUM(source.revenue),0) revenue, COALESCE(SUM(source.cancelled_revenue),0) cancelled_revenue, COALESCE(SUM(source.return_revenue),0) return_revenue, COALESCE(SUM(source.return_loss),0) return_loss, COALESCE(SUM(source.effective_orders),0) effective_orders, COALESCE(SUM(source.cancelled_orders),0) cancelled_orders, COALESCE(SUM(source.return_orders),0) return_orders FROM analytics_shop_daily source ${assignmentJoin} WHERE source.date_key>=? AND source.date_key<?`, [...assignmentParams, from, toExclusive]),
    mysqlQuery(`SELECT COALESCE(SUM(CASE WHEN source.accruals_for_sale_cny>0 THEN source.accruals_for_sale_cny ELSE 0 END),0) settlement_revenue, COALESCE(SUM(source.amount_cny),0) net_settlement_cashflow, COALESCE(SUM(ABS(source.sale_commission_cny)),0) commission, COALESCE(SUM(ABS(source.delivery_charge_cny)),0) delivery, COALESCE(SUM(ABS(source.return_delivery_charge_cny)),0) return_delivery, COALESCE(SUM(CASE WHEN source.amount_cny<0 THEN -source.amount_cny ELSE 0 END),0) total_platform_fees, COUNT(*) finance_rows, MAX(source.synced_at) last_synced_at FROM ozon_finance_items source ${assignmentJoin} WHERE source.operation_date>=? AND source.operation_date<?`, [...assignmentParams, from, toExclusive]),
    mysqlQuery(`SELECT COALESCE(SUM(source.spend_cny),0) advertising FROM ozon_ad_sku_daily source ${assignmentJoin} WHERE source.date_key>=? AND source.date_key<?`, [...assignmentParams, from, toExclusive]),
    mysqlQuery(`SELECT COALESCE(SUM(opi.purchase_cost_cny),0) purchase_cost, COALESCE(SUM(opi.domestic_shipping_cny),0) domestic_freight, COALESCE(SUM(opi.international_shipping_cny),0) international_freight, COALESCE(SUM(opi.net_profit_cny),0) order_profit, COUNT(*) order_item_count, SUM(CASE WHEN opi.order_item_id IS NULL OR opi.purchase_cost_cny IS NULL OR opi.purchase_cost_cny<=0 THEN 1 ELSE 0 END) missing_cost_items FROM orders source JOIN order_items oi ON oi.order_id=source.id LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id ${assignmentJoin} WHERE source.ordered_at>=? AND source.ordered_at<?`, [...assignmentParams, from, toExclusive]),
    mysqlQuery(`SELECT COALESCE(SUM(amount_cny),0) manual_expenses, COUNT(*) expense_count, SUM(CASE WHEN voucher_status!='matched' THEN 1 ELSE 0 END) missing_expense_vouchers FROM finance_expenses WHERE company_id=? ${tenantScoped ? "AND tenant_id=?" : "AND (tenant_id IS NULL OR tenant_id=0)"} AND expense_date>=? AND expense_date<?`, [...companyParams, from, toExclusive]),
    mysqlQuery(`SELECT COALESCE(SUM(total_amount),0) voucher_amount, COUNT(*) voucher_count, SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END) approved_vouchers, SUM(CASE WHEN review_status IN ('pending','supplement') THEN 1 ELSE 0 END) pending_vouchers FROM finance_vouchers WHERE company_id=? ${tenantScoped ? "AND tenant_id=?" : "AND (tenant_id IS NULL OR tenant_id=0)"} AND COALESCE(issue_date, DATE(created_at))>=? AND COALESCE(issue_date, DATE(created_at))<?`, [...companyParams, from, toExclusive]),
    mysqlQuery(`SELECT * FROM finance_periods WHERE company_id=? ${tenantScoped ? "AND tenant_id=?" : "AND (tenant_id IS NULL OR tenant_id=0)"} AND month_key=?`, [...companyParams, month])
  ]);
  const commerce = commerceRows[0] || {};
  const finance = financeRows[0] || {};
  const ad = adRows[0] || {};
  const profit = profitRows[0] || {};
  const expenses = expenseRows[0] || {};
  const vouchers = voucherRows[0] || {};
  const revenue = Number(finance.settlement_revenue || 0) || Number(commerce.revenue || 0);
  const platformOther = Math.max(0, Number(finance.total_platform_fees || 0) - Number(finance.commission || 0) - Number(finance.delivery || 0) - Number(finance.return_delivery || 0));
  const totalCosts = Number(profit.purchase_cost || 0) + Number(finance.commission || 0) + Number(finance.delivery || 0) + Number(finance.return_delivery || 0) + Number(ad.advertising || 0) + platformOther + Number(expenses.manual_expenses || 0);
  const operatingProfit = revenue - totalCosts;
  const orderRevenue = Number(commerce.revenue || 0);
  const revenueVariance = Number(finance.settlement_revenue || 0) - orderRevenue;
  const costCoverage = Number(profit.order_item_count || 0) > 0 ? Math.max(0, 1 - Number(profit.missing_cost_items || 0) / Number(profit.order_item_count || 0)) : 0;
  const rows = [
    ["revenue", "营业收入", revenue, "system"], ["purchase", "采购成本", Number(profit.purchase_cost || 0), "system"],
    ["commission", "Ozon佣金", Number(finance.commission || 0), "platform"], ["international", "国际运费", Number(finance.delivery || 0) || Number(profit.international_freight || 0), "platform"],
    ["advertising", "广告费", Number(ad.advertising || 0), "platform"], ["return", "退货及退款损失", Number(commerce.return_loss || 0) + Number(finance.return_delivery || 0), "platform"],
    ["platform_other", "平台其他费用", platformOther, "platform"], ["manual", "人工录入费用", Number(expenses.manual_expenses || 0), "manual"]
  ].map(([key, label, amount, source]) => ({ key, label, amount, source }));
  const missingCount = Number(expenses.missing_expense_vouchers || 0) + Number(vouchers.pending_vouchers || 0);
  return { company: companyRows[0] || null, month, shops, period: periodRows[0] || { status: "preparing" }, metrics: { revenue, order_revenue: orderRevenue, settlement_revenue: Number(finance.settlement_revenue || 0), revenue_variance: revenueVariance, revenue_variance_rate: orderRevenue ? revenueVariance / orderRevenue : 0, net_settlement_cashflow: Number(finance.net_settlement_cashflow || 0), purchase_cost: Number(profit.purchase_cost || 0), platform_fees: Number(finance.total_platform_fees || 0), advertising: Number(ad.advertising || 0), manual_expenses: Number(expenses.manual_expenses || 0), total_costs: totalCosts, operating_profit: operatingProfit, operating_margin: revenue ? operatingProfit / revenue : 0, voucher_amount: Number(vouchers.voucher_amount || 0), voucher_coverage: totalCosts > 0 ? Math.min(1, Number(vouchers.voucher_amount || 0) / totalCosts) : 0, cost_coverage: costCoverage, missing_cost_items: Number(profit.missing_cost_items || 0), effective_orders: Number(commerce.effective_orders || 0), cancelled_orders: Number(commerce.cancelled_orders || 0), return_orders: Number(commerce.return_orders || 0) }, rows, quality: { finance_rows: Number(finance.finance_rows || 0), last_finance_sync_at: finance.last_synced_at || null, unassigned_shops: shops.length ? 0 : 1, missing_vouchers: missingCount, missing_cost_items: Number(profit.missing_cost_items || 0), cost_coverage: costCoverage } };
}

export async function closeFinancePeriod(body = {}, personId = null, tenantId = "admin") {
  await ensureFinanceCenterSchema();
  const companyId = requiredId(body.company_id, "公司");
  const normalizedTenantId = await requireFinanceCompany(companyId, tenantId);
  const { month } = monthRange(body.month);
  const report = await financeMonthlyReport({ company_id: companyId, month }, tenantId);
  if (report.quality.unassigned_shops || report.quality.missing_vouchers > 0) {
    const error = new Error(`暂不能关账：仍有 ${report.quality.missing_vouchers} 项凭证待处理`);
    error.status = 409;
    throw error;
  }
  await mysqlExecute(`INSERT INTO finance_periods (tenant_id, company_id, month_key, status, close_note, closed_by, closed_at) VALUES (?, ?, ?, 'closed', ?, ?, NOW()) ON DUPLICATE KEY UPDATE status='closed', close_note=VALUES(close_note), closed_by=VALUES(closed_by), closed_at=NOW()`, [normalizedTenantId, companyId, month, body.close_note || null, personId || null]);
  return { ok: true, status: "closed" };
}

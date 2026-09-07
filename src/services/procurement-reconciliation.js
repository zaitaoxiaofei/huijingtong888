import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS procurement_payment_transactions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    external_no VARCHAR(160) NOT NULL,
    transaction_time DATETIME NULL,
    direction VARCHAR(32) NOT NULL DEFAULT 'expense',
    amount DECIMAL(18,4) NOT NULL DEFAULT 0,
    counterparty VARCHAR(255) NULL,
    item_description TEXT NULL,
    payment_method VARCHAR(255) NULL,
    transaction_status VARCHAR(64) NULL,
    merchant_order_no VARCHAR(180) NULL,
    raw_json JSON NULL,
    imported_by_person_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_procurement_payment_transaction (provider, external_no),
    KEY idx_procurement_payment_time_amount (transaction_time, amount),
    KEY idx_procurement_payment_counterparty (counterparty)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS procurement_payment_matches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    platform_order_id BIGINT UNSIGNED NOT NULL,
    payment_transaction_id BIGINT UNSIGNED NOT NULL,
    match_status VARCHAR(32) NOT NULL DEFAULT 'suggested',
    confidence INT NOT NULL DEFAULT 0,
    amount_difference DECIMAL(18,4) NOT NULL DEFAULT 0,
    time_difference_seconds BIGINT NULL,
    match_reason VARCHAR(255) NULL,
    confirmed_by_person_id BIGINT UNSIGNED NULL,
    confirmed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_procurement_payment_match_order (platform_order_id),
    KEY idx_procurement_payment_match_payment (payment_transaction_id),
    KEY idx_procurement_payment_match_status (match_status, confidence)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  schemaReady = true;
}

function first(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function utcTime(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 19).replace("T", " ");
  const text = String(value).trim();
  const match = text.match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const timestamp = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4] - 8, +match[5], +(match[6] || 0));
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

function normalizePayment(row, provider, index) {
  const time = utcTime(first(row, ["transaction_time", "交易时间"]));
  const rawAmount = String(first(row, ["amount", "金额", "金额(元)"])).replace(/[¥￥,]/g, "").trim();
  const amount = Math.abs(Number(rawAmount || 0));
  const directionText = String(first(row, ["direction", "收/支"]));
  const status = String(first(row, ["transaction_status", "交易状态", "当前状态"]));
  const externalNo = String(first(row, ["external_no", "交易订单号", "交易单号"]) || first(row, ["merchant_order_no", "商家订单号"]) || `${time || "unknown"}-${amount}-${index}`).trim();
  return {
    provider, externalNo, time, amount,
    direction: directionText.includes("收入") || directionText === "收入" ? "income" : directionText.includes("不计") ? "neutral" : "expense",
    counterparty: String(first(row, ["counterparty", "交易对方"])).trim(),
    item: String(first(row, ["item_description", "商品", "商品说明"])).trim(),
    paymentMethod: String(first(row, ["payment_method", "支付方式", "收/付款方式"])).trim(),
    status,
    merchantOrderNo: String(first(row, ["merchant_order_no", "商家订单号"])).trim(),
    raw: row
  };
}

export async function importProcurementPayments(body = {}, personId = null) {
  await ensureSchema();
  const provider = String(body.provider || "wechat").toLowerCase();
  const rows = (Array.isArray(body.rows) ? body.rows : []).map((row, index) => normalizePayment(row, provider, index)).filter((row) => row.externalNo && row.amount > 0);
  if (!rows.length) throw new Error("账单中没有识别到有效交易记录，请确认文件类型和表头");
  let inserted = 0;
  let updated = 0;
  await withMysqlTransaction(async (connection) => {
    for (const row of rows) {
      const [found] = await connection.query("SELECT id FROM procurement_payment_transactions WHERE provider=? AND external_no=? LIMIT 1", [provider, row.externalNo]);
      await connection.execute(`INSERT INTO procurement_payment_transactions
        (provider, external_no, transaction_time, direction, amount, counterparty, item_description, payment_method, transaction_status, merchant_order_no, raw_json, imported_by_person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE transaction_time=VALUES(transaction_time), direction=VALUES(direction), amount=VALUES(amount), counterparty=VALUES(counterparty),
          item_description=VALUES(item_description), payment_method=VALUES(payment_method), transaction_status=VALUES(transaction_status), merchant_order_no=VALUES(merchant_order_no),
          raw_json=VALUES(raw_json), imported_by_person_id=COALESCE(VALUES(imported_by_person_id), imported_by_person_id), updated_at=CURRENT_TIMESTAMP`,
      [provider, row.externalNo, row.time, row.direction, row.amount, row.counterparty || null, row.item || null, row.paymentMethod || null, row.status || null, row.merchantOrderNo || null, JSON.stringify(row.raw), Number(personId) || null]);
      if (found.length) updated += 1; else inserted += 1;
    }
  });
  return { ok: true, total: rows.length, inserted, updated };
}

export async function autoMatchProcurementPayments() {
  await ensureSchema();
  const orders = await mysqlQuery(`SELECT po.* FROM procurement_platform_orders po
    LEFT JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id
    WHERE pm.id IS NULL AND po.paid_amount>0 AND LOWER(COALESCE(po.platform_status,'')) NOT REGEXP '退款成功|交易关闭|已取消|closed|refund'
    ORDER BY po.order_time ASC`);
  let exact = 0;
  let suggested = 0;
  for (const order of orders) {
    const candidates = await mysqlQuery(`SELECT pt.*,
      ABS(pt.amount-?) AS amount_diff,
      ABS(TIMESTAMPDIFF(SECOND, pt.transaction_time, ?)) AS time_diff
      FROM procurement_payment_transactions pt
      LEFT JOIN procurement_payment_matches used ON used.payment_transaction_id=pt.id AND used.match_status='confirmed'
      WHERE pt.direction='expense' AND used.id IS NULL AND ABS(pt.amount-?)<=0.01
        AND pt.transaction_time BETWEEN DATE_SUB(?, INTERVAL 7 DAY) AND DATE_ADD(?, INTERVAL 7 DAY)
        AND (COALESCE(pt.transaction_status,'')='' OR pt.transaction_status NOT REGEXP '失败|关闭|退款')
      ORDER BY CASE WHEN ?='pdd' AND (pt.counterparty LIKE '%拼多多%' OR pt.item_description LIKE '%拼多多%') THEN 0 ELSE 1 END,
        time_diff ASC, pt.id ASC LIMIT 3`, [order.paid_amount, order.order_time, order.paid_amount, order.order_time, order.order_time, order.platform]);
    if (!candidates.length) continue;
    const best = candidates[0];
    const seconds = Number(best.time_diff || 0);
    const providerText = `${best.counterparty || ""}${best.item_description || ""}`;
    const branded = (order.platform === "pdd" && providerText.includes("拼多多")) || (order.platform === "1688" && providerText.includes("1688"));
    const confidence = Math.max(50, Math.min(100, (branded ? 20 : 0) + (seconds <= 3600 ? 80 : seconds <= 86400 ? 70 : 55)));
    const status = confidence >= 90 && seconds <= 3600 ? "confirmed" : "suggested";
    await mysqlExecute(`INSERT INTO procurement_payment_matches
      (platform_order_id,payment_transaction_id,match_status,confidence,amount_difference,time_difference_seconds,match_reason,confirmed_at)
      VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE payment_transaction_id=VALUES(payment_transaction_id),match_status=VALUES(match_status),confidence=VALUES(confidence),
      amount_difference=VALUES(amount_difference),time_difference_seconds=VALUES(time_difference_seconds),match_reason=VALUES(match_reason),confirmed_at=VALUES(confirmed_at),updated_at=CURRENT_TIMESTAMP`,
    [order.id, best.id, status, confidence, Number(best.amount_diff || 0), seconds, branded ? "金额一致、平台商户一致、付款时间最近" : "金额一致、付款时间最近", status === "confirmed" ? new Date() : null]);
    if (status === "confirmed") exact += 1; else suggested += 1;
  }
  return { ok: true, scanned: orders.length, confirmed: exact, suggested };
}

export async function procurementReconciliation(query = {}) {
  await ensureSchema();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 30)));
  const status = String(query.status || "all");
  const platform = String(query.platform || "all");
  const where = [];
  const params = [];
  if (platform !== "all") { where.push("po.platform=?"); params.push(platform); }
  if (status === "unmatched") where.push("pm.id IS NULL");
  else if (status !== "all") { where.push("pm.match_status=?"); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await mysqlQuery(`SELECT po.id,po.platform,po.platform_order_no,po.order_time,po.shop_name,po.product_name,po.quantity,po.paid_amount,po.platform_status,
    pm.id AS match_id,COALESCE(pm.match_status,'unmatched') AS match_status,pm.confidence,pm.amount_difference,pm.time_difference_seconds,pm.match_reason,
    pt.id AS payment_id,pt.provider,pt.transaction_time,pt.amount AS payment_amount,pt.counterparty,pt.item_description,pt.payment_method,pt.transaction_status,
    COUNT(pol.id) AS procurement_link_count,GROUP_CONCAT(DISTINCT COALESCE(pr.raw_name,p.name) SEPARATOR ' / ') AS procurement_names,
    COALESCE(SUM(pol.allocated_amount),0) AS allocated_amount
    FROM procurement_platform_orders po LEFT JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id
    LEFT JOIN procurement_payment_transactions pt ON pt.id=pm.payment_transaction_id
    LEFT JOIN procurement_platform_order_links pol ON pol.platform_order_id=po.id
    LEFT JOIN procurement_requests pr ON pr.id=pol.procurement_request_id LEFT JOIN products p ON p.id=pr.product_id
    ${whereSql} GROUP BY po.id ORDER BY po.order_time DESC,po.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const count = await mysqlQuery(`SELECT COUNT(*) total FROM procurement_platform_orders po LEFT JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id ${whereSql}`, params);
  const summaryRows = await mysqlQuery(`SELECT
    COUNT(*) order_count,
    SUM(CASE WHEN LOWER(COALESCE(platform_status,'')) REGEXP '退款成功|交易关闭|已取消|closed|refund' THEN 0 ELSE 1 END) effective_order_count,
    SUM(CASE WHEN LOWER(COALESCE(platform_status,'')) REGEXP '退款成功|交易关闭|已取消|closed|refund' THEN 0 ELSE paid_amount END) platform_payable,
    SUM(CASE WHEN pm.match_status='confirmed' THEN pt.amount ELSE 0 END) confirmed_payment,
    SUM(CASE WHEN pm.match_status='suggested' THEN 1 ELSE 0 END) suggested_count,
    SUM(CASE WHEN pm.id IS NULL THEN 1 ELSE 0 END) unmatched_count
    FROM procurement_platform_orders po LEFT JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id LEFT JOIN procurement_payment_transactions pt ON pt.id=pm.payment_transaction_id`);
  const platformSummary = await mysqlQuery(`SELECT platform,
    SUM(CASE WHEN LOWER(COALESCE(platform_status,'')) REGEXP '退款成功|交易关闭|已取消|closed|refund' THEN 0 ELSE 1 END) effective_order_count,
    SUM(CASE WHEN LOWER(COALESCE(platform_status,'')) REGEXP '退款成功|交易关闭|已取消|closed|refund' THEN 0 ELSE paid_amount END) platform_payable,
    SUM(CASE WHEN pm.match_status='confirmed' THEN pt.amount ELSE 0 END) confirmed_payment
    FROM procurement_platform_orders po LEFT JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id
    LEFT JOIN procurement_payment_transactions pt ON pt.id=pm.payment_transaction_id GROUP BY platform ORDER BY platform`);
  return { rows, total: Number(count[0]?.total || 0), summary: summaryRows[0] || {}, platform_summary: platformSummary, page, pageSize };
}

export async function procurementPaymentCandidates(orderId) {
  await ensureSchema();
  const orders = await mysqlQuery("SELECT * FROM procurement_platform_orders WHERE id=? LIMIT 1", [Number(orderId)]);
  if (!orders.length) throw new Error("平台订单不存在");
  const order = orders[0];
  return mysqlQuery(`SELECT pt.*,ABS(pt.amount-?) amount_difference,ABS(TIMESTAMPDIFF(SECOND,pt.transaction_time,?)) time_difference_seconds
    FROM procurement_payment_transactions pt WHERE pt.direction='expense'
      AND pt.transaction_time BETWEEN DATE_SUB(?,INTERVAL 15 DAY) AND DATE_ADD(?,INTERVAL 15 DAY)
    ORDER BY ABS(pt.amount-?) ASC,time_difference_seconds ASC LIMIT 50`, [order.paid_amount, order.order_time, order.order_time, order.order_time, order.paid_amount]);
}

export async function setProcurementPaymentMatch(orderId, body = {}, personId = null) {
  await ensureSchema();
  const paymentId = Number(body.payment_transaction_id || 0);
  if (!paymentId) throw new Error("请选择一条微信或支付宝支付流水");
  const rows = await mysqlQuery(`SELECT po.paid_amount,po.order_time,pt.amount,pt.transaction_time FROM procurement_platform_orders po
    JOIN procurement_payment_transactions pt ON pt.id=? WHERE po.id=? LIMIT 1`, [paymentId, Number(orderId)]);
  if (!rows.length) throw new Error("平台订单或支付流水不存在");
  const row = rows[0];
  const amountDifference = Math.abs(Number(row.paid_amount || 0) - Number(row.amount || 0));
  const seconds = Math.abs((new Date(row.order_time).getTime() - new Date(row.transaction_time).getTime()) / 1000);
  await mysqlExecute(`INSERT INTO procurement_payment_matches
    (platform_order_id,payment_transaction_id,match_status,confidence,amount_difference,time_difference_seconds,match_reason,confirmed_by_person_id,confirmed_at)
    VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE payment_transaction_id=VALUES(payment_transaction_id),match_status='confirmed',confidence=VALUES(confidence),
      amount_difference=VALUES(amount_difference),time_difference_seconds=VALUES(time_difference_seconds),match_reason='人工选择支付流水',confirmed_by_person_id=VALUES(confirmed_by_person_id),confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,
  [Number(orderId), paymentId, "confirmed", amountDifference < 0.01 ? 100 : 80, amountDifference, seconds, "人工选择支付流水", Number(personId) || null]);
  return { ok: true };
}

export async function confirmProcurementPaymentMatch(id, body = {}, personId = null) {
  await ensureSchema();
  const matchId = Number(id);
  const status = body.confirmed === false ? "rejected" : "confirmed";
  await mysqlExecute("UPDATE procurement_payment_matches SET match_status=?,confirmed_by_person_id=?,confirmed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [status, Number(personId) || null, status === "confirmed" ? new Date() : null, matchId]);
  return { ok: true, status };
}

export async function applyProcurementActualCosts(body = {}) {
  await ensureSchema();
  const orderIds = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  const where = orderIds.length ? `AND po.id IN (${orderIds.map(() => "?").join(",")})` : "";
  const links = await mysqlQuery(`SELECT pol.id,pol.procurement_request_id,pol.allocated_amount,pol.allocated_quantity,po.paid_amount,
    SUM(pol.allocated_amount) OVER(PARTITION BY po.id) allocated_total,COUNT(*) OVER(PARTITION BY po.id) link_count
    FROM procurement_platform_order_links pol JOIN procurement_platform_orders po ON po.id=pol.platform_order_id
    JOIN procurement_payment_matches pm ON pm.platform_order_id=po.id AND pm.match_status='confirmed' WHERE 1=1 ${where}`, orderIds);
  let updated = 0;
  await withMysqlTransaction(async (connection) => {
    for (const link of links) {
      const total = Number(link.allocated_total || 0);
      const amount = total > 0 ? Number(link.allocated_amount || 0) : Number(link.paid_amount || 0) / Math.max(1, Number(link.link_count || 1));
      const quantity = Math.max(1, Number(link.allocated_quantity || 0));
      await connection.execute("UPDATE procurement_requests SET amount=?,shipping_amount=0,note=CONCAT_WS('；',NULLIF(note,''),'实际成本已由平台订单及支付账单核对'),updated_at=CURRENT_TIMESTAMP WHERE id=?", [amount, link.procurement_request_id]);
      await connection.execute(`UPDATE products p JOIN procurement_requests pr ON pr.product_id=p.id SET p.purchase_cost=? WHERE pr.id=? AND pr.product_id IS NOT NULL`, [amount / quantity, link.procurement_request_id]);
      updated += 1;
    }
  });
  return { ok: true, updated };
}

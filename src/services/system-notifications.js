import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { getRoles } from "../shared/permissions.js";
import { broadcastGlobalEvent } from "../server/notifications.js";

const PAGE_SIZE_MAX = 100;

function personId(session = {}) {
  return Number(session.personId || session.id || 0) || 0;
}

function beijingDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

async function activePeopleForRoles(roles = []) {
  if (!roles.length) return [];
  const placeholders = roles.map(() => "?").join(",");
  return await mysqlQuery(`
    SELECT DISTINCT id
    FROM people
    WHERE active = 1
      AND (
        role IN (${placeholders})
        OR JSON_OVERLAPS(COALESCE(roles_json, JSON_ARRAY()), JSON_ARRAY(${placeholders}))
      )
  `, [...roles, ...roles]);
}

export async function createSystemNotification(input = {}) {
  const recipientIds = [...new Set((input.recipientPersonIds || []).map(Number).filter(Boolean))];
  if (!recipientIds.length) return { created: 0 };
  let created = 0;
  for (const recipientId of recipientIds) {
    const dedupeKey = `${String(input.dedupeKey || "manual").trim()}:${recipientId}`;
    const result = await mysqlExecute(`
      INSERT IGNORE INTO system_notifications
        (recipient_person_id, notification_type, title, content, severity, route,
         entity_type, entity_id, dedupe_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', CURRENT_TIMESTAMP)
    `, [
      recipientId,
      String(input.type || "system").trim(),
      String(input.title || "系统通知").trim(),
      String(input.content || "").trim(),
      String(input.severity || "info").trim(),
      String(input.route || "").trim(),
      String(input.entityType || "").trim(),
      input.entityId ? String(input.entityId) : null,
      dedupeKey
    ]);
    if (Number(result?.affectedRows || 0) > 0) {
      created += 1;
      broadcastGlobalEvent("system-notification", { refresh: true }, { personId: recipientId });
    }
  }
  return { created };
}

export async function listSystemNotifications(query = {}, session = {}) {
  const recipientId = personId(session);
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(query.pageSize || query.page_size || 30)));
  const status = String(query.status || "all").trim();
  const params = [recipientId];
  const where = ["recipient_person_id = ?"];
  if (["unread", "read", "resolved"].includes(status)) {
    where.push("status = ?");
    params.push(status);
  }
  const whereSql = where.join(" AND ");
  const [rows, totals] = await Promise.all([
    mysqlQuery(`
      SELECT id, notification_type, title, content, severity, route, entity_type, entity_id,
        status, created_at, read_at, resolved_at
      FROM system_notifications
      WHERE ${whereSql}
      ORDER BY CASE status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]),
    mysqlQuery(`
      SELECT COUNT(*) total, SUM(status = 'unread') unread
      FROM system_notifications
      WHERE recipient_person_id = ?
    `, [recipientId])
  ]);
  return {
    rows,
    page,
    pageSize,
    total: Number(totals[0]?.total || 0),
    unread: Number(totals[0]?.unread || 0)
  };
}

export async function markSystemNotificationRead(notificationId, session = {}) {
  const recipientId = personId(session);
  const id = Number(notificationId || 0);
  if (!id) throw new Error("缺少通知 ID");
  await mysqlExecute(`
    UPDATE system_notifications
    SET status = IF(status = 'resolved', status, 'read'), read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND recipient_person_id = ?
  `, [id, recipientId]);
  return { ok: true };
}

export async function markAllSystemNotificationsRead(session = {}) {
  const recipientId = personId(session);
  await mysqlExecute(`
    UPDATE system_notifications
    SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_person_id = ? AND status = 'unread'
  `, [recipientId]);
  return { ok: true };
}

export async function resolveSystemNotification(notificationId, session = {}) {
  const recipientId = personId(session);
  const id = Number(notificationId || 0);
  if (!id) throw new Error("缺少通知 ID");
  await mysqlExecute(`
    UPDATE system_notifications
    SET status = 'resolved', read_at = COALESCE(read_at, CURRENT_TIMESTAMP), resolved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND recipient_person_id = ?
  `, [id, recipientId]);
  return { ok: true };
}

async function generateDailyProcurementNotifications(dateKey) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM procurement_requests
    WHERE status IN ('pending', 'suggested', 'submitted', 'merged')
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["procurement", "admin", "manager"]);
  const result = await createSystemNotification({
    recipientPersonIds: recipients.map((row) => row.id),
    type: "daily_procurement",
    title: "今日采购任务待处理",
    content: `当前有 ${Number(summary.product_count)} 种商品待采购，共 ${Number(summary.quantity)} 件。`,
    severity: "warning",
    route: "/procurement/workspace",
    entityType: "procurement",
    dedupeKey: `daily-procurement:${dateKey}`
  });
  return result.created;
}

async function generateInboundNotifications(dateKey) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM inbound_records
    WHERE status = 'pending_arrival'
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["packing", "procurement", "admin", "manager"]);
  const result = await createSystemNotification({
    recipientPersonIds: recipients.map((row) => row.id),
    type: "pending_inbound",
    title: "采购商品等待收货入库",
    content: `当前有 ${Number(summary.product_count)} 种商品待入库，共 ${Number(summary.quantity)} 件。`,
    severity: "info",
    route: "/purchase-list",
    entityType: "inbound",
    dedupeKey: `pending-inbound:${dateKey}`
  });
  return result.created;
}

async function generateFbpShortageNotifications(dateKey) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM procurement_requests
    WHERE request_group_no LIKE 'AUTO-STOCK-%'
      AND status IN ('pending', 'suggested', 'submitted')
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["packing", "procurement", "admin", "manager"]);
  const result = await createSystemNotification({
    recipientPersonIds: recipients.map((row) => row.id),
    type: "fbp_shortage",
    title: "FBP 与本地库存不足",
    content: `发现 ${Number(summary.product_count)} 种商品库存不足，建议补充 ${Number(summary.quantity)} 件。`,
    severity: "danger",
    route: "/inventory/fbp-opportunities",
    entityType: "fbp_inventory",
    dedupeKey: `fbp-shortage:${dateKey}`
  });
  return result.created;
}

export async function generateOperationalNotifications() {
  const dateKey = beijingDateKey();
  const counts = await Promise.all([
    generateDailyProcurementNotifications(dateKey),
    generateInboundNotifications(dateKey),
    generateFbpShortageNotifications(dateKey)
  ]);
  return { ok: true, created: counts.reduce((sum, count) => sum + count, 0), date: dateKey };
}

export function canReceiveOperationalNotification(session = {}) {
  return getRoles(session).length > 0 && personId(session) > 0;
}

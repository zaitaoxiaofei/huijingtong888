import {PROCUREMENT_TRANSIT_WARNING_HOURS,PROCUREMENT_REQUEST_WARNING_HOURS} from '../shared/inventory-procurement-stage.js';
import { resolveInventoryTenantScope, inventoryTenantSql } from './inventory-tenant-scope.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { effectiveTenantMembershipRole } from './tenant-membership-authority.js';
async function notificationScope(session) {
  const fresh = await authorizeBusinessTaskSession(session);
  return resolveInventoryTenantScope(fresh.tenant.id);
}
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

async function activePeopleForRoles(roles = [], scope) {
  const rows = await mysqlQuery(`SELECT p.id,p.role,p.roles_json,tm.role AS tenant_role,tm.business_roles_json,t.slug AS tenant_slug
    FROM people p JOIN tenant_members tm ON tm.person_id=p.id AND tm.active=1
    JOIN tenants t ON t.id=tm.tenant_id
    WHERE tm.tenant_id=? AND p.active=1`,[scope.id]);
  return rows.filter(row => ['owner','admin'].includes(effectiveTenantMembershipRole({ ...row, legacy_role: row.role }))
    || getRoles({roles:row.business_roles_json ?? row.roles_json ?? row.role}).some(role=>roles.includes(role)));
}

export async function createSystemNotification(input = {}) {
  const scope = await resolveInventoryTenantScope(input.tenantId);
  const recipientIds = [...new Set((input.recipientPersonIds || []).map(Number).filter(Boolean))];
  if (!recipientIds.length) return { created: 0 };
  let created = 0;
  for (const recipientId of recipientIds) {
    const member = await mysqlQuery("SELECT 1 FROM tenant_members tm JOIN people p ON p.id=tm.person_id AND p.active=1 WHERE tm.tenant_id=? AND tm.person_id=? AND tm.active=1",[scope.id,recipientId]);
    if (!member.length) continue;
    const dedupeKey = `${scope.id}:${String(input.dedupeKey || "manual").trim()}:${recipientId}`;
    const result = await mysqlExecute(`
      INSERT IGNORE INTO system_notifications
        (tenant_id, recipient_person_id, notification_type, title, content, severity, route,
         entity_type, entity_id, dedupe_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', CURRENT_TIMESTAMP)
    `, [
      scope.id, recipientId,
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
      broadcastGlobalEvent("system-notification", { refresh: true }, { personId: recipientId, tenantId: scope.id });
    }
  }
  return { created };
}

export async function listSystemNotifications(query = {}, session = {}) {
  const scope = await notificationScope(session);
  const recipientId = personId(session);
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(query.pageSize || query.page_size || 30)));
  const status = String(query.status || "all").trim();
  const params = [recipientId];
  const where = ["recipient_person_id = ?", inventoryTenantSql(scope, "sn")];
  if (["unread", "read", "resolved"].includes(status)) {
    where.push("status = ?");
    params.push(status);
  }
  const whereSql = where.join(" AND ");
  const [rows, totals] = await Promise.all([
    mysqlQuery(`
      SELECT id, notification_type, title, content, severity, route, entity_type, entity_id,
        status, created_at, read_at, resolved_at
      FROM system_notifications sn
      WHERE ${whereSql}
      ORDER BY CASE status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]),
    mysqlQuery(`
      SELECT COUNT(*) total, SUM(status = 'unread') unread
      FROM system_notifications sn
      WHERE recipient_person_id = ? AND ${inventoryTenantSql(scope, "sn")}
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
  const scope = await notificationScope(session);
  const recipientId = personId(session);
  const id = Number(notificationId || 0);
  if (!id) throw new Error("缺少通知 ID");
  await mysqlExecute(`
    UPDATE system_notifications sn
    SET status = IF(status = 'resolved', status, 'read'), read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND recipient_person_id = ? AND ${inventoryTenantSql(scope, "sn")}
  `, [id, recipientId]);
  return { ok: true };
}

export async function markAllSystemNotificationsRead(session = {}) {
  const scope = await notificationScope(session);
  const recipientId = personId(session);
  await mysqlExecute(`
    UPDATE system_notifications sn
    SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_person_id = ? AND ${inventoryTenantSql(scope, "sn")} AND status = 'unread'
  `, [recipientId]);
  return { ok: true };
}

export async function resolveSystemNotification(notificationId, session = {}) {
  const scope = await notificationScope(session);
  const recipientId = personId(session);
  const id = Number(notificationId || 0);
  if (!id) throw new Error("缺少通知 ID");
  await mysqlExecute(`
    UPDATE system_notifications sn
    SET status = 'resolved', read_at = COALESCE(read_at, CURRENT_TIMESTAMP), resolved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND recipient_person_id = ? AND ${inventoryTenantSql(scope, "sn")}
  `, [id, recipientId]);
  return { ok: true };
}

async function generateDailyProcurementNotifications(dateKey, scope) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM procurement_requests notification_source
    WHERE ${inventoryTenantSql(scope, 'notification_source')} AND status IN ('pending', 'suggested', 'submitted', 'merged')
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["procurement", "admin", "manager"], scope);
  const result = await createSystemNotification({
    tenantId: scope.id,
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

async function generateInboundNotifications(dateKey, scope) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM inbound_records notification_source
    WHERE ${inventoryTenantSql(scope, 'notification_source')} AND status = 'pending_arrival'
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["packing", "procurement", "admin", "manager"], scope);
  const result = await createSystemNotification({
    tenantId: scope.id,
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

async function generateFbpShortageNotifications(dateKey, scope) {
  const [summary] = await mysqlQuery(`
    SELECT COUNT(DISTINCT product_id) product_count, COALESCE(SUM(quantity), 0) quantity
    FROM procurement_requests notification_source
    WHERE ${inventoryTenantSql(scope, 'notification_source')} AND request_group_no LIKE 'AUTO-STOCK-%'
      AND status IN ('pending', 'suggested', 'submitted')
  `);
  if (!Number(summary?.product_count || 0)) return 0;
  const recipients = await activePeopleForRoles(["packing", "procurement", "admin", "manager"], scope);
  const result = await createSystemNotification({
    tenantId: scope.id,
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

async function generateProcurementTimeoutNotifications(dateKey,scope) {
  const [requests,transit]=await Promise.all([
    mysqlQuery(`SELECT COUNT(*) AS count FROM procurement_requests pr JOIN products p ON p.id=pr.product_id AND ${inventoryTenantSql(scope,'p')}
      WHERE ${inventoryTenantSql(scope,'pr')} AND pr.status IN ('submitted','pending','suggested')
      AND pr.created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ${PROCUREMENT_REQUEST_WARNING_HOURS} HOUR)`),
    mysqlQuery(`SELECT COUNT(*) AS count FROM inbound_records ir JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
      JOIN products p ON p.id=ir.product_id AND ${inventoryTenantSql(scope,'p')}
      WHERE ${inventoryTenantSql(scope,'ir')} AND ir.status='pending_arrival' AND ir.received_at IS NULL
      AND po.status NOT IN ('pending_purchase','cancelled') AND po.purchased_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ${PROCUREMENT_TRANSIT_WARNING_HOURS} HOUR)`)
  ]);
  const pending=Number(requests[0]?.count||0),late=Number(transit[0]?.count||0);
  if(!pending&&!late)return 0;
  const recipients=await activePeopleForRoles(['procurement'],scope);
  const result=await createSystemNotification({tenantId:scope.id,recipientPersonIds:recipients.map(r=>r.id),
    type:'procurement_timeout',title:'采购跟进超时提醒',content:`${pending}条申请超过24小时未处理，${late}批采购超过2天未确认到货；请核查采购在途，已到货请标记并交仓库验收。`,
    severity:'warning',route:'/purchase-list',entityType:'procurement',dedupeKey:`procurement-timeout:${dateKey}`});
  return result.created;
}

export async function generateOperationalNotifications(tenantId = "admin") {
  const scope = await resolveInventoryTenantScope(tenantId);
  const dateKey = beijingDateKey();
  const counts = await Promise.all([
    generateDailyProcurementNotifications(dateKey, scope),
    generateInboundNotifications(dateKey, scope),
    generateFbpShortageNotifications(dateKey, scope),
    generateProcurementTimeoutNotifications(dateKey, scope)
  ]);
  return { ok: true, created: counts.reduce((sum, count) => sum + count, 0), date: dateKey };
}

export function canReceiveOperationalNotification(session = {}) {
  return getRoles(session).length > 0 && personId(session) > 0;
}

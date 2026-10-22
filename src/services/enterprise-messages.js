import { getRoles } from "../shared/permissions.js";
import { effectiveTenantMembershipRole } from "./tenant-membership-authority.js";
import { authorizeApiRequest } from "../server/authorization.js";
import { tenantIsolationDecision } from "../server/tenant-isolation.js";

export const ENTERPRISE_MESSAGES_SCHEMA_SQL = [`CREATE TABLE IF NOT EXISTS enterprise_direct_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NOT NULL,
  client_message_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  text TEXT NOT NULL,
  reference_type VARCHAR(20) NULL,
  reference_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  read_at DATETIME(3) NULL,
  UNIQUE KEY uk_enterprise_message_retry (tenant_id, sender_id, client_message_id),
  KEY idx_enterprise_message_inbox (tenant_id, recipient_id, read_at, id),
  KEY idx_enterprise_message_sent (tenant_id, sender_id, recipient_id, id),
  KEY idx_enterprise_message_received (tenant_id, recipient_id, sender_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`];

function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function id(value, label = "人员") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} ID 无效`);
  return number;
}
function limit(value, maximum = 50) { return Math.min(maximum, Math.max(1, Math.floor(Number(value) || maximum))); }
function person(row) { return { id: Number(row.id), name: row.name, username: row.username, avatar_url: row.avatar_url || "" }; }
function timestamp(value) { return value == null ? null : new Date(value).toISOString(); }
function referenceInput(value) {
  if (value == null) return null;
  if (!["order", "procurement"].includes(value.type)) fail("引用类型仅支持订单或采购需求");
  return { type: value.type, id: id(value.id, "引用记录") };
}

// Database transport is injected so tests can exercise the real SQL against an
// isolated database without importing production configuration or running DDL.
export function createEnterpriseMessagesService({ transaction }) {
  async function within(session, peerValue, action, write = false) {
    if (!session?.tenant?.id || !(session.personId ?? session.person_id ?? session.id)) fail("请先登录并选择有效企业", 403);
    const tenantId = id(session?.tenant?.id, "当前企业");
    const actorId = id(session?.personId ?? session?.person_id ?? session?.id);
    const peerId = peerValue === null ? null : id(peerValue);
    if (peerId === actorId) fail("请选择本企业的其他人员");
    return transaction(async connection => {
      const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
      const [tenant] = await query("SELECT id, slug, status, subscription_status, subscription_expires_at FROM tenants WHERE id = ? FOR SHARE", [tenantId]);
      if (!tenant || tenant.status !== "active" || !["trial", "active"].includes(tenant.subscription_status)
        || (tenant.subscription_expires_at && new Date(tenant.subscription_expires_at).getTime() <= Date.now())) fail("当前企业已停用或授权已到期", 403);
      const ids = [...new Set([actorId, peerId].filter(Boolean))].sort((a, b) => a - b);
      const members = [];
      // Acquire participant locks in the same person-ID order for both sides.
      // A sender takes exclusive locks immediately, never upgrades shared locks.
      // This also orders message commits before a reader can advance its cursor.
      for (const personId of ids) {
        const [member] = await query(`SELECT p.id, p.name, p.username, p.avatar_url, p.role AS legacy_role, p.roles_json,
          tm.role AS tenant_role, tm.business_roles_json
        FROM people p JOIN tenant_members tm ON tm.person_id = p.id AND tm.tenant_id = ? AND tm.active = 1
        WHERE p.active = 1 AND p.account_kind = 'person' AND p.id = ? ${write ? "FOR UPDATE" : "FOR SHARE"}`, [tenantId, personId]);
        if (!member) fail("仅当前企业启用的成员可以互发和查看私信", 403);
        members.push(member);
      }
      const current = members.find(row => Number(row.id) === actorId);
      const actor = { ...session, personId: actorId, roles: getRoles({ roles: current.business_roles_json ?? current.roles_json ?? current.legacy_role }),
        tenant: { ...tenant, role: effectiveTenantMembershipRole({ ...current, tenant_slug: tenant.slug }) } };
      return action({ query, tenantId, actorId, peerId, actor });
    }).catch(error => {
      if (error.code === "ER_BAD_FIELD_ERROR" && String(error.sqlMessage || error.message).includes("account_kind")) fail("企业私信的账号类型字段尚未迁移，请联系平台维护人员执行私信数据库迁移", 503);
      if (error.code === "ER_NO_SUCH_TABLE" && String(error.sql || "").includes("enterprise_direct_messages")) fail("企业私信尚未完成数据库迁移，请联系平台维护人员", 503);
      throw error;
    });
  }

  function mayReference(actor, type) {
    const parts = type === "order" ? ["api", "orders", "1"] : ["api", "procurement", "requests"];
    return authorizeApiRequest({ _session: actor, method: "GET" }, parts).allowed && tenantIsolationDecision(actor, parts, "GET").allowed;
  }
  async function findReferences(context, type, ids, q = "", count = 20, detail = false) {
    if (!mayReference(context.actor, type)) return [];
    const defaultTenant = context.actor.tenant.slug === "default";
    let from, scope, labelColumn;
    if (type === "order") {
      from = "orders r JOIN shops s ON s.id = r.shop_id";
      scope = `(s.tenant_id = ?${defaultTenant ? " OR s.tenant_id IS NULL" : ""})`;
      labelColumn = "r.posting_number";
    } else {
      const columns = await context.query("SHOW COLUMNS FROM procurement_requests LIKE 'tenant_id'");
      from = "procurement_requests r LEFT JOIN orders source_order ON source_order.id = r.source_order_id LEFT JOIN shops s ON s.id = source_order.shop_id";
      const sourceScope = `(r.source_order_id IS NULL OR (s.id IS NOT NULL AND (s.tenant_id = ${context.tenantId}${defaultTenant ? " OR s.tenant_id IS NULL" : ""})))`;
      scope = columns.length ? `(r.tenant_id = ?${defaultTenant ? " OR r.tenant_id IS NULL" : ""}) AND ${sourceScope}` : defaultTenant ? `(? > 0 AND ${sourceScope})` : "(? < 0)";
      labelColumn = "CAST(r.id AS CHAR)";
      if (detail) from += ` LEFT JOIN products p ON p.id = r.product_id AND (p.tenant_id = ${context.tenantId}${defaultTenant ? " OR p.tenant_id IS NULL" : ""})`;
    }
    const params = [context.tenantId];
    let filter = "";
    if (ids) { filter = ` AND r.id IN (${ids.map(() => "?").join(",")})`; params.push(...ids); }
    else { filter = ` AND (${labelColumn} LIKE ? OR r.id = ?)`; params.push(`%${q}%`, Number.isSafeInteger(Number(q)) ? Number(q) : 0); }
    const detailFields = detail && type === "procurement" ? ", COALESCE(p.name, r.raw_name, '') AS product_name, r.quantity, r.status, r.note, r.created_at, source_order.posting_number AS source_posting_number" : "";
    const rows = await context.query(`SELECT r.id, ${labelColumn} AS reference_label${detailFields} FROM ${from} WHERE ${scope}${filter} ORDER BY r.id DESC LIMIT ${count} FOR SHARE`, params);
    return rows.map(row => ({ type, id: Number(row.id), label: type === "order" ? `订单 ${row.reference_label}` : `采购需求 #${row.id}`,
      route: type === "order" ? `/orders?orderId=${row.id}` : `/procurement/workspace?message_request_id=${row.id}`, available: true,
      ...(detail ? { record: type === "procurement" ? { id: Number(row.id), product_name: row.product_name, quantity: Number(row.quantity), status: row.status, note: row.note || "", created_at: timestamp(row.created_at), source_posting_number: row.source_posting_number || "" } : null } : {}) }));
  }
  async function messages(context, rows) {
    const refs = new Map();
    for (const type of ["order", "procurement"]) {
      const ids = [...new Set(rows.filter(row => row.reference_type === type).map(row => Number(row.reference_id)))];
      if (ids.length) for (const ref of await findReferences(context, type, ids, "", ids.length)) refs.set(`${type}:${ref.id}`, ref);
    }
    return rows.map(row => ({ id: Number(row.id), sender_id: Number(row.sender_id), recipient_id: Number(row.recipient_id), text: row.text,
      client_message_id: row.client_message_id, created_at: timestamp(row.created_at), read_at: timestamp(row.read_at),
      reference: row.reference_type ? refs.get(`${row.reference_type}:${row.reference_id}`) || { type: row.reference_type, id: Number(row.reference_id), label: "记录暂不可访问", route: "", available: false } : null }));
  }
  async function unreadCount({ query, tenantId, actorId }) {
    const [row] = await query(`SELECT COUNT(*) AS unread_count FROM enterprise_direct_messages m
      JOIN tenant_members tm ON tm.tenant_id = m.tenant_id AND tm.person_id = m.sender_id AND tm.active = 1
      JOIN people p ON p.id = m.sender_id AND p.active = 1 AND p.account_kind = 'person' WHERE m.tenant_id = ? AND m.recipient_id = ? AND m.read_at IS NULL`, [tenantId, actorId]);
    return Number(row.unread_count);
  }
  return {
    contacts: session => within(session, null, async c => ({ rows: (await c.query(`SELECT p.id, p.name, p.username, p.avatar_url
      FROM tenant_members tm JOIN people p ON p.id = tm.person_id AND p.active = 1 AND p.account_kind = 'person'
      WHERE tm.tenant_id = ? AND tm.active = 1 AND p.id <> ? ORDER BY p.name, p.id`, [c.tenantId, c.actorId])).map(person) })),
    unread: session => within(session, null, async c => ({ unread_count: await unreadCount(c) })),
    conversations: session => within(session, null, async c => {
      const rows = await c.query(`SELECT p.id AS peer_id, p.name, p.username, p.avatar_url, grouped.unread_count, m.*
        FROM (SELECT IF(sender_id = ?, recipient_id, sender_id) AS peer_id, MAX(id) AS last_id,
          SUM(recipient_id = ? AND read_at IS NULL) AS unread_count FROM enterprise_direct_messages
          WHERE tenant_id = ? AND (sender_id = ? OR recipient_id = ?) GROUP BY peer_id) grouped
        JOIN enterprise_direct_messages m ON m.id = grouped.last_id AND m.tenant_id = ?
        JOIN tenant_members tm ON tm.person_id = grouped.peer_id AND tm.tenant_id = ? AND tm.active = 1
        JOIN people p ON p.id = grouped.peer_id AND p.active = 1 AND p.account_kind = 'person' ORDER BY m.id DESC`, [c.actorId, c.actorId, c.tenantId, c.actorId, c.actorId, c.tenantId, c.tenantId]);
      const formatted = await messages(c, rows);
      return { rows: rows.map((row, index) => ({ peer: person({ ...row, id: row.peer_id }), last_message: formatted[index], unread_count: Number(row.unread_count) })) };
    }),
    thread: (session, input = {}) => within(session, input.peer_id, async c => {
      if (input.before_id && input.after_id) fail("消息游标不能同时指定前后方向");
      const count = limit(input.limit);
      const cursor = input.before_id || input.after_id;
      const rows = await c.query(`SELECT * FROM enterprise_direct_messages WHERE tenant_id = ?
        AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ${cursor ? `AND id ${input.after_id ? ">" : "<"} ?` : ""} ORDER BY id ${input.after_id ? "ASC" : "DESC"} LIMIT ${count + 1}`,
      [c.tenantId, c.actorId, c.peerId, c.peerId, c.actorId, ...(cursor ? [id(cursor, "消息游标")] : [])]);
      const selected = rows.slice(0, count);
      if (!input.after_id) selected.reverse();
      return { rows: await messages(c, selected), has_more: rows.length > count, next_before_id: Number(selected[0]?.id || 0), next_after_id: Number(selected.at(-1)?.id || 0) };
    }),
    send: (session, input = {}) => within(session, input.peer_id, async c => {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text || text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail("私信请输入 1 至 4000 字的纯文本");
      const clientId = String(input.client_message_id || "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(clientId)) fail("缺少有效的消息重试标识，请保留草稿后重试");
      const reference = referenceInput(input.reference);
      const previous = async (locking = false) => (await c.query(`SELECT * FROM enterprise_direct_messages WHERE tenant_id = ? AND sender_id = ? AND client_message_id = ?${locking ? " FOR SHARE" : ""}`, [c.tenantId, c.actorId, clientId]))[0];
      const response = async (row, duplicate) => {
        if (Number(row.recipient_id) !== c.peerId || row.text !== text || (row.reference_type || null) !== (reference?.type || null) || Number(row.reference_id || 0) !== Number(reference?.id || 0)) fail("消息重试标识已用于其他内容，请使用新的标识", 409);
        return { message: (await messages(c, [row]))[0], duplicate };
      };
      const old = await previous();
      if (old) return response(old, true);
      if (reference && !(await findReferences(c, reference.type, [reference.id])).length) fail("引用记录不存在、属于其他企业或当前账号无权查看", 403);
      let result;
      try {
        result = await c.query(`INSERT INTO enterprise_direct_messages (tenant_id, sender_id, recipient_id, client_message_id, text, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`, [c.tenantId, c.actorId, c.peerId, clientId, text, reference?.type || null, reference?.id || null]);
      } catch (error) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        return response(await previous(true), true);
      }
      const [row] = await c.query("SELECT * FROM enterprise_direct_messages WHERE tenant_id = ? AND id = ?", [c.tenantId, result.insertId]);
      return response(row, false);
    }, true),
    read: (session, input = {}) => within(session, input.peer_id, async c => {
      if (!Array.isArray(input.message_ids) || input.message_ids.length > 100) fail("仅可标记当前已显示的消息，每批最多 100 条");
      const ids = [...new Set(input.message_ids.map(value => id(value, "消息")))];
      const result = ids.length ? await c.query(`UPDATE enterprise_direct_messages SET read_at = UTC_TIMESTAMP(3)
        WHERE tenant_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`, [c.tenantId, c.peerId, c.actorId, ...ids]) : { affectedRows: 0 };
      return { ok: true, updated_count: result.affectedRows, unread_count: await unreadCount(c) };
    }),
    references: (session, input = {}) => within(session, null, async c => {
      const type = referenceInput({ type: input.type, id: 1 }).type;
      if (!mayReference(c.actor, type)) fail("当前账号无权引用此类业务记录", 403);
      const q = String(input.q || "").trim();
      if (!q || q.length > 100) fail("请输入 1 至 100 字的记录检索关键词");
      return { rows: await findReferences(c, type, null, q, limit(input.limit, 20)) };
    }),
    reference: (session, input = {}) => within(session, null, async c => {
      const ref = referenceInput(input);
      const [row] = await findReferences(c, ref.type, [ref.id], "", 1, true);
      if (!row) fail("引用记录不存在、属于其他企业或当前账号无权查看", 403);
      const { record, ...reference } = row;
      return { reference, record };
    })
  };
}

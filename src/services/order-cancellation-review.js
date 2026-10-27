import { isPlatformAdmin } from "../shared/permissions.js";
import { shanghaiDateDaysAgo, shanghaiDateKey } from "../shanghai-time.js";
import { cancellationReasonTypes, translateCancellationReason } from "./order-cancellation-display.js";

const normalized = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const types = cancellationReasonTypes();
function platform(session) {
  if (!isPlatformAdmin(session)) throw Object.assign(new Error("仅平台超级管理员可以核查及归类共用取消原因"), { status: 403 });
}
export function matchReviewedCancellationReason(reason, rules = []) {
  const sample = reason && typeof reason === "object" ? { cancel_reason: reason.original, cancel_reason_id: reason.reason_id } : { cancel_reason: reason };
  return rules.find(rule => types.some(type => type.value === rule.reason_code)
    && matchesCancellationRule(sample, rule)) || null;
}
export function matchesCancellationRule(sample, rule) {
  if (Number(rule.enabled ?? 1) === 0) return false;
  const pattern = normalized(rule.match_text), fields = Object.values(sample).map(normalized), text = fields.filter(Boolean).join(" ");
  if (!pattern) return false;
  if (rule.match_mode === "equals" && String(rule.note || "").startsWith("[reviewed-cancellation-reason]") && /^reason_id:[1-9]\d*$/.test(pattern)) return pattern === `reason_id:${normalized(sample.cancel_reason_id)}`;
  if (rule.match_mode === "equals") return fields.includes(pattern) || text === pattern;
  if (rule.match_mode === "starts_with") return text.startsWith(pattern);
  if (rule.match_mode === "regex") { try { return new RegExp(pattern, "i").test(text); } catch { return false; } }
  return text.includes(pattern);
}
function date(value) {
  const text = String(value || "");
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw Object.assign(new Error("请使用有效的北京时间日期"), { status: 400 });
  return text;
}
export async function unclassifiedCancellationReasons(query, filters = {}, session, now = new Date()) {
  platform(session);
  if (["tenant_id", "tenantId", "shop_id", "shopId"].some(key => Object.hasOwn(filters, key))) throw Object.assign(new Error("此核查使用平台共用口径，不接受企业或店铺选择参数"), { status: 400 });
  const from = date(filters.from || shanghaiDateDaysAgo(89, now)), to = date(filters.to || shanghaiDateKey(now));
  const start = new Date(`${from}T00:00:00+08:00`), end = new Date(`${to}T00:00:00+08:00`);
  if (end < start || end - start > 365 * 86400000) throw Object.assign(new Error("核查范围须在 366 天内"), { status: 400 });
  const rows = await query(`SELECT CAST(COALESCE(cancel_reason_id, 0) AS CHAR) AS reason_id,
      TRIM(COALESCE(NULLIF(cancel_reason, ''), cancel_type, '')) AS original,
      COUNT(*) AS order_count, MAX(updated_at) AS last_seen_at
    FROM orders WHERE updated_at >= ? AND updated_at < ?
      AND (NULLIF(TRIM(cancel_reason), '') IS NOT NULL OR NULLIF(TRIM(cancel_type), '') IS NOT NULL OR cancel_reason_id > 0)
    GROUP BY reason_id, original ORDER BY last_seen_at DESC, reason_id, original LIMIT 1001`,
  [start, new Date(end.getTime() + 86400000)].map(value => value.toISOString().slice(0, 19).replace("T", " ")));
  const rules = await query("SELECT * FROM order_cancellation_rules WHERE enabled = 1 ORDER BY priority, id");
  const candidates = rows.slice(0, 1000).filter(row => !translateCancellationReason({ cancel_reason_id: row.reason_id, cancel_reason: row.original }).translated);
  const reviewed = candidates.map(row => ({ ...row, reason_id: String(row.reason_id || ""), order_count: Number(row.order_count),
    classification: matchReviewedCancellationReason(row, rules) }));
  const pending = reviewed.filter(row => !row.classification), classified = reviewed.filter(row => row.classification);
  return { from, to, pending, classified, types, truncated: rows.length > 1000,
    notice: "仅核查取消原因分类资料，保留 Ozon 原始原因，不重算历史利润。" };
}

export async function saveCancellationReasonClassification(transaction, body = {}, session) {
  platform(session);
  if (["tenant_id", "tenantId", "shop_id", "shopId"].some(key => Object.hasOwn(body, key))) throw Object.assign(new Error("取消原因使用平台共用口径，不接受企业或店铺选择参数"), { status: 400 });
  const original = String(body.original || "").trim(), reasonId = String(body.reason_id || "").trim(), type = types.find(item => item.value === body.reason_code);
  const codeOnly = !original && /^[1-9]\d{0,18}$/.test(reasonId) && BigInt(reasonId) <= 9223372036854775807n;
  if ((!original && !codeOnly) || original.length > 2000 || !type) throw Object.assign(new Error("请保留原始原因或官方代码，并选择已收录的原因类型"), { status: 400 });
  const matchText = original || `reason_id:${reasonId}`;
  const note = `[reviewed-cancellation-reason] reviewed_by=${Number(session.personId || 0)}; ${String(body.note || "").trim().slice(0, 300)}`;
  return transaction(async connection => {
    const [rows] = await connection.query("SELECT * FROM order_cancellation_rules WHERE match_mode = 'equals' AND BINARY match_text = ? FOR UPDATE", [matchText]);
    const existing = rows.find(row => String(row.note || "").startsWith("[reviewed-cancellation-reason]"));
    if (existing) {
      if (existing.reason_code !== type.value || Number(existing.enabled) === 0) throw Object.assign(new Error("该原因已有分类或已停用，请在已有规则中核对后编辑"), { status: 409 });
      return { id: Number(existing.id), reused: true, reason_code: existing.reason_code, historical_profit_changed: false };
    }
    const [result] = await connection.execute(`INSERT INTO order_cancellation_rules
      (name, match_text, match_mode, initiator_label, reason_label, reason_code, reason_group_label, accounting_hint, priority, enabled, note)
      VALUES (?, ?, 'equals', '', ?, ?, '人工核对分类', '保留原始原因，仅登记分类；不重算历史利润', 10, 1, ?)`, [type.label, matchText, type.label, type.value, note]);
    return { id: Number(result.insertId), reason_code: type.value, historical_profit_changed: false };
  });
}

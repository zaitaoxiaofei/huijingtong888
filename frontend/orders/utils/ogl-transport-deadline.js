import { orderStateKey } from "../constants/orders-ui.js";

export function usesOglTransportDeadline(row = {}) {
  if ([row.fulfillment_type_key, row.logistics_fulfillment_type, row.fulfillment_schema].some(value => String(value || "").toLowerCase() === "fbp")) return false;
  return row.logistics_carrier === "ogl" || (!row.logistics_carrier && row.ogl_dispatch?.tracking === true);
}

function remainingTransportTime(row, now) {
  if (!usesOglTransportDeadline(row) || row.ogl_transport_deadline?.stopped === true || !["awaiting_packaging", "awaiting_deliver", "ogl_dispatched"].includes(orderStateKey(row))) return null;
  const deadline = String(row.ogl_transport_deadline ? row.ogl_transport_deadline.at || "" : row.ogl_dispatch?.transport_deadline_at || "");
  const time = /(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline) ? Date.parse(deadline) : NaN;
  return Number.isFinite(time) && Number.isFinite(now) ? time - now : null;
}

export function oglTransportDeadlineHint(row = {}, now = Date.now()) {
  if (!usesOglTransportDeadline(row) || row.ogl_transport_deadline?.stopped === true || !["awaiting_packaging", "awaiting_deliver", "ogl_dispatched"].includes(orderStateKey(row))) return "";
  const remaining = remainingTransportTime(row, now);
  if (remaining === null) return "截止时间待获取";
  if (remaining < 0) return `超时 ${Math.ceil(-remaining / 86400000)} 天`;
  return `剩余 ${Math.ceil(remaining / 86400000)} 天`;
}

export function oglTransportDeadlineUrgent(row = {}, now = Date.now()) {
  const remaining = remainingTransportTime(row, now);
  return remaining !== null && (remaining < 0 || (orderStateKey(row) === "ogl_dispatched" && remaining < 3 * 86400000));
}

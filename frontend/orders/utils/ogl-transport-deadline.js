import { orderStateKey } from "../constants/orders-ui.js";

export function oglTransportDeadlineHint(row = {}, now = Date.now()) {
  if (orderStateKey(row) !== "ogl_dispatched") return "";
  const deadline = String(row.ogl_dispatch?.transport_deadline_at || "");
  const time = /(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline) ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(now)) return "等待进入运输：截止时间待获取";
  const remaining = time - now;
  if (remaining < 0) return `超时 ${Math.ceil(-remaining / 86400000)} 天`;
  if (remaining === 0) return "等待进入运输：已到截止时间";
  return `等待进入运输剩余 ${Math.ceil(remaining / 86400000)} 天`;
}

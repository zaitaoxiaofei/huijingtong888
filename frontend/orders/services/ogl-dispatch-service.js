import { apiClient } from "../../admin/utils/api.js";

export function normalizeOglOrderIds(ids = []) {
  return [...new Set(Array.from(ids).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export function oglMemberMatches(member, filter) {
  if (filter === "withdrawn") return Boolean(member.withdrawn_at || member.active === false || member.active === 0);
  const active = !member.withdrawn_at && member.active !== false && member.active !== 0;
  if (filter === "exception") return active && Boolean(member.exception_reason || member.exception_note || member.exception_code);
  if (filter === "awaiting_dispatch") return active && !member.dispatched_at;
  if (filter === "sync_pending") return active && Boolean(member.sync_error || (member.dispatched_at && !member.logistics_fresh));
  if (filter === "not_online") return active && Boolean(member.dispatched_at && member.logistics_fresh && !member.sync_error && !member.online && !member.cancelled);
  return true;
}

// Display state is derived by the server from OGL identity and current platform evidence.
// A historical local handover must never hide a later platform delivery/cancellation.
export function isOglDispatched(row = {}) {
  return row.ogl_dispatch?.dispatched === true && row.display_status === "ogl_dispatched";
}

export function oglDispatchDisplayStatus(row = {}) {
  if (row.ogl_dispatch?.dispatched !== true) return "";
  return ["ogl_dispatched", "delivering", "delivered", "cancelled", "dispute"].includes(row.display_status) ? row.display_status : "";
}

export function createOglDispatchService(client = apiClient) {
  return {
    bootstrap: () => client.get("/api/ogl-dispatch/bootstrap"),
    settings: (dispatchShopId) => client.put("/api/ogl-dispatch/settings", { dispatch_shop_id: Number(dispatchShopId) }),
    preview: (orderIds) => client.post("/api/ogl-dispatch/preview", { order_ids: normalizeOglOrderIds(orderIds) }),
    create: (payload) => client.post("/api/ogl-dispatch/batches", { ...payload, order_ids: normalizeOglOrderIds(payload.order_ids) }),
    list: (page = 1) => client.get(`/api/ogl-dispatch/batches?${new URLSearchParams({ page: String(page), page_size: "20" })}`),
    detail: (id) => client.get(`/api/ogl-dispatch/batch?id=${encodeURIComponent(id)}`),
    officialList: (date) => client.get(`/api/ogl-dispatch/official-carriages?${new URLSearchParams({ date })}`),
    officialDetail: (id, date) => client.get(`/api/ogl-dispatch/official-carriage?${new URLSearchParams({ id: String(id), date })}`),
    officialTracking: (id, date) => client.get(`/api/ogl-dispatch/official-carriage-tracking?${new URLSearchParams({ id: String(id), date })}`),
    action: (batchId, action, payload = {}) => client.post("/api/ogl-dispatch/action", { ...payload, batch_id: batchId, action }),
    file: (batchId, type) => {
      if (!["container-labels", "barcode"].includes(type)) throw new Error("未知发运文件类型");
      return client.blob(`/api/ogl-dispatch/file?${new URLSearchParams({ batch_id: String(batchId), type })}`);
    }
  };
}

export const oglDispatchService = createOglDispatchService();

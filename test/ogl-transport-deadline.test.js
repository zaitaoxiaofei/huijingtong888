import assert from "node:assert/strict";
import test from "node:test";
import { oglTransportDeadlineHint } from "../frontend/orders/utils/ogl-transport-deadline.js";

const now = Date.parse("2026-10-22T08:00:00Z");
const pending = { status: "acceptance_in_progress", display_status: "ogl_dispatched", ogl_dispatch: { tracking: true, applied: true, dispatched: false } };
const row = deadline => ({ ...pending, ogl_dispatch: { ...pending.ogl_dispatch, transport_deadline_at: deadline } });
test("OGL transportation countdown consumes the server deadline without reusing preparation deadlines", () => {
  assert.equal(oglTransportDeadlineHint({ ...row("2026-10-23T08:00:00Z"), shipment_deadline_at: "2026-10-20T08:00:00Z" }, now), "剩余 1 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-23T08:00:01Z"), now), "剩余 2 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-22T08:01:00Z"), now), "剩余 1 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-22T08:00:00Z"), now), "剩余 0 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-22T07:59:00Z"), now), "超时 1 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-21T07:59:00Z"), now), "超时 2 天");
  assert.equal(oglTransportDeadlineHint(row("2026-10-22T16:01:00+08:00"), now), "剩余 1 天");
});
test("unknown deadlines stay explicit and physical handover continues counting until platform transit", () => {
  for (const deadline of [undefined, null, "invalid", "2026-10-23 08:00:00"]) assert.equal(oglTransportDeadlineHint(row(deadline), now), "截止时间待获取");
  const dispatched = { ...row("2026-10-23T08:00:00Z"), ogl_dispatch: { ...row("2026-10-23T08:00:00Z").ogl_dispatch, dispatched: true } };
  assert.equal(oglTransportDeadlineHint(dispatched, now), "剩余 1 天");
  for (const status of ["delivering", "posting_in_transit", "delivered", "cancelled", "returned", "rejected", "dispute"]) assert.equal(oglTransportDeadlineHint({ ...dispatched, status }, now), "", status);
  assert.equal(oglTransportDeadlineHint({ status: "awaiting_deliver", shipment_deadline_at: "2026-10-23T08:00:00Z" }, now), "");
});

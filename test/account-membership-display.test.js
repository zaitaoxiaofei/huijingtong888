import assert from "node:assert/strict";
import test from "node:test";
import { membershipDisplay } from "../frontend/admin/utils/account-membership.js";
import { shanghaiDateTimeText } from "../frontend/admin/utils/shanghai-date.js";

const now = Date.parse("2026-10-22T08:00:00Z");
const tenant = { id: 1, status: "active", subscription_status: "active", access_allowed: true };

test("membership display uses actual expiry and rounds a partial remaining day up", () => {
  const state = membershipDisplay({ ...tenant, subscription_expires_at: "2026-10-23 09:00:00" }, now);
  assert.equal(state.label, "会员剩余 2 天");
  assert.equal(state.expiresAt, "2026-10-23T09:00:00Z");
  assert.equal(state.active, true);
  assert.equal(shanghaiDateTimeText(state.expiresAt), "2026/10/23 17:00:00");
});

test("membership API and auth tenant shapes show the same time and entitlement", () => {
  const auth = membershipDisplay({ ...tenant, subscription_expires_at: "2026-11-01T08:00:00Z" }, now);
  const api = membershipDisplay({ tenant_id: 1, status: "active", access_allowed: true, expires_at: "2026-11-01T08:00:00Z" }, now);
  assert.deepEqual(auth, api);
});

test("expired, blocked and unactivated accounts never appear as active members", () => {
  assert.equal(membershipDisplay({ ...tenant, subscription_expires_at: "2026-10-22T08:00:00Z" }, now).kind, "expired");
  assert.equal(membershipDisplay({ ...tenant, access_allowed: false }, now).active, false);
  assert.equal(membershipDisplay({ ...tenant, subscription_status: "unactivated", access_allowed: false }, now).kind, "unactivated");
  assert.equal(membershipDisplay({ ...tenant, subscription_status: "suspended" }, now).kind, "suspended");
  assert.equal(membershipDisplay({ ...tenant, status: "archived" }, now).kind, "suspended");
});

test("trial, no expiry, missing tenant and invalid dates remain explicit", () => {
  assert.equal(membershipDisplay({ ...tenant, subscription_status: "trial", subscription_expires_at: "2026-10-23T08:00:00Z" }, now).label, "试用剩余 1 天");
  assert.equal(membershipDisplay(tenant, now).label, "会员已开通");
  assert.equal(membershipDisplay(null, now).kind, "no-tenant");
  assert.equal(membershipDisplay({ id: 1 }, now).kind, "unavailable");
  assert.equal(membershipDisplay({ id: 1, status: "active" }, now).kind, "unavailable");
  assert.equal(membershipDisplay({ ...tenant, subscription_expires_at: "invalid" }, now).kind, "unavailable");
});

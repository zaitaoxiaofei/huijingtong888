import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { ROLE_DEFINITIONS } from "../src/shared/permissions.js";

const source = readFileSync(new URL("../frontend/admin/views/settings/EnterprisePersonnelPanel.vue", import.meta.url), "utf8");
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\r?\n/gm, "");

function harness() {
  let scope = "A";
  const calls = [];
  const messages = [];
  const context = vm.createContext({
    ROLE_DEFINITIONS, ref: (value) => ({ value }), reactive: (value) => value,
    computed: (getter) => ({ get value() { return getter(); } }), onMounted() {}, onBeforeUnmount() {},
    currentApiCacheScope: () => scope,
    ElMessage: { warning: (message) => messages.push(message), error: (message) => messages.push(message), success() {} },
    apiClient: Object.fromEntries(["get", "post", "put"].map((method) => [method, async (url, body) => { calls.push({ method, url, body }); return []; }]))
  });
  vm.runInContext(script, context);
  const view = vm.runInContext("({form,rows,filters,dialogVisible,identityEditable,businessRoleOptions,filteredRows,openCreate,openEdit,accountPayload,save,load})", context);
  return { view, calls, messages, rotate: () => { scope = "B"; } };
}

test("enterprise create sends only tenant membership and local identity fields", async () => {
  const h = harness();
  h.view.openCreate();
  Object.assign(h.view.form, { name: "Alice", username: "alice", password: "Strong#123", avatar_url: "", tenant_id: 999, platform_role: "super_admin", account_active: 0 });
  await h.view.save();
  assert.equal(h.calls[0].method, "post");
  assert.equal(h.calls[0].url, "/api/enterprise/people");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), {
    business_roles: ["operator"], member_active: 1, tenant_role: "member", name: "Alice", username: "alice", avatar_url: "", password: "Strong#123"
  });
  assert.equal(h.calls[1].url, "/api/enterprise/people");
  assert.ok(h.view.businessRoleOptions.every((role) => !["admin", "technical"].includes(role.value)));
});

test("shared identities cannot be renamed, globally disabled or have passwords reset by the enterprise form", async () => {
  const h = harness();
  h.view.openEdit({ person_id: 7, name: "Shared", username: "shared", tenant_role: "member", business_roles: ["packing"], member_active: 1, can_edit_identity: false });
  Object.assign(h.view.form, { name: "Changed", username: "changed", password: "Changed#123", avatar_url: "/private", account_active: 0, member_active: 0 });
  await h.view.save();
  assert.equal(h.calls[0].url, "/api/enterprise/people/7");
  assert.equal(h.calls[0].method, "put");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { business_roles: ["packing"], member_active: 0, tenant_role: "member" });
});

test("editable existing account omits a blank password and preserves owner/legacy business assignments", () => {
  const h = harness();
  h.view.openEdit({ id: 9, name: "Owner", username: "owner", tenant_role: "owner", business_roles: ["admin", "packing"], member_active: 1, can_edit_identity: 1 });
  h.view.form.password = "  ";
  const payload = h.view.accountPayload();
  assert.equal(payload.password, undefined);
  assert.equal(payload.tenant_role, undefined);
  assert.equal(payload.member_active, 1);
  assert.deepEqual([...payload.business_roles], ["admin", "packing"]);
  assert.equal(payload.name, "Owner");
});

test("new account validation blocks incomplete identity and a stale-account dialog cannot submit into another session", async () => {
  const h = harness();
  h.view.openCreate();
  await h.view.save();
  assert.equal(h.calls.length, 0);
  Object.assign(h.view.form, { name: "Alice", username: "alice", password: "Strong#123" });
  h.rotate();
  await h.view.save();
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.dialogVisible.value, false);
});

test("enterprise list includes disabled members and distinguishes member status from global account status", async () => {
  const h = harness();
  await h.view.load();
  assert.equal(h.calls[0].url, "/api/enterprise/people");
  h.view.rows.value = [
    { id: 1, name: "Active", member_active: 1, account_active: 1 },
    { id: 2, name: "Inactive member", member_active: 0, account_active: 1 },
    { id: 3, name: "Disabled account", member_active: 1, account_active: 0 }
  ];
  assert.equal(h.view.filteredRows.value.length, 3);
  h.view.filters.status = "inactive";
  assert.deepEqual(h.view.filteredRows.value.map((row) => row.id), [2]);
  assert.doesNotMatch(source, /["'`]\/api\/people(?:[\/"'`?])|apiClient\.delete|platform_role\s*:/);
  assert.match(source, /shanghaiDateTimeText\(row\.updated_at, \{ assumeUtcWhenNaive: true \}\)/);
});

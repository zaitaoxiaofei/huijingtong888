import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue";
import { membershipDisplay } from "../frontend/admin/utils/account-membership.js";

function componentScript(file) {
  return readFileSync(new URL(file, import.meta.url), "utf8").match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, "");
}
function fixture(t, kind = "membership") {
  const listeners = new Map(), unmount = [], activate = [], deactivate = [], mounted = [], calls = [];
  let scope = "same-session";
  const auth = reactive({ user: { id: 1, platform_role: kind === "vouchers" ? "super_admin" : null, tenant: { id: 10, role: "owner", subscription_status: "unactivated", access_allowed: false } } });
  const request = name => new Promise((resolve, reject) => calls.push({ name, resolve, reject }));
  const context = vm.createContext({
    computed, reactive, ref, watch, auth, useAuthStore: () => auth,
    defineProps: () => ({ plans: [{ code: "monthly", active: 1 }] }),
    useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }),
    currentApiCacheScope: () => scope, membershipDisplay, shanghaiDateTimeText: value => String(value),
    getMembership: () => request("membership"),
    apiClient: { get: () => request("get-vouchers"), post: () => request("issue-voucher"), delete: () => request("revoke-voucher") },
    ElMessage: { success() {}, info() {} }, ElMessageBox: { confirm: async () => true },
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmount.push(fn), onActivated: fn => activate.push(fn), onDeactivated: fn => deactivate.push(fn),
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  });
  const effects = effectScope();
  const file = kind === "membership" ? "../frontend/admin/views/MembershipView.vue" : "../frontend/admin/components/SubscriptionVouchersPanel.vue";
  effects.run(() => vm.runInContext(componentScript(file), context));
  t.after(() => { unmount.forEach(fn => fn()); effects.stop(); });
  return { auth, calls, context, get: code => vm.runInContext(code, context), mount: () => mounted.forEach(fn => fn()), deactivate: () => deactivate.forEach(fn => fn()), activate: () => activate.forEach(fn => fn()),
    rotate() { scope = "new-token"; listeners.get("erp:auth-scope-changed")?.(); } };
}
const value = (status, expires_at = null) => ({ tenant_id: 10, tenant_name: "Current enterprise", status, expires_at, access_allowed: status === "active", can_activate: true });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };

test("membership refresh ignores an older response within the same account scope", async t => {
  const f = fixture(t);
  f.calls[0].resolve(value("unactivated"));
  await flush();
  const older = f.get("load()"), newer = f.get("load()");
  f.calls[2].resolve(value("active", "2030-01-01T00:00:00Z")); await newer;
  f.calls[1].resolve(value("expired", "2020-01-01T00:00:00Z")); await older;
  assert.equal(f.get("membership.value.status"), "active");
});
test("token rotation clears cached membership and reloads without reusing old activation authority", async t => {
  const f = fixture(t);
  f.calls[0].resolve(value("active", "2030-01-01T00:00:00Z")); await flush();
  assert.equal(f.get("membership.value.status"), "active");
  f.rotate();
  assert.equal(f.get("membership.value"), null);
  assert.equal(f.calls.length, 2);
  f.auth.user.tenant.role = "member"; await nextTick();
  assert.equal(f.get("canActivate.value"), false);
});
test("deactivated membership views do not apply late replies and reload when restored", async t => {
  const f = fixture(t);
  f.deactivate();
  f.calls[0].resolve(value("active", "2030-01-01T00:00:00Z")); await flush();
  assert.equal(f.get("membership.value"), null);
  f.activate();
  assert.equal(f.calls.length, 2);
});
test("same-token platform grant removal clears voucher plaintext and blocks further actions", async t => {
  const f = fixture(t, "vouchers");
  f.get("issuedCode.value='BD-PRIVATE-FIXTURE';issuedVisible.value=true;rows.value=[{id:9}];planCode.value='monthly'");
  f.auth.user.platform_role = null; await nextTick();
  assert.equal(f.get("issuedCode.value"), "");
  assert.equal(f.get("issuedVisible.value"), false);
  assert.equal(f.get("rows.value.length"), 0);
  await f.get("load(); issue()");
  assert.equal(f.calls.length, 0);
});
test("legacy admin roles cannot request or issue platform membership vouchers", async t => {
  const f = fixture(t, "vouchers");
  f.auth.user.platform_role = null;
  f.auth.user.roles = ["admin"];
  f.auth.user.tenant.role = "admin";
  f.get("planCode.value='monthly'");
  f.mount();
  f.get("issue()");
  assert.equal(f.calls.length, 0);
});

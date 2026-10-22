import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { ref } from "vue";
import { canAccessPage, hasPermission, isPlatformAdmin, needsMembershipActivation } from "../src/shared/permissions.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const routerSource = read("../frontend/admin/router/index.js");
const guardSource = routerSource.slice(routerSource.indexOf("router.beforeEach("), routerSource.indexOf("router.afterEach("));

function fixture(user) {
  const pending = { value: null }, requests = [], auth = { user, isAuthenticated: Boolean(user), async bootstrap() {} };
  let guard;
  vm.runInNewContext(guardSource, {
    router: { beforeEach: callback => { guard = callback; } }, document: {}, startRoutePerf() {}, useAuthStore: () => auth,
    canAccessPage, hasPermission, isPlatformAdmin, needsMembershipActivation,
    safeRedirectTarget: value => value, membershipDialogRequest: pending,
    requestMembershipDialog() { pending.value = {}; requests.push(true); },
    isMobileBrowser: () => false, prefersDesktopMode: () => false
  });
  return { guard, requests, auth };
}
const user = active => ({ id: 1, roles: ["operator"], tenant: { id: 8, role: "owner", access_allowed: active, subscription_status: active ? "active" : "unactivated" } });
const legacy = { path: "/membership", fullPath: "/membership?denied=activation", meta: {} };

test("legacy membership navigation opens the dialog without replacing the active business route", async () => {
  const f = fixture(user(true));
  const from = { path: "/orders", fullPath: "/orders?shopId=42&keyword=retained", query: { shopId: "42", keyword: "retained" }, matched: [{}], meta: { title: "订单列表" } };
  assert.equal(await f.guard(legacy, from), false);
  assert.equal(f.requests.length, 1);
  assert.equal(from.fullPath, "/orders?shopId=42&keyword=retained");
  assert.deepEqual(from.query, { shopId: "42", keyword: "retained" });
});

test("direct legacy membership and denied paid routes retain an accessible activation path for unactivated users", async () => {
  const f = fixture(user(false));
  const result = await f.guard(legacy, { path: "/", matched: [] });
  assert.equal(result.path, "/tools/profit-calculator");
  assert.equal(result.replace, true);
  assert.equal(f.requests.length, 1);
  assert.equal(canAccessPage(f.auth.user, result.path), true);
  const denied = await f.guard({ path: "/orders", fullPath: "/orders", meta: {} }, {});
  assert.equal(denied.path, "/tools/profit-calculator");
  assert.equal(denied.query.denied, "activation");
  assert.equal(f.requests.length, 2);
  const anonymous = fixture(null);
  const login = await anonymous.guard(legacy, {});
  assert.equal(login.name, "login");
  assert.equal(anonymous.requests.length, 0);
});

test("dialog requests are consumed once and cannot reopen in a different login scope", () => {
  let scope = "session-a";
  const source = read("../frontend/admin/utils/membership-dialog.js").replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
  const api = vm.runInNewContext(`${source};({requestMembershipDialog,consumeMembershipDialogRequest,membershipDialogRequest})`, { ref, currentApiCacheScope: () => scope });
  api.requestMembershipDialog();
  assert.equal(api.consumeMembershipDialogRequest(), true);
  assert.equal(api.consumeMembershipDialogRequest(), false);
  api.requestMembershipDialog();
  scope = "session-b";
  assert.equal(api.consumeMembershipDialogRequest(), false);
  assert.equal(api.membershipDialogRequest.value, null);
});

test("header membership actions open reusable dialog content without adding a side menu or route change", () => {
  const layout = read("../frontend/admin/layouts/AdminLayout.vue");
  const open = layout.slice(layout.indexOf("function openActivationDialog("), layout.indexOf("async function loadNotifications("));
  assert.doesNotMatch(open, /router\.(push|replace)/);
  assert.match(layout, /title="会员中心"[^>]*destroy-on-close[^>]*:close-on-press-escape="true"/);
  assert.match(layout, /<MembershipView v-if="activationDialogVisible" embedded/);
  const navigation = read("../frontend/admin/constants/navigation.js");
  assert.doesNotMatch(navigation, /route: "\/membership"/);
});

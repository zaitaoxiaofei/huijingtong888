import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/settings/TenantSubscriptionView.vue", import.meta.url), "utf8");
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]+\n/gm, "");
function harness(fail = false) {
  const calls = [];
  const messages = [];
  const context = vm.createContext({
    structuredClone,
    navigator: { clipboard: { writeText: async text => calls.push({ copied: text }) } }, window: { location: { origin: "https://example.test" } },
    ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter(); } }), onMounted() {},
    ElMessage: { success: message => messages.push(message), error: message => messages.push(message) },
    apiClient: {
      post: async (url, body) => { calls.push({ url, body: structuredClone(body) }); if (fail) throw new Error("子账号名额已满");
        if (url === "/api/tenants/login-info") return { enterprise: "New Company", username: "latest-admin", password: "Latest#9382" };
        if (url === "/api/tenants") return { id: 7, owner_credentials: { username: "admin_random", password: "Secret#9382" } };
      },
      get: async url => url === "/api/tenants" ? [{ id: 7, name: "Customer" }] : []
    }
  });
  vm.runInContext(script, context);
  const view = vm.runInContext("({ selected, accountForm, accountVisible, accountSaving, memberVisible, createAccount, tenantForm, createVisible, tenantSaving, deliveryVisible, deliveryInfo, createTenant, copyDeliveryInfo, deliveryCopying })", context);
  view.selected.value = { id: 7, name: "Customer" };
  view.accountVisible.value = true;
  Object.assign(view.accountForm, { name: "New Admin", username: "new-admin", password: "Secure#9382" });
  return { view, calls, messages };
}

test("customer admin creation atomically targets the selected enterprise and blocks double submission", async () => {
  const { view, calls } = harness();
  const pending = view.createAccount();
  await view.createAccount();
  await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: "/api/tenants/members", body: { tenant_id: 7, name: "New Admin", username: "new-admin", password: "Secure#9382", tenant_role: "admin" } }]);
  assert.equal(view.accountVisible.value, false);
  assert.equal(view.memberVisible.value, false);
  assert.equal(view.accountForm.password, "");
  assert.equal(view.accountSaving.value, false);
});

test("failed customer account creation preserves the form and displays the blocking reason", async () => {
  const { view, messages } = harness(true);
  await view.createAccount();
  assert.equal(view.accountVisible.value, true);
  assert.equal(view.accountForm.username, "new-admin");
  assert.equal(view.accountSaving.value, false);
  assert.deepEqual(messages, ["子账号名额已满"]);
});

test("creating an enterprise needs only a name and plan, generates the owner and exposes copyable credentials immediately", async () => {
  const { view, calls } = harness();
  Object.assign(view.tenantForm, { name: "New Company", plan_code: "monthly_team" });
  view.createVisible.value = true;
  const pending = view.createTenant();
  await view.createTenant();
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/tenants");
  assert.equal(calls[0].body.provision_owner, true);
  assert.equal(calls[0].body.owner_person_id, undefined);
  assert.equal(view.createVisible.value, false);
  assert.equal(view.deliveryVisible.value, true);
  assert.equal(view.deliveryInfo.value.username, "admin_random");
  assert.equal(view.tenantSaving.value, false);
  await view.copyDeliveryInfo();
  assert.equal(calls[1].url, "/api/tenants/login-info");
  assert.equal(calls[1].body.tenant_id, 7);
  assert.match(calls[2].copied, /https:\/\/example.test\/admin.html/);
  assert.match(calls[2].copied, /latest-admin/);
  assert.match(calls[2].copied, /Latest#9382/);
  assert.equal(view.deliveryInfo.value.password, undefined);
  assert.equal(view.deliveryCopying.value, false);
});

test("enterprise provisioning failure keeps the create form and does not display incomplete credentials", async () => {
  const { view } = harness(true);
  Object.assign(view.tenantForm, { name: "New Company", plan_code: "monthly_team" });
  view.createVisible.value = true;
  await view.createTenant();
  assert.equal(view.createVisible.value, true);
  assert.equal(view.deliveryVisible.value, false);
  assert.equal(view.deliveryInfo.value, null);
  assert.equal(view.tenantSaving.value, false);
});

test("enterprise details can repeatedly copy the persisted latest login info without the original create dialog", async () => {
  const { view, calls } = harness();
  view.deliveryInfo.value = null;
  await view.copyDeliveryInfo(7);
  await view.copyDeliveryInfo(7);
  assert.equal(calls.filter(call => call.url === "/api/tenants/login-info").length, 2);
  assert.equal(calls.filter(call => call.copied).length, 2);
});

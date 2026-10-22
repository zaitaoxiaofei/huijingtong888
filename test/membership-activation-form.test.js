import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { effectScope, reactive, ref, watch } from "vue";

const source = readFileSync(new URL("../frontend/admin/components/MembershipActivationForm.vue", import.meta.url), "utf8")
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, "");
function fixture(t) {
  const calls = [], messages = [], events = [], emitted = [], listeners = new Map(), unmount = [];
  const auth = reactive({ user: { id: 1, tenant: { id: 10 } }, async verifySession() {
    auth.user = { id: 1, tenant: { id: 10, access_allowed: true } };
    return auth.user;
  } });
  let resolve, reject, scope = "a";
  const pending = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const context = vm.createContext({ ref, watch, defineProps() {}, defineEmits: () => (...args) => emitted.push(args),
    onBeforeUnmount: callback => unmount.push(callback), useAuthStore: () => auth,
    currentApiCacheScope: () => scope,
    activateMembership: code => { calls.push(code); return pending; },
    ElMessage: { success: text => messages.push(text) }, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type), dispatchEvent: event => events.push(event.type) }
  });
  const effects = effectScope();
  effects.run(() => vm.runInContext(`${source}\nglobalThis.form = { code, errorText, saving, submit };`, context));
  t.after(() => { unmount.forEach(fn => fn()); effects.stop(); });
  return { form: context.form, auth, calls, messages, events, emitted, resolve, reject,
    rotate() { scope = "b"; listeners.get("erp:auth-scope-changed")?.(); } };
}

test("activation validates empty input and submits only once while awaiting redemption", async t => {
  const f = fixture(t);
  await f.form.submit();
  assert.equal(f.form.errorText.value, "请输入激活码");
  assert.equal(f.calls.length, 0);
  f.form.code.value = "  BD-FIXTURE  ";
  const pending = f.form.submit();
  await f.form.submit();
  assert.deepEqual(f.calls, ["BD-FIXTURE"]);
  f.resolve({ ok: true });
  await pending;
  assert.equal(f.form.code.value, "");
  assert.equal(f.form.saving.value, false);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.events, ["erp:membership-updated"]);
  assert.equal(f.emitted[0][0], "activated");
});

test("late redemption cannot announce success in a different authentication scope", async t => {
  const f = fixture(t);
  f.form.code.value = "BD-FIXTURE";
  const pending = f.form.submit();
  f.rotate();
  f.resolve({ ok: true });
  await pending;
  assert.equal(f.form.code.value, "");
  assert.equal(f.messages.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.emitted.length, 0);
});

test("failed activation preserves the entered code and displays server guidance", async t => {
  const f = fixture(t);
  f.form.code.value = "BD-FIXTURE";
  const pending = f.form.submit();
  f.reject(new Error("激活码已被使用"));
  await pending;
  assert.equal(f.form.errorText.value, "激活码已被使用");
  assert.equal(f.form.code.value, "BD-FIXTURE");
  assert.equal(f.form.saving.value, false);
  assert.equal(f.emitted.length, 0);
});

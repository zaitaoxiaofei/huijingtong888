import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse as parseJs } from "acorn";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { isPlatformAdmin } from "../src/shared/permissions.js";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const settings = read("frontend/admin/views/settings/SettingsView.vue"), packaging = read("frontend/admin/views/tools/PackagingFeeRuleView.vue");
const clone = value => JSON.parse(JSON.stringify(value));
function view(source, { user = {}, section = "logistics", get = async () => [], post = async () => ({}) } = {}) {
  const { descriptor } = parse(source);
  const script = descriptor.scriptSetup.content;
  const imports = parseJs(script, { ecmaVersion: "latest", sourceType: "module" }).body.filter(node => node.type === "ImportDeclaration");
  let code = script;
  for (const node of imports.reverse()) code = code.slice(0, node.start) + code.slice(node.end);
  const calls = [], messages = [], context = vm.createContext({ URLSearchParams, console, Date,
    computed: getter => Object.defineProperty({}, "value", { get: getter }), reactive: value => value, ref: value => ({ value }),
    onMounted() {}, watch() {}, defineProps: () => ({ section }), useAuthStore: () => ({ user }), isPlatformAdmin,
    shanghaiDateKey: () => "2026-10-26", shanghaiDateDaysAgo: () => "2026-07-29", shanghaiDateTimeText: value => value,
    ElMessage: new Proxy({}, { get: () => value => messages.push(value) }), ElMessageBox: { confirm: async () => {} },
    apiClient: { get: async (...args) => { calls.push(["GET", ...args]); return get(...args); }, post: async (...args) => { calls.push(["POST", ...args]); return post(...args); } }
  });
  vm.runInContext(code, context);
  return { context, calls, messages, value: expression => vm.runInContext(expression, context) };
}

test("separate settings source compiles and removes obsolete exchange and historical-profit UI", () => {
  for (const [filename, source] of [["SettingsView.vue", settings], ["PackagingFeeRuleView.vue", packaging]]) {
    const { descriptor, errors } = parse(source);
    assert.deepEqual(errors, []);
    compileScript(descriptor, { id: filename });
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: filename }).errors, []);
  }
  assert.doesNotMatch(settings + packaging, /exchange-rates|createDefaultRateForm|rateDialog|packaging-fee-rule\/changes|recalculate-historical|历史利润辅助重算|最近变更/);
  assert.doesNotMatch(settings, /shopDialog|personDialog|uploadListingMedia|\/api\/people/);
  assert.match(settings, /<el-table-column v-if="canEdit" label="操作"/);
  assert.match(packaging, /<el-form[^>]*:disabled="!canEdit"/);
});

test("enterprise packaging reads cannot mutate while platform save uses only the packaging rule endpoint", async () => {
  const readonly = view(packaging, { user: { tenant: { id: 2, role: "owner" } }, get: async () => ({ low_sale_threshold_cny: 75, low_fee_cny: 1, high_fee_cny: 2 }) });
  await readonly.context.load(); await readonly.context.save();
  assert.equal(readonly.value("rule.low_sale_threshold_cny"), 75);
  assert.deepEqual(readonly.calls.map(call => [call[0], call[1]]), [["GET", "/api/settings/packaging-fee-rule"]]);
  const admin = view(packaging, { user: { platform_role: "super_admin" } });
  await admin.context.save();
  assert.deepEqual(clone(admin.calls), [["POST", "/api/settings/packaging-fee-rule", { low_sale_threshold_cny: 50, low_fee_cny: 0.5, high_fee_cny: 1 }]]);
});

test("logistics route loads only safe rules and cancellation review preserves the exact original text", async () => {
  const logistics = view(settings, { user: { tenant: { id: 2, role: "owner" } }, get: async () => [{ id: 1, name: "Shared rule" }] });
  await logistics.context.refreshSettingsData();
  assert.deepEqual(logistics.calls.map(call => [call[0], call[1]]), [["GET", "/api/logistics-rules"]]);
  assert.equal(logistics.value("canEdit.value"), false);
  const review = view(settings, { user: { platform_role: "super_admin" }, section: "cancel", get: async path => path.endsWith("order-cancellation-rules") ? [] : { pending: [], classified: [], types: [{ value: "wrong_item", label: "Wrong item" }] } });
  await review.context.refreshSettingsData();
  assert.equal(review.calls.length, 2);
  review.context.openReasonClassification({ original: "Official raw reason" });
  review.value("reasonReview.form.reason_code='wrong_item'");
  await review.context.saveReasonClassification();
  const [save] = review.calls.filter(call => call[0] === "POST");
  assert.deepEqual(clone(save), ["POST", "/api/order-cancellation-rules/classifications", { original: "Official raw reason", reason_code: "wrong_item", note: "" }]);
  review.context.openReasonClassification({ original: "", reason_id: "9998" });
  review.value("reasonReview.form.reason_code='wrong_item'");
  await review.context.saveReasonClassification();
  assert.deepEqual(clone(review.calls.filter(call => call[0] === "POST")[1]), ["POST", "/api/order-cancellation-rules/classifications", { original: "", reason_id: "9998", reason_code: "wrong_item", note: "" }]);
  assert.ok(review.calls.every(call => !call[1].includes("profit") && !call[1].includes("exchange")));
});

test("legacy settings URLs redirect to separate pages and AI routes preserve explicit legacy redirects", () => {
  const source = read("frontend/admin/router/index.js"), ast = parseJs(source, { ecmaVersion: "latest", sourceType: "module" });
  const objects = [];
  const visit = value => { if (!value || typeof value !== "object") return; if (value.type === "ObjectExpression") objects.push(value); for (const item of Object.values(value)) if (Array.isArray(item)) item.forEach(visit); else if (item && typeof item === "object") visit(item); };
  visit(ast);
  const route = path => objects.find(node => node.properties.some(property => property.key?.name === "path" && property.value?.value === path));
  const redirect = path => route(path).properties.find(property => property.key?.name === "redirect").value;
  const legacyNode = redirect("settings"), legacy = vm.runInNewContext(`(${source.slice(legacyNode.start, legacyNode.end)})`);
  for (const [section, path] of [["rates", "/dashboard"], ["profit", "/tools/packaging-fee-rule"], ["logistics", "/logistics-settings"], ["cancel", "/order-cancellation-rules"]]) assert.equal(legacy({ query: { section } }).path, path);
  assert.equal(redirect("settings/materials").value, "/ai-materials");
  assert.equal(redirect("settings/prompts").value, "/ai-prompts");
  for (const path of ["tools/packaging-fee-rule", "logistics-settings", "order-cancellation-rules", "ai-materials", "ai-prompts"]) assert.ok(route(path), path);
});

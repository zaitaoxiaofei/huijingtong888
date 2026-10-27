import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/marketing/OzonActionsView.vue", import.meta.url), "utf8");
const functionNames = [
  "createEmptyCleanupConfig", "normalizeCleanupConfig", "cleanupReadableError", "cleanupConfigErrorText",
  "applyCleanupConfig", "notifyCleanupResult", "saveCleanupEnabled", "saveCleanupEnabledForStore",
  "runCleanupForStore", "runAllCleanupNow", "stopCleanupPolling", "startCleanupPolling", "cleanupStatusLabel", "cleanupStatusType", "cleanupIsDelayed"
];

function readyConfig(extra = {}) {
  return { storeId: "1", enabled: true, authorizationReady: true, taskEnabled: true, lastRunAt: new Date().toISOString(), ...extra };
}

function createHarness(response, initial = {}) {
  const messages = [];
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let now = Date.now();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    AUTO_CLEANUP_ACTION_IDS: [], AUTO_CLEANUP_INTERVAL_MINUTES: 5,
    state: { storeId: "1", cleanupConfig: {}, cleanupConfigsByStore: {}, ...initial },
    apiClient: { post: async (url, body) => { calls.push({ url, body }); if (response instanceof Error) throw response; return response; } },
    ElMessageBox: { confirm: async () => {} },
    ElMessage: Object.fromEntries(["success", "warning", "error", "info"].map((type) => [type, (text) => messages.push({ type, text })])),
    window: { setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: (id) => timers.delete(id) },
    loadAllCleanupConfigs: async () => {}
  });
  vm.runInContext("let cleanupPollTimer = null; let cleanupPollGeneration = 0;", context);
  for (const name of functionNames) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `missing view function ${name}`);
    vm.runInContext(match[0], context);
  }
  return {
    context, messages, calls, timers,
    advance: (milliseconds) => { now += milliseconds; },
    tick: async () => { const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); }
  };
}

test("cleanup state preserves authorization and task readiness independently from the enabled switch", () => {
  const { context } = createHarness();
  const legacy = context.normalizeCleanupConfig({ enabled: true, taskEnabled: true }, "1");
  assert.equal(legacy.authorizationReady, false);
  assert.equal(context.cleanupStatusLabel(legacy), "待授权");
  assert.equal(context.cleanupStatusType(legacy), "warning");
  const paused = context.normalizeCleanupConfig(readyConfig({ taskEnabled: false, authorizationError: "saved detail" }));
  assert.equal(paused.authorizationError, "saved detail");
  assert.equal(context.cleanupStatusLabel(paused), "调度暂停");
  assert.equal(context.cleanupStatusLabel(readyConfig({ lastRunAt: "" })), "等待首扫");
  assert.equal(context.cleanupStatusLabel(readyConfig()), "最近正常");
  assert.equal(context.cleanupStatusLabel(readyConfig({ enabled: false, lastError: "old failure" })), "未启用");
});

test("cleanup delay follows the configured interval and never masks missing authorization", () => {
  const { context } = createHarness();
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  assert.equal(context.cleanupIsDelayed(readyConfig({ lastRunAt: twentyMinutesAgo, intervalMinutes: 15 })), false);
  assert.equal(context.cleanupIsDelayed(readyConfig({ lastRunAt: twentyMinutesAgo, intervalMinutes: 5 })), true);
  assert.equal(context.cleanupIsDelayed(readyConfig({ authorizationReady: false, lastRunAt: twentyMinutesAgo })), false);
});

test("single-store HTTP 200 failure updates state and never announces success", async () => {
  const payload = { success: false, config: readyConfig({ authorizationError: "未保存企业归属或操作人", lastError: "活动 44：退出失败" }), immediateRun: { success: false, count: 0, error: "failed" } };
  const { context, messages, calls } = createHarness(payload);
  await context.runCleanupForStore({ id: 1 }, { enabled: true });
  assert.equal(calls[0].url, "/api/ozon/actions/cleanup-config");
  assert.equal(calls[0].body.enabled, true);
  assert.equal(context.state.cleanupConfig.lastError, "活动 44：退出失败");
  assert.deepEqual(messages.map((item) => item.type), ["error"]);
  assert.match(messages[0].text, /活动 44：退出失败/);
  assert.equal(context.state.cleanupRunningStoreId, "");
});

test("single-store partial removal warns and preserves the enabled configuration", async () => {
  const payload = { success: false, config: readyConfig({ lastError: "活动 44：剩余 1 个商品" }), immediateRun: { success: false, count: 3 } };
  const { context, messages } = createHarness(payload);
  await context.saveCleanupEnabledForStore(1, true);
  assert.equal(context.state.cleanupConfigsByStore["1"].enabled, true);
  assert.equal(messages[0].type, "warning");
  assert.match(messages[0].text, /已移除 3 个商品/);
  assert.equal(messages.some((item) => item.type === "success"), false);
});

test("turning on with an unauthorized actor never displays an enabled success toast", async () => {
  const payload = { success: true, config: readyConfig({ authorizationReady: false, taskEnabled: false, authorizationError: "未保存企业归属或操作人" }), immediateRun: { success: true } };
  const { context, messages } = createHarness(payload, { cleanupConfig: { actionIds: [] } });
  await context.saveCleanupEnabled(true);
  assert.equal(messages[0].type, "error");
  assert.match(messages[0].text, /点击「立即扫描」/);
  assert.equal(context.cleanupStatusLabel(context.state.cleanupConfig), "待授权");
  assert.equal(context.state.cleanupConfig.authorizationError, "未保存企业归属或操作人");
});

test("turning off does not require an authorized actor or announce an old run failure", async () => {
  const { context, messages } = createHarness({ success: true, config: { storeId: "1", enabled: false, lastError: "old error" }, immediateRun: null });
  await context.saveCleanupEnabledForStore(1, false);
  assert.equal(messages[0].type, "success");
  assert.match(messages[0].text, /已关闭/);
  assert.equal(context.state.cleanupConfigsByStore["1"].enabled, false);
});

test("API permission and unavailable-service failures have actionable Chinese text", async () => {
  for (const [status, expected] of [[403, /企业.*运营权限/], [404, /服务暂不可用/]]) {
    const error = Object.assign(new Error("Request failed"), { status });
    const { context, messages } = createHarness(error);
    await context.runAllCleanupNow();
    assert.equal(messages[0].type, "error");
    assert.match(messages[0].text, expected);
    assert.equal(context.state.cleanupRunAllLoading, false);
  }
});

test("all-store partial result uses only the scoped endpoint and renders every returned configuration", async () => {
  const payload = {
    success: false, count: 5, failed: 1,
    configs: [readyConfig(), readyConfig({ storeId: "2", lastError: "活动 20 复查失败" })],
    results: [{ success: true, storeId: "1" }, { success: false, storeId: "2" }]
  };
  const { context, messages, calls } = createHarness(payload);
  await context.runAllCleanupNow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/ozon/actions/cleanup-run-all");
  assert.deepEqual(Object.keys(calls[0].body), []);
  assert.equal(context.state.cleanupConfigsByStore["2"].lastError, "活动 20 复查失败");
  assert.equal(context.state.cleanupConfig.storeId, "1");
  assert.equal(messages[0].type, "warning");
  assert.match(messages[0].text, /1 家未完成.*5 个商品/);
});

test("all-store result cannot hide per-store failures behind a successful envelope", async () => {
  const { context, messages } = createHarness({ success: true, configs: [], results: [{ success: false }], failed: 0, count: 0 });
  await context.runAllCleanupNow();
  assert.equal(messages[0].type, "warning");
  assert.equal(messages.some((item) => item.type === "success"), false);
});

test("background all-store scan announces start and polls until every target actually ran", async () => {
  const payload = { success: true, status: "running", configs: [readyConfig({ lastRunAt: "" })], results: [], failed: 0, count: 0 };
  const f = createHarness(payload);
  await f.context.runAllCleanupNow();
  assert.equal(f.messages[0].type, "info");
  assert.match(f.messages[0].text, /开始扫描/);
  assert.equal(f.messages.some((item) => item.type === "success"), false);
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.timers.size, 1, "queued targets without a new attempt must keep polling");
  f.context.loadAllCleanupConfigs = async () => { f.context.state.cleanupConfigsByStore["1"] = readyConfig({ lastAttemptAt: "2026-10-27T00:00:00Z", taskRunning: true }); };
  await f.tick();
  assert.equal(f.timers.size, 1, "an active target must keep polling");
  f.context.loadAllCleanupConfigs = async () => { f.context.state.cleanupConfigsByStore["1"] = readyConfig({ lastAttemptAt: "2026-10-27T00:00:00Z" }); };
  await f.tick();
  assert.equal(f.timers.size, 0);
});

test("polling stops on page disposal and in-flight refresh cannot restart it", async () => {
  const f = createHarness();
  let release;
  f.context.loadAllCleanupConfigs = () => new Promise((resolve) => { release = resolve; });
  f.context.startCleanupPolling([{ storeId: "1", lastAttemptAt: "", lastRunAt: "" }]);
  const pending = f.tick();
  f.context.stopCleanupPolling();
  release();
  await pending;
  assert.equal(f.timers.size, 0);
  assert.match(source, /onUnmounted\(stopCleanupPolling\)/);
  assert.match(source, /onDeactivated\(stopCleanupPolling\)/);
});

test("polling is bounded and a still-running job is never reported as finished", async () => {
  const f = createHarness();
  f.context.startCleanupPolling([{ storeId: "1", lastAttemptAt: "", lastRunAt: "" }]);
  f.advance(121_000);
  await f.tick();
  assert.equal(f.timers.size, 0);
  assert.equal(f.messages[0].type, "info");
  assert.match(f.messages[0].text, /仍在后台运行/);
});

test("empty and malformed all-store responses never imply a successful scan", async () => {
  const empty = createHarness({ success: true, configs: [], results: [], failed: 0, count: 0 });
  await empty.context.runAllCleanupNow();
  assert.equal(empty.messages[0].type, "info");
  const malformed = createHarness({ success: true });
  await malformed.context.runAllCleanupNow();
  assert.equal(malformed.messages[0].type, "error");
  assert.match(malformed.messages[0].text, /完整扫描结果/);
});

test("official activity cards no longer label every promotion as automatically enrolled", () => {
  assert.doesNotMatch(source, />A 已自动添加<\/el-tag>/);
  assert.match(source, /原始错误：/);
  assert.match(source, /cleanupConfigErrorText\(row\.config\)/);
});

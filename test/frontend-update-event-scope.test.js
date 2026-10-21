import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/App.vue", import.meta.url), "utf8");
function fixture() {
  const streams = [], frames = [], notices = [];
  let scope = "a";
  class Events {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
    emit(name) { this.listeners[name]({ data: '{"taskId":"own-task"}' }); }
  }
  const context = vm.createContext({ URLSearchParams, EventSource: Events, CustomEvent: function(name, data) { return { name, ...data }; },
    authStore: { isAuthenticated: true }, currentApiCacheScope: () => scope, getAuthToken: () => `token-${scope}`,
    updateEventSource: null, updateEventReconnectTimer: 0, updateEventPollingFallback: false,
    updateEventFailureCount: 0, UPDATE_EVENT_FAILURE_LIMIT: 2, APP_RELEASE_VERSION: "fixture", APP_RELEASE_CHANNEL: "local",
    resetUpdateEventBackoff() {}, scheduleUpdateEventReconnect() { throw new Error("stale reconnect"); }, scheduleInitialUpdateCheck() {},
    handleUpdateStatusPayload: data => frames.push(data), ElNotification: data => notices.push(data),
    window: { clearTimeout() {}, dispatchEvent: data => frames.push(data) }, router: { push() {} }, console
  });
  for (const name of ["closeUpdateEventStream", "openUpdateEventStream", "resetUpdateEventStreamForAuthScope"]) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))[0], context);
  }
  return { context, streams, frames, notices, rotate: () => { scope = "b"; } };
}

test("current enterprise AI and SKU live notifications remain available", () => {
  const f = fixture();
  f.context.openUpdateEventStream();
  f.streams[0].emit("ai-task");
  f.streams[0].emit("sku-order-tracking");
  assert.equal(f.frames[0].name, "erp:ai-task-update");
  assert.equal(f.notices.length, 1);
});

test("account rotation closes the old event stream and ignores its late events and errors", () => {
  const f = fixture();
  f.context.openUpdateEventStream();
  const previous = f.streams[0];
  f.rotate();
  f.context.resetUpdateEventStreamForAuthScope();
  assert.equal(previous.closed, true);
  f.context.openUpdateEventStream();
  const current = f.streams[1];
  for (const name of ["hello", "update", "ai-task", "sku-order-tracking"]) previous.emit(name);
  previous.onerror();
  assert.equal(f.frames.length, 0);
  assert.equal(f.notices.length, 0);
  assert.equal(current.closed, false);
  current.emit("ai-task");
  assert.equal(f.frames.length, 1);
});

test("logout does not reopen the prior event stream", () => {
  const f = fixture();
  f.context.openUpdateEventStream();
  f.context.authStore.isAuthenticated = false;
  f.rotate();
  f.context.resetUpdateEventStreamForAuthScope();
  f.context.openUpdateEventStream();
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].closed, true);
});

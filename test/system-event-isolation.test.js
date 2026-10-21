import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleBody = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const session = (personId, tenantId = 1, slug = "default") => ({ personId, roles: ["operations"], tenant: { id: tenantId, slug, role: "member" } });

function notifications() {
  const timers = new Map();
  const subscribers = [];
  const context = vm.createContext({
    fs: { existsSync: () => false, readFileSync() { throw new Error("No fixture status file"); },
      mkdirSync() { assert.fail("Event delivery must not write to disk"); }, writeFileSync() { assert.fail("Event delivery must not write to disk"); } },
    path: { resolve: (...parts) => parts.join("/"), join: (...parts) => parts.join("/") },
    process: { env: {} }, console,
    setInterval(callback, delay) { assert.equal(delay, 25000); const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  vm.runInContext(moduleBody(read("../src/server/notifications.js")), context);
  return {
    service: context, timers,
    subscribe(trustedSession, query = {}) {
      const chunks = [];
      const res = { destroyed: false, writableEnded: false, write(chunk) { chunks.push(chunk); } };
      const unsubscribe = context.subscribeGlobalUpdateEvents(res, query, trustedSession);
      const client = { res, unsubscribe, clear() { chunks.length = 0; },
        events() { return chunks.join("").split("\n\n").filter(Boolean).map(frame => ({
          type: frame.match(/^event: (.+)$/m)?.[1], payload: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "null")
        })); } };
      subscribers.push(client);
      return client;
    },
    close() { for (const client of subscribers) client.unsubscribe(); }
  };
}

test("only the exact default-enterprise business GET subscribes to system events", () => {
  const defaults = [session(7), { ...session(8), roles: ["packing"] }];
  const path = ["api", "system", "events"];
  for (const user of defaults) {
    assert.equal(tenantIsolationDecision(user, path, "GET").allowed, true);
    assert.equal(authorizeApiRequest({ method: "GET", _session: user }, path).allowed, true);
    for (const [method, parts] of [["HEAD", path], ["POST", path], ["GET", [...path, "other"]], ["GET", ["api", "system", "private"]]]) {
      assert.equal(authorizeApiRequest({ method, _session: user }, parts).allowed, false);
    }
  }
  const customer = session(7, 42, "company-a");
  assert.equal(tenantIsolationDecision(customer, path, "GET").allowed, false);
  assert.equal(authorizeApiRequest({ method: "GET", _session: customer }, path).allowed, false);
  const platform = { personId: 1, platform_role: "super_admin", tenant: null, roles: [] };
  assert.equal(tenantIsolationDecision(platform, path, "GET").allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: platform }, path).allowed, true);
});

test("the SSE route passes trusted session separately from untrusted query fields and rejects extra segments", async () => {
  const source = read("../src/server.js");
  const start = source.indexOf('  if (req.method === "GET" && parts[0] === "api" && parts[1] === "system" && parts[2] === "events"');
  const end = source.indexOf('  if (req.method === "GET" && parts[0] === "downloads"', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const unsubscribe = () => {};
  const context = vm.createContext({
    writeHead(_res, status, headers) { assert.equal(status, 200); assert.equal(headers["Content-Type"], "text/event-stream; charset=utf-8"); },
    subscribeGlobalUpdateEvents(...args) { calls.push(args); return unsubscribe; }
  });
  vm.runInContext(`async function route(req, res, url, parts) { ${source.slice(start, end)} return false; }`, context);
  const req = { method: "GET", _session: session(7), on(name, callback) { assert.equal(name, "close"); assert.equal(callback, unsubscribe); } };
  const res = {};
  const url = new URL("http://localhost/api/system/events?person_id=99&tenant_id=42&app_version=fixture-old");
  assert.equal(await context.route(req, res, url, ["api", "system", "events"]), true);
  assert.equal(calls[0][0], res);
  assert.equal(calls[0][1].person_id, "99");
  assert.equal(calls[0][2], req._session);
  assert.equal(await context.route(req, res, url, ["api", "system", "events", "other"]), false);
  assert.equal(calls.length, 1);
});

test("SSE target person and tenant come only from the trusted session and must both match", () => {
  const h = notifications();
  try {
    const target = h.subscribe(session(7, 42, "company-a"), { person_id: 99, personId: 99, tenant_id: 99, tenantId: 99, tenant_slug: "default" });
    const otherPerson = h.subscribe(session(8, 42, "company-a"));
    const otherTenant = h.subscribe(session(7, 99, "company-b"));
    const defaultUser = h.subscribe(session(7));
    const clients = [target, otherPerson, otherTenant, defaultUser];
    clients.forEach(client => client.clear());
    h.service.broadcastGlobalEvent("sku-order-tracking", { marker: "person-seven-company-a" }, { personId: 7, tenantId: 42 });
    assert.deepEqual(target.events().map(event => event.payload.marker), ["person-seven-company-a"]);
    for (const client of clients.slice(1)) assert.deepEqual(client.events(), []);
    h.service.broadcastGlobalEvent("sku-order-tracking", { marker: "forged-query-person" }, { personId: 99, tenantId: 42 });
    assert.equal(target.events().length, 1);
    for (const tenantId of [0, -1, "invalid", undefined]) {
      h.service.broadcastGlobalEvent("sku-order-tracking", { marker: "invalid-scope" }, { personId: 7, tenantId });
    }
    assert.equal(target.events().length, 1);
  } finally { h.close(); }
});

test("legacy untagged business events reach default subscribers only and still enforce recipient ownership", () => {
  const h = notifications();
  try {
    const target = h.subscribe(session(7));
    const otherPerson = h.subscribe(session(8));
    const customer = h.subscribe(session(7, 42, "company-a"), { tenant_slug: "default", tenant_id: 1 });
    const platform = h.subscribe({ personId: 7, platform_role: "super_admin", tenant: null });
    const untrusted = h.subscribe(undefined, { person_id: 7, tenant_id: 1, tenant_slug: "default" });
    [target, otherPerson, customer, platform, untrusted].forEach(client => client.clear());
    h.service.broadcastGlobalEvent("ai-task", { marker: "legacy-owner" }, { personId: 7 });
    h.service.broadcastGlobalEvent("system-notification", { refresh: true });
    assert.deepEqual(target.events().map(event => event.type), ["ai-task", "system-notification"]);
    assert.deepEqual(otherPerson.events().map(event => event.type), ["system-notification"]);
    for (const client of [customer, platform, untrusted]) assert.deepEqual(client.events(), []);
  } finally { h.close(); }
});

test("global hello, release updates and heartbeat remain available across subscriber contexts", () => {
  const h = notifications();
  try {
    const clients = [h.subscribe(session(7), { app_version: "fixture-old" }), h.subscribe(session(8, 42, "company-a")), h.subscribe({ personId: 1, tenant: null })];
    assert.equal(clients[0].events()[0].payload.status.app.update_required, true);
    for (const client of clients) assert.equal(client.events()[0].type, "hello");
    h.service.broadcastGlobalUpdateStatus();
    for (const heartbeat of [...h.timers.values()]) heartbeat();
    for (const client of clients) assert.deepEqual(client.events().map(event => event.type), ["hello", "update", "ping"]);
    clients[0].unsubscribe();
    assert.equal(h.timers.size, 2);
    h.service.broadcastGlobalUpdateStatus();
    assert.equal(clients[0].events().length, 3);
    clients[1].res.destroyed = true;
    for (const heartbeat of [...h.timers.values()]) heartbeat();
    assert.equal(h.timers.size, 1);
  } finally { h.close(); }
});

test("both SKU producers deliver only to the matching person in their resolved enterprise", async () => {
  const h = notifications();
  try {
    const target = h.subscribe(session(7, 42, "company-a"));
    const clients = [target, h.subscribe(session(7)), h.subscribe(session(8, 42, "company-a")), h.subscribe(session(7, 99, "company-b"))];
    clients.forEach(client => client.clear());
    const broadcasts = [];
    const context = vm.createContext({
      mysqlExecute: async () => ({}),
      mysqlQuery: async sql => {
        if (sql === "SHOW COLUMNS FROM sku_order_trackers") return [{ Field: "tenant_id" }];
        if (sql === "SHOW INDEX FROM sku_order_trackers") return ["uk_sku_order_tracker_tenant_shop_sku", "idx_sku_order_tracker_tenant_active_shop"].map(Key_name => ({ Key_name }));
        if (sql.startsWith("SELECT id, slug FROM tenants")) return [{ id: 42, slug: "company-a" }];
        if (sql.startsWith("SELECT id FROM shops")) return [{ id: 12 }];
        if (sql.startsWith("SELECT person_id FROM tenant_members")) return [{ person_id: 7 }];
        throw new Error(`Unexpected fixture SQL: ${sql}`);
      },
      broadcastGlobalEvent(name, payload, options) { broadcasts.push(options); h.service.broadcastGlobalEvent(name, payload, options); }
    });
    vm.runInContext(moduleBody(read("../src/services/sku-order-tracking.js")), context);
    await context.notifyDecliningTrackers([{ tracker_id: 3, tracked: 1, owner_person_id: 7, shop_id: 12, shop_name: "Fixture shop", ozon_sku: "fixture-sku", week_1_sales: 1, week_2_sales: 4, week_3_sales: 9 }], 42);
    await context.saveSkuOrderTracker({ shop_id: 12, ozon_sku: "fixture-sku", owner_person_id: 7 }, 7, "42");
    assert.deepEqual(broadcasts.map(options => ({ ...options })), [{ personId: 7, tenantId: 42 }, { personId: 7, tenantId: 42 }]);
    assert.deepEqual(target.events().map(event => event.type), ["sku-order-tracking", "sku-order-tracking"]);
    for (const client of clients.slice(1)) assert.deepEqual(client.events(), []);
  } finally { h.close(); }
});

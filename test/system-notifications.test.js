import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystemNotificationRoutes, handleSystemNotificationRestRoute } from "../src/server/routes/systemNotifications.js";

test("notification list route always scopes requests to the authenticated session", async () => {
  const calls = [];
  const services = {
    listSystemNotifications(query, session) {
      calls.push({ query, session });
      return { rows: [], unread: 0 };
    },
    markAllSystemNotificationsRead(session) {
      calls.push({ session });
      return { ok: true };
    }
  };
  const routes = createSystemNotificationRoutes({ services });
  const session = { personId: 7 };
  const result = await routes["GET /api/system-notifications"](
    { _session: session },
    new URL("http://localhost/api/system-notifications?status=unread")
  );
  assert.deepEqual(result, { rows: [], unread: 0 });
  assert.equal(calls[0].query.status, "unread");
  assert.equal(calls[0].session, session);
});

test("notification actions pass the authenticated session to mutation services", async () => {
  const calls = [];
  const services = {
    markSystemNotificationRead(id, session) {
      calls.push({ action: "read", id, session });
      return { ok: true };
    },
    resolveSystemNotification(id, session) {
      calls.push({ action: "resolve", id, session });
      return { ok: true };
    }
  };
  const response = {};
  const json = (_res, payload) => payload;
  const session = { personId: 8 };
  await handleSystemNotificationRestRoute({ req: { method: "POST", _session: session }, res: response, parts: ["api", "system-notifications", "12", "read"], services, json });
  await handleSystemNotificationRestRoute({ req: { method: "POST", _session: session }, res: response, parts: ["api", "system-notifications", "12", "resolve"], services, json });
  assert.deepEqual(calls.map(({ action, id, session: current }) => [action, id, current.personId]), [["read", "12", 8], ["resolve", "12", 8]]);
});

test("notification center includes persistence, deduplication and operator entry points", () => {
  const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/services/system-notifications.js", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS system_notifications/);
  assert.match(schema, /UNIQUE KEY uk_system_notifications_dedupe/);
  assert.match(service, /daily-procurement:\$\{dateKey\}/);
  assert.match(service, /fbp-shortage:\$\{dateKey\}/);
  assert.match(layout, /消息通知/);
  assert.match(layout, /标记处理/);
});

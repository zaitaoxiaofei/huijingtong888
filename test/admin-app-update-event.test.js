import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSourcePath = path.resolve(__dirname, "../frontend/admin/App.vue");

function appSource() {
  return fs.readFileSync(appSourcePath, "utf8");
}

test("admin app backs off system event reconnects", () => {
  const source = appSource();

  assert.match(source, /const UPDATE_EVENT_RECONNECT_BASE_MS = 10 \* 1000/);
  assert.match(source, /const UPDATE_EVENT_RECONNECT_MAX_MS = 5 \* 60 \* 1000/);
  assert.match(source, /const UPDATE_EVENT_FAILURE_LIMIT = 2/);
  assert.match(source, /function scheduleUpdateEventReconnect/);
  assert.match(source, /2 \*\* Math\.min\(updateEventRetryCount, 5\)/);
  assert.match(source, /updateEventReconnectTimer/);
  assert.match(source, /updateEventPollingFallback = true/);
  assert.match(source, /if \(!updateEventPollingFallback\) openUpdateEventStream\(\)/);
  assert.match(source, /closeUpdateEventStream\(\{ clearReconnect: false \}\)/);
  assert.doesNotMatch(source, /window\.setTimeout\(openUpdateEventStream, 10000\)/);
});

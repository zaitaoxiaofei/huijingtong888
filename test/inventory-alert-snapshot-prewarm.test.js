import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("inventory alert snapshots are refreshed before operators hit a cold page", () => {
  assert.match(serviceSource, /INTERVAL 15 MINUTE/);
  assert.match(serviceSource, /if \(forceRefresh\) invalidateMasterDataCache\("stock-alerts:base:v2"\)/);
  assert.match(serviceSource, /const persistedBase = forceRefresh \? null : await mysqlQueryOne/);
  assert.match(serverSource, /key: "inventory_alert_snapshot_refresh"/);
  assert.match(serverSource, /intervalMinutes: 10/);
  assert.match(serverSource, /withForegroundApiDeferral\("inventory_alert_snapshot_refresh"/);
  assert.match(serverSource, /refresh: "1"/);
});

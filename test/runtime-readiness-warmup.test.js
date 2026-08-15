import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const poolSource = fs.readFileSync(new URL("../src/mysql-pool.js", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");
const authSource = fs.readFileSync(new URL("../frontend/admin/stores/auth.js", import.meta.url), "utf8");
const releaseSource = fs.readFileSync(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8");

test("server finishes database warmup before listening", () => {
  assert.ok(serverSource.indexOf("await prepareRuntimeBeforeListen()") < serverSource.indexOf("server.listen("));
  assert.match(serverSource, /await warmMysqlPool\(\)/);
  assert.match(serverSource, /await services\.warmCoreInventoryRuntime\?\.\(\)/);
  assert.match(serverSource, /url\.pathname === "\/api\/ready"/);
  assert.match(poolSource, /export async function warmMysqlPool\(\)/);
});

test("deployment waits for readiness and safe GET requests retry once", () => {
  assert.match(releaseSource, /127\.0\.0\.1:3000\/api\/ready/);
  assert.match(apiSource, /function fetchWithSafeGetRetry/);
  assert.match(apiSource, /isSafeGet &&|!isSafeGet/);
  assert.match(authSource, /BOOTSTRAP_TIMEOUT_MS = 8000/);
  assert.match(authSource, /if \(Number\(error\?\.status \|\| 0\) === 401\) clearSession\(\)/);
});

test("deployment candidates do not start background workers and shutdown drains connections", () => {
  assert.match(serverSource, /process\.env\.DEPLOYMENT_CANDIDATE === "1"/);
  assert.match(serverSource, /if \(!deploymentCandidate\) setTimeout\(recoverGenerationJobs, 3000\)/);
  assert.match(serverSource, /server\.close\(\(error\) =>/);
  assert.match(serverSource, /process\.once\("SIGTERM"/);
});

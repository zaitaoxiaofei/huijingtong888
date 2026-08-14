import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("listing schema initialization is shared across concurrent callers", () => {
  assert.match(serviceSource, /let mysqlSchemaReadyPromise = null/);
  assert.match(serviceSource, /if \(!mysqlSchemaReadyPromise\) \{/);
  assert.match(serviceSource, /mysqlSchemaReadyPromise = initializeListingAutomationSchema\(\)/);
  assert.match(serviceSource, /mysqlSchemaReadyPromise = null;\s*throw error;/);
});

test("server warms listing schema before accepting requests", () => {
  assert.match(runtimeSource, /ensureListingAutomationSchema/);
  const warmupIndex = serverSource.indexOf("await services.ensureListingAutomationSchema?.()");
  const listenIndex = serverSource.indexOf("server.listen(config.port");
  assert.ok(warmupIndex > 0);
  assert.ok(listenIndex > warmupIndex);
  assert.match(serverSource, /listing automation schema warmup completed/);
});

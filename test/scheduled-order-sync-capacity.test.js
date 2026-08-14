import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scheduled jobs reserve enough concurrency for critical order sync", async () => {
  const [configSource, serverSource] = await Promise.all([
    readFile(new URL("../src/config.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8")
  ]);

  assert.match(configSource, /scheduledJobsMaxConcurrent:\s*readNumberEnv\("SCHEDULED_JOBS_MAX_CONCURRENT", 5\)/);
  assert.match(serverSource, /maxConcurrent:\s*Math\.max\(5, Number\(config\.scheduledJobsMaxConcurrent \|\| 5\)\)/);
});

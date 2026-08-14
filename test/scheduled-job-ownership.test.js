import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const envExampleSource = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const hostedStartSource = readFileSync(new URL("../deploy/windows-host/start-erp-server.ps1", import.meta.url), "utf8");

test("only the local 8788 service starts automatic scheduled jobs", () => {
  assert.match(configSource, /scheduledJobsEnabled: readBooleanEnv\("SCHEDULED_JOBS_ENABLED", Number\(process\.env\.PORT \|\| 8788\) === 8788\)/);
  assert.match(serverSource, /if \(config\.scheduledJobsEnabled\) \{[\s\S]*registerScheduledJobs\(scheduledJobDefinitions\)[\s\S]*scheduledJobScheduler\.start\(\)/);
  assert.match(serverSource, /scheduled job scheduler disabled for this server; manual runs remain available/);
  assert.match(envExampleSource, /SCHEDULED_JOBS_ENABLED=true/);
  assert.match(hostedStartSource, /if \(\$Port -eq 8788\) \{ "true" \} else \{ "false" \}/);
  assert.match(hostedStartSource, /set SCHEDULED_JOBS_ENABLED=\$scheduledJobsEnabled/);
});

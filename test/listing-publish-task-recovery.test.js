import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("listing batch publish disables Sharp cache and recovers only unsubmitted stale items", () => {
  assert.match(service, /sharp\.cache\(false\)/);
  assert.match(service, /export async function recoverInterruptedListingPublishTasksOnStartup/);
  assert.match(service, /COALESCE\(r\.task_id, ''\) = '' AND r\.response_json IS NULL/);
  assert.match(service, /i\.status IN \('pending', 'preparing', 'processing', 'submitted'\)/);
  assert.match(service, /i\.status = 'interrupted'/);
  assert.match(server, /recoverInterruptedListingPublishTasks\(\)/);
});

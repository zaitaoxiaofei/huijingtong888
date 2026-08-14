import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendSource = readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");
const taskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");

test("AI task polling backs off instead of querying at a fixed short interval", () => {
  assert.match(frontendSource, /AI_TASK_POLL_DELAYS_MS = \[1500, 2500, 4000, 5000\]/);
  assert.match(frontendSource, /aiTaskPollDelay\(pollAttempt\+\+\)/g);
  assert.doesNotMatch(frontendSource, /setTimeout\(resolve, 1200\)/);
});

test("AI task reads and retries are scoped to the current person", () => {
  assert.match(taskSource, /filters\.push\("created_by_person_id = \?"\)/);
  assert.match(taskSource, /ownershipSql = currentPersonId \? " AND created_by_person_id = \?" : ""/);
  assert.match(taskSource, /WHERE task_no = \? AND status IN \('failed', 'cancelled', 'provider_pending'\)\$\{ownershipSql\}/);
  assert.match(taskSource, /SELECT \* FROM ai_generation_tasks WHERE task_no = \?\$\{ownershipSql\} LIMIT 1/);
});

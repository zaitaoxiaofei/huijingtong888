import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const providerSource = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const notificationSource = readFileSync(new URL("../src/server/notifications.js", import.meta.url), "utf8");
const taskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const frontendSource = readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");

test("AI text streaming supports compatible chat and Responses upstreams", () => {
  assert.match(providerSource, /export async function streamAiProviderResponse/);
  assert.match(providerSource, /streamOpenAiCompatibleChat/);
  assert.match(providerSource, /stream: true/);
  assert.match(providerSource, /response\.output_text\.delta/);
  assert.match(providerSource, /choices\?\.\[0\]\?\.delta\?\.content/);
  assert.match(providerSource, /firstTokenMs/);
  assert.match(providerSource, /handlers\.signal/);
  assert.match(serverSource, /parts\[2\] === "stream"/);
  assert.match(serverSource, /event: \$\{event\}/);
  assert.match(apiSource, /export async function streamApiResponse/);
  assert.match(apiSource, /options\.onDelta/);
  assert.match(frontendSource, /streamAiProviderResponse/);
});

test("AI task completion wakes only its owner and retains polling fallback", () => {
  assert.match(notificationSource, /export function broadcastGlobalEvent/);
  assert.match(notificationSource, /Number\(client\.personId \|\| 0\) !== personId/);
  assert.match(taskSource, /broadcastGlobalEvent\("ai-task"/);
  assert.match(taskSource, /personId: row\.created_by_person_id/);
  assert.match(taskSource, /queuedMs/);
  assert.match(taskSource, /runMs/);
  assert.match(frontendSource, /waitForAiTaskUpdate/);
  assert.match(frontendSource, /aiTaskPollDelay\(pollAttempt\+\+\)/g);
});

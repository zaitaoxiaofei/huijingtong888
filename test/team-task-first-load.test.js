import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serviceSource = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
const viewSource = fs.readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");
const heatmapSource = fs.readFileSync(new URL("../frontend/admin/components/team/DevelopmentHeatmap.vue", import.meta.url), "utf8");

test("development overview skips unrelated data bootstrap and reuses the task-center payload", () => {
  assert.match(viewSource, /if \(value === "tasks"\) loadTaskPlanOrders\(\);\s*else if \(value !== "dashboard"\) loadDevelopmentData\(value\)/);
  assert.match(viewSource, /include_tasks=0/);
  assert.match(viewSource, /async function loadReviewDrafts\(/);
  assert.match(viewSource, /:initial-tasks="tasks" :initial-tasks-loaded="tasksLoaded"/);
  assert.match(heatmapSource, /if \(props\.initialTasksLoaded\) tasks\.value = props\.initialTasks; else load\(\)/);
});

test("team task reads schedule operational refresh outside the critical response path", () => {
  assert.match(serviceSource, /function scheduleOperationalTeamTaskRefresh\(\)/);
  assert.match(serviceSource, /\.catch\(\(\) => \{\}\)\s*\.finally\(\(\) => \{ operationalTasksRefreshPromise = null; \}\)/);
  assert.match(serviceSource, /scheduleOperationalTeamTaskRefresh\(\);\s*const where = \["t\.active = 1"\]/);
  assert.doesNotMatch(serviceSource, /await scheduleOperationalTeamTaskRefresh\(\)/);
});

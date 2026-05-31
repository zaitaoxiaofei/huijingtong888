import assert from "node:assert/strict";
import test from "node:test";

import {
  listScheduledJobs,
  registerScheduledJobs,
  runScheduledJobNow,
  scheduledJobRuns,
  scheduledJobSummary,
  updateScheduledJobConfig,
  updateScheduledJobState
} from "../src/services/scheduled-jobs.js";
import { closeMysqlPool, mysqlExecute } from "../src/mysql-pool.js";

const TEST_JOB_KEY = "test_scheduled_job_registry";

async function cleanup() {
  await mysqlExecute("DELETE FROM scheduled_job_runs WHERE job_key = ?", [TEST_JOB_KEY]);
  await mysqlExecute("DELETE FROM scheduled_jobs WHERE job_key = ?", [TEST_JOB_KEY]);
}

test("scheduled jobs can register, toggle, run manually, and record history", async () => {
  await cleanup();
  try {
    await registerScheduledJobs([{
      key: TEST_JOB_KEY,
      name: "Scheduled Job Registry Test",
      category: "maintenance",
      priority: "low",
      intervalMinutes: 60,
      enabled: true,
      catchupEnabled: true
    }]);

    let rows = await listScheduledJobs({ run_limit: 2 });
    let job = rows.find((item) => item.key === TEST_JOB_KEY);
    assert.ok(job);
    assert.equal(job.enabled, true);
    assert.equal(job.category, "maintenance");
    assert.equal(job.recentRuns.length, 0);

    const disabled = await updateScheduledJobState({ job_key: TEST_JOB_KEY, enabled: false });
    assert.equal(disabled.enabled, false);

    const enabled = await updateScheduledJobState({ job_key: TEST_JOB_KEY, enabled: true });
    assert.equal(enabled.enabled, true);

    const ran = await runScheduledJobNow(TEST_JOB_KEY, {
      [TEST_JOB_KEY]: async ({ key, mode }) => ({ ok: true, key, mode })
    }, "manual");
    assert.equal(ran.lastStatus, "success");
    assert.equal(ran.failCount, 0);
    assert.ok(ran.lastSuccessAt);

    const runs = await scheduledJobRuns({ job_key: TEST_JOB_KEY, limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].jobKey, TEST_JOB_KEY);
    assert.equal(runs[0].status, "success");
    assert.equal(runs[0].mode, "manual");

    rows = await listScheduledJobs({ run_limit: 2 });
    job = rows.find((item) => item.key === TEST_JOB_KEY);
    assert.equal(job.recentRuns.length, 1);
    assert.equal(job.recentRuns[0].status, "success");
  } finally {
    await cleanup();
    await closeMysqlPool();
  }
});

test("scheduled job config can be updated and summarized", async () => {
  await cleanup();
  try {
    await registerScheduledJobs([{
      key: TEST_JOB_KEY,
      name: "Scheduled Job Config Test",
      category: "maintenance",
      priority: "critical",
      intervalMinutes: 30,
      enabled: true,
      catchupEnabled: true
    }]);

    const updated = await updateScheduledJobConfig({
      job_key: TEST_JOB_KEY,
      scheduleType: "daily",
      dailyTime: "03:30",
      catchupEnabled: false,
      maxCatchupRuns: 0,
      config: {
        timeoutMinutes: 45,
        scope: "recent_window",
        days: 14
      }
    });

    assert.equal(updated.scheduleType, "daily");
    assert.equal(updated.dailyTime, "03:30");
    assert.equal(updated.catchupEnabled, false);
    assert.equal(updated.maxCatchupRuns, 0);
    assert.equal(updated.config.timeoutMinutes, 45);
    assert.equal(updated.config.scope, "recent_window");
    assert.equal(updated.config.days, 14);

    await mysqlExecute(`
      UPDATE scheduled_jobs
      SET last_status = 'failed', fail_count = 2, last_error = 'mock failure', next_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
      WHERE job_key = ?
    `, [TEST_JOB_KEY]);

    const summary = await scheduledJobSummary();
    assert.ok(summary.failedCount >= 1);
    assert.ok(summary.dueCount >= 1);
    assert.ok(summary.failedJobs.some((job) => job.key === TEST_JOB_KEY));
  } finally {
    await cleanup();
    await closeMysqlPool();
  }
});

test("skipped runs do not overwrite the last meaningful job status", async () => {
  await cleanup();
  try {
    await registerScheduledJobs([{
      key: TEST_JOB_KEY,
      name: "Scheduled Job Skip Preservation Test",
      category: "maintenance",
      priority: "low",
      intervalMinutes: 30,
      enabled: true,
      catchupEnabled: true
    }]);

    const partial = await runScheduledJobNow(TEST_JOB_KEY, {
      [TEST_JOB_KEY]: async () => ({ status: "partial", warning: "1 shop failed" })
    }, "manual");
    assert.equal(partial.lastStatus, "partial");
    assert.equal(partial.lastError, "1 shop failed");

    const skipped = await runScheduledJobNow(TEST_JOB_KEY, {
      [TEST_JOB_KEY]: async () => ({ skipped: true, reason: "already_running", retryDelaySeconds: 60 })
    }, "manual");
    assert.equal(skipped.lastStatus, "partial");
    assert.equal(skipped.lastError, "1 shop failed");

    const runs = await scheduledJobRuns({ job_key: TEST_JOB_KEY, limit: 5 });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, "skipped");
    assert.equal(runs[1].status, "partial");
  } finally {
    await cleanup();
    await closeMysqlPool();
  }
});

test("stale running rows are reset before starting a new run", async () => {
  await cleanup();
  try {
    await registerScheduledJobs([{
      key: TEST_JOB_KEY,
      name: "Scheduled Job Stale Run Test",
      category: "maintenance",
      priority: "low",
      intervalMinutes: 30,
      enabled: true,
      catchupEnabled: true
    }]);

    await mysqlExecute(`
      INSERT INTO scheduled_job_runs (job_key, planned_for, started_at, status, mode)
      VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR), 'running', 'scheduled')
    `, [TEST_JOB_KEY]);

    const ran = await runScheduledJobNow(TEST_JOB_KEY, {
      [TEST_JOB_KEY]: async () => ({ ok: true })
    }, "manual");
    assert.equal(ran.lastStatus, "success");

    const runs = await scheduledJobRuns({ job_key: TEST_JOB_KEY, limit: 5 });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, "success");
    assert.equal(runs[1].status, "failed");
    assert.equal(runs[1].errorMessage, "stale running scheduled job was reset automatically");
  } finally {
    await cleanup();
    await closeMysqlPool();
  }
});

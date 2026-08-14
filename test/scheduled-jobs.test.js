import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupScheduledJobHistory,
  listScheduledJobs,
  registerScheduledJobs,
  runScheduledJobNow,
  ScheduledJobScheduler,
  scheduledJobRuns,
  scheduledJobSummary,
  updateScheduledJobConfig,
  updateScheduledJobState
} from "../src/services/scheduled-jobs.js";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";

const TEST_JOB_KEY = "test_scheduled_job_registry";

async function cleanup() {
  await mysqlExecute("DELETE FROM scheduled_job_run_events WHERE job_key = ?", [TEST_JOB_KEY]);
  await mysqlExecute("DELETE FROM scheduled_job_runs WHERE job_key = ?", [TEST_JOB_KEY]);
  await mysqlExecute("DELETE FROM scheduled_jobs WHERE job_key = ?", [TEST_JOB_KEY]);
}

test("scheduled history cleanup keeps recent failures and manual audit runs", async () => {
  await cleanup();
  try {
    await mysqlExecute(`
      INSERT INTO scheduled_job_runs (job_key, started_at, finished_at, status, mode)
      VALUES
        (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), 'success', 'scheduled'),
        (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), 'failed', 'scheduled'),
        (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), 'success', 'manual'),
        (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), 'failed', 'manual')
    `, [TEST_JOB_KEY, TEST_JOB_KEY, TEST_JOB_KEY, TEST_JOB_KEY]);
    const runs = await mysqlQuery("SELECT id, status FROM scheduled_job_runs WHERE job_key = ? ORDER BY id", [TEST_JOB_KEY]);
    await mysqlExecute(`
      INSERT INTO scheduled_job_run_events (run_id, job_key, step_key, status, message, created_at)
      VALUES
        (?, ?, 'complete', 'success', 'ordinary success', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY)),
        (?, ?, 'failed', 'error', 'recent failure', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY)),
        (?, ?, 'failed', 'error', 'expired failure', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY))
    `, [runs[0].id, TEST_JOB_KEY, runs[1].id, TEST_JOB_KEY, runs[3].id, TEST_JOB_KEY]);

    const result = await cleanupScheduledJobHistory({
      successDays: 14,
      detailDays: 90,
      batchSize: 100,
      jobKey: TEST_JOB_KEY
    });
    assert.equal(result.scheduledSuccessRunsDeleted, 1);
    assert.equal(result.expiredRunsDeleted, 1);
    assert.equal(result.ordinaryEventsDeleted, 1);
    assert.equal(result.expiredEventsDeleted, 1);

    const remainingRuns = await mysqlQuery("SELECT status, mode FROM scheduled_job_runs WHERE job_key = ? ORDER BY id", [TEST_JOB_KEY]);
    assert.deepEqual(remainingRuns.map((row) => [row.status, row.mode]), [["failed", "scheduled"], ["success", "manual"]]);
    const remainingEvents = await mysqlQuery("SELECT status, message FROM scheduled_job_run_events WHERE job_key = ?", [TEST_JOB_KEY]);
    assert.deepEqual(remainingEvents.map((row) => [row.status, row.message]), [["error", "recent failure"]]);
  } finally {
    await cleanup();
    await closeMysqlPool();
  }
});

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

test("foreground deferral reschedules a scheduled job without creating a run record", async () => {
  await cleanup();
  try {
    await registerScheduledJobs([{
      key: TEST_JOB_KEY,
      name: "Scheduled Job Foreground Deferral Test",
      category: "maintenance",
      priority: "low",
      intervalMinutes: 30,
      enabled: true,
      catchupEnabled: true
    }]);
    const [job] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [TEST_JOB_KEY]);
    const lockId = "foreground-deferral-test";
    await mysqlExecute("UPDATE scheduled_jobs SET locked_at = UTC_TIMESTAMP(), locked_by = ? WHERE id = ?", [lockId, job.id]);
    const scheduler = new ScheduledJobScheduler({
      handlers: {
        [TEST_JOB_KEY]: async () => {
          throw new Error("deferred handler must not run");
        }
      },
      beforeRun: () => ({ skipped: true, reason: "foreground_api_recent", retryDelaySeconds: 60 })
    });
    await scheduler.runClaimedJob({ ...job, locked_by: lockId }, "scheduled");

    const runs = await scheduledJobRuns({ job_key: TEST_JOB_KEY, limit: 5 });
    assert.equal(runs.length, 0);
    const [updated] = await mysqlQuery("SELECT locked_by, next_run_at FROM scheduled_jobs WHERE job_key = ? LIMIT 1", [TEST_JOB_KEY]);
    assert.equal(updated.locked_by, null);
    assert.ok(updated.next_run_at);
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

test("scheduled job claim order includes an overdue fairness bucket before priority", () => {
  const source = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  assert.match(source, /WHEN next_run_at <= DATE_SUB\(\?, INTERVAL 120 MINUTE\) THEN 0/);
  assert.match(source, /FIELD\(priority, 'critical', 'high', 'normal', 'low'\)/);
});

test("Ozon action cleanup is scheduled as a critical 5 minute profit guard", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /const OZON_ACTION_CLEANUP_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(source, /key: "ozon_action_cleanup"[\s\S]*category: "profit_guard"[\s\S]*priority: "critical"/);
});

test("hosted ERP logs use bounded rotation instead of unbounded shell append", () => {
  const startScript = readFileSync(new URL("../deploy/windows-host/start-erp-server.ps1", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../deploy/windows-host/run-erp-server.mjs", import.meta.url), "utf8");
  assert.match(startScript, /run-erp-server\.mjs/);
  assert.doesNotMatch(startScript, /1>>/);
  assert.match(runner, /ERP_LOG_MAX_MB \|\| 20/);
  assert.match(runner, /ERP_LOG_ARCHIVES \|\| 7/);
});

test("scheduler polling does not wait for long-running jobs to finish", () => {
  const source = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  const tickSource = source.match(/async tick\(mode = "scheduled"\)[\s\S]*?\n  }\n\n  async runClaimedJob/)?.[0] || "";
  assert.match(tickSource, /void this\.runClaimedJob\(job, mode\)\.catch/);
  assert.doesNotMatch(tickSource, /await Promise\.all/);
  assert.match(tickSource, /this\.scheduleNext\(\)/);
});

test("scheduler claims due work across module categories before filling duplicate lanes", () => {
  const source = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  const claimSource = source.match(/async function claimDueJobs[\s\S]*?\n}\n\nasync function startRun/)?.[0] || "";
  assert.match(claimSource, /Math\.max\(limit, limit \* 4\)/);
  assert.match(claimSource, /const selectedCategories = new Set\(\)/);
  assert.match(claimSource, /if \(selectedCategories\.has\(category\)\) continue/);
  assert.match(claimSource, /for \(const row of selectedRows\)/);
});

test("scheduled job lock expiry can calculate times in the past", () => {
  const source = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  const addMinutesSource = source.match(/function addMinutes\(date, minutes\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(addMinutesSource, /Number\.isFinite\(normalizedMinutes\) \? normalizedMinutes : 0/);
  assert.doesNotMatch(addMinutesSource, /Math\.max\(1/);
  assert.match(source, /addMinutes\(now, -DEFAULT_LOCK_TTL_MINUTES\)/);
});

test("scheduler startup releases runs interrupted by the previous service process", () => {
  const scheduledSource = readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(scheduledSource, /export async function recoverInterruptedScheduledJobRuns\(\)/);
  assert.match(scheduledSource, /scheduled job interrupted by service restart/);
  assert.match(scheduledSource, /SET locked_at = NULL,[\s\S]*locked_by = NULL/);
  assert.match(serverSource, /registerScheduledJobs\(scheduledJobDefinitions\)[\s\S]*recoverInterruptedScheduledJobRuns\(\)[\s\S]*scheduledJobScheduler\.start\(\)/);
});

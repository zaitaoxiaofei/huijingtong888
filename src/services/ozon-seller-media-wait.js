function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobIdentifier(job = {}) {
  return String(job.mediaJobId || job.media_job_id || job.id || "").trim();
}

function uploadedUrl(job = {}) {
  return String(job.uploadedUrl || job.uploaded_url || job.url || "").trim();
}

function mergeJobs(expectedIds, previousJobs, refreshedJobs) {
  const byId = new Map();
  for (const job of [...previousJobs, ...refreshedJobs]) {
    const id = jobIdentifier(job);
    if (id) byId.set(id, job);
  }
  return expectedIds.map((id) => byId.get(id) || { id, mediaJobId: id, status: "missing" });
}

function mediaWaitError(message, code, jobs) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  error.jobs = jobs;
  error.pending = jobs.filter((job) => String(job.status || "") !== "uploaded");
  return error;
}

export async function waitForOzonSellerMediaJobs(initialJobs = [], {
  loadJobs,
  timeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 1500,
  maxPollIntervalMs = 5000,
  waitImpl = wait,
  nowImpl = Date.now
} = {}) {
  if (typeof loadJobs !== "function") throw new TypeError("loadJobs is required");
  const expectedIds = [...new Set(initialJobs.map(jobIdentifier).filter(Boolean))];
  if (!expectedIds.length) return [];
  const startedAt = nowImpl();
  let jobs = mergeJobs(expectedIds, [], initialJobs);
  let delayMs = Math.max(100, Number(pollIntervalMs || 1500));

  while (true) {
    const refreshed = await loadJobs(expectedIds);
    jobs = mergeJobs(expectedIds, jobs, Array.isArray(refreshed) ? refreshed : []);
    const failed = jobs.filter((job) => String(job.status || "") === "failed");
    if (failed.length) {
      throw mediaWaitError(
        `Ozon seller media upload failed for ${failed.length} file(s)`,
        "OZON_SELLER_MEDIA_UPLOAD_FAILED",
        jobs
      );
    }
    if (jobs.every((job) => String(job.status || "") === "uploaded" && uploadedUrl(job))) {
      return jobs;
    }
    if (nowImpl() - startedAt >= Math.max(1000, Number(timeoutMs || 0))) {
      throw mediaWaitError(
        "Ozon seller media upload did not finish before the publish timeout",
        "OZON_SELLER_MEDIA_UPLOAD_TIMEOUT",
        jobs
      );
    }
    await waitImpl(delayMs);
    delayMs = Math.min(Number(maxPollIntervalMs || 5000), Math.ceil(delayMs * 1.35));
  }
}

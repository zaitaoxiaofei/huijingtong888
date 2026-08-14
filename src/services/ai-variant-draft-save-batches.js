import { randomUUID } from "node:crypto";
import { executeMysqlStatementWithRetry, getMysqlPoolMetrics, mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { createAiVariantListingDraftLightweight, generateListingOfferId } from "./listing-automation.js";

const WORKER_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.AI_VARIANT_DRAFT_SAVE_CONCURRENCY || 8)));
const BATCH_INSERT_CHUNK_SIZE = 20;
let schemaReady = false;
let workerStarted = false;
let workerTimer = null;
let activeWorkers = 0;
const pendingBatchRefreshes = new Map();

export async function ensureAiVariantDraftSaveBatchSchema() {
  if (schemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_draft_save_batches (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      batch_no VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      total_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_variant_draft_save_batch_no (batch_no),
      INDEX idx_ai_variant_draft_save_batch_owner (created_by_person_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_draft_save_items (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      item_no VARCHAR(96) NOT NULL,
      batch_no VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      stage VARCHAR(64) NOT NULL DEFAULT 'queued',
      progress_percent INT NOT NULL DEFAULT 0,
      payload_json LONGTEXT NOT NULL,
      result_draft_id BIGINT NULL,
      shop_copy_count INT NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_by_person_id BIGINT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_variant_draft_save_item_no (item_no),
      INDEX idx_ai_variant_draft_save_item_batch (batch_no, id),
      INDEX idx_ai_variant_draft_save_item_queue (status, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  schemaReady = true;
}

export async function createAiVariantDraftSaveBatch(body = {}, session = null) {
  await ensureAiVariantDraftSaveBatchSchema();
  const payloads = Array.isArray(body.items) ? body.items.filter((item) => item && typeof item === "object") : [];
  if (!payloads.length) throw statusError("请至少选择一个要保存的草稿", 400);
  if (payloads.length > 200) throw statusError("单次最多保存 200 个草稿", 400);
  const batchNo = `AVD-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const personId = Number(session?.personId || session?.id || 0) || null;
  await withMysqlTransaction(async (connection) => {
    await executeMysqlStatementWithRetry(connection, `INSERT INTO ai_variant_draft_save_batches
      (batch_no, status, total_count, created_by_person_id) VALUES (?, 'queued', ?, ?)`, [batchNo, payloads.length, personId]);
    for (let offset = 0; offset < payloads.length; offset += BATCH_INSERT_CHUNK_SIZE) {
      const chunk = payloads.slice(offset, offset + BATCH_INSERT_CHUNK_SIZE);
      const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      const params = chunk.flatMap((payload, index) => [
        `${batchNo}-${offset + index + 1}`,
        batchNo,
        JSON.stringify(payload),
        personId
      ]);
      await executeMysqlStatementWithRetry(connection, `INSERT INTO ai_variant_draft_save_items
        (item_no, batch_no, payload_json, created_by_person_id) VALUES ${placeholders}`, params);
    }
  });
  startAiVariantDraftSaveBatchWorker();
  scheduleWorker(10);
  return {
    batch_no: batchNo,
    status: "queued",
    total_count: payloads.length,
    success_count: 0,
    failed_count: 0,
    items: []
  };
}

export async function aiVariantDraftSaveBatchDetail(batchNo = "", session = null) {
  await ensureAiVariantDraftSaveBatchSchema();
  const owner = Number(session?.personId || session?.id || 0) || 0;
  const params = [String(batchNo || ""), ...(owner ? [owner] : [])];
  const rows = await mysqlQuery(`SELECT * FROM ai_variant_draft_save_batches WHERE batch_no = ?${owner ? " AND created_by_person_id = ?" : ""} LIMIT 1`, params);
  if (!rows.length) throw statusError("草稿保存批次不存在", 404);
  const items = await mysqlQuery(`SELECT item_no, status, stage, progress_percent, result_draft_id,
    shop_copy_count, error_message, attempts
    FROM ai_variant_draft_save_items WHERE batch_no = ? ORDER BY id`, [batchNo]);
  return { ...mapBatch(rows[0]), items: items.map(mapItem) };
}

export async function retryAiVariantDraftSaveItem(itemNo = "", session = null) {
  await ensureAiVariantDraftSaveBatchSchema();
  const owner = Number(session?.personId || session?.id || 0) || 0;
  await mysqlExecute(`UPDATE ai_variant_draft_save_items SET status = 'queued', stage = 'queued', progress_percent = 0,
    error_message = NULL, finished_at = NULL WHERE item_no = ? AND status = 'failed'${owner ? " AND created_by_person_id = ?" : ""}`,
  [itemNo, ...(owner ? [owner] : [])]);
  startAiVariantDraftSaveBatchWorker();
  scheduleWorker(10);
  return { ok: true };
}

export async function recoverAiVariantDraftSaveBatchesOnStartup() {
  await ensureAiVariantDraftSaveBatchSchema();
  await mysqlExecute("UPDATE ai_variant_draft_save_items SET status = 'queued', stage = 'queued', progress_percent = 0 WHERE status = 'running'");
  startAiVariantDraftSaveBatchWorker();
  scheduleWorker(100);
  return { ok: true };
}

export function startAiVariantDraftSaveBatchWorker() {
  if (workerStarted) return;
  workerStarted = true;
  scheduleWorker(100);
}

function scheduleWorker(delay = 1200) {
  if (workerTimer) return;
  workerTimer = setTimeout(async () => {
    workerTimer = null;
    try { await processQueuedItems(); } catch (error) { console.warn("[ai-variant-draft-save] worker failed", error); }
    finally { if (workerStarted) scheduleWorker(); }
  }, delay);
  workerTimer.unref?.();
}

async function processQueuedItems() {
  const concurrency = adaptiveDraftSaveConcurrency();
  while (activeWorkers < concurrency) {
    const item = await claimNextDraftSaveItem();
    if (!item) return;
    activeWorkers += 1;
    void executeClaimedItem(item).finally(() => {
      activeWorkers -= 1;
      scheduleWorker(10);
    });
  }
}

async function claimNextDraftSaveItem() {
  const claimToken = `claim:${process.pid}:${randomUUID()}`;
  const claimed = await mysqlExecute(`UPDATE ai_variant_draft_save_items
    SET status = 'running', stage = 'creating_draft', progress_percent = 40,
        error_message = ?, attempts = attempts + 1,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE status = 'queued'
    ORDER BY created_at, id
    LIMIT 1`, [claimToken]);
  if (!claimed.affectedRows) return null;
  const rows = await mysqlQuery("SELECT * FROM ai_variant_draft_save_items WHERE status = 'running' AND error_message = ? LIMIT 1", [claimToken]);
  return rows[0] || null;
}

function adaptiveDraftSaveConcurrency() {
  const memory = process.memoryUsage();
  const rssMb = memory.rss / 1024 / 1024;
  const pool = getMysqlPoolMetrics();
  let limit = WORKER_CONCURRENCY;
  if (rssMb >= 1400) limit = 1;
  else if (rssMb >= 1100) limit = Math.min(limit, 2);
  else if (rssMb >= 850) limit = Math.min(limit, 4);
  else if (rssMb >= 650) limit = Math.min(limit, 6);
  if (pool.activeConnections >= pool.connectionLimit - 1) limit = Math.min(limit, 1);
  else if (pool.activeConnections >= pool.connectionLimit - 3) limit = Math.min(limit, 3);
  return Math.max(1, limit);
}

async function executeClaimedItem(item) {
  const session = { personId: Number(item.created_by_person_id || 0) || null };
  try {
    const payload = JSON.parse(item.payload_json || "{}");
    const draft = await createWithOfferRetry(payload, session);
    const draftId = Number(draft.id || draft.draft_id || 0) || null;
    await mysqlExecute("UPDATE ai_variant_draft_save_items SET status = 'completed', stage = 'completed', progress_percent = 100, result_draft_id = ?, shop_copy_count = ?, payload_json = '{}', finished_at = CURRENT_TIMESTAMP WHERE id = ?", [draftId, Number(draft.shop_copy_count || draft.shop_copies?.length || 0), item.id]);
  } catch (error) {
    await mysqlExecute("UPDATE ai_variant_draft_save_items SET status = 'failed', stage = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [String(error?.message || error || "保存草稿失败").slice(0, 2000), item.id]);
  } finally {
    scheduleBatchRefresh(item.batch_no);
  }
}

function scheduleBatchRefresh(batchNo, delay = 150) {
  const key = String(batchNo || "");
  if (!key || pendingBatchRefreshes.has(key)) return;
  const timer = setTimeout(() => {
    pendingBatchRefreshes.delete(key);
    void refreshBatch(key).catch((error) => console.warn("[ai-variant-draft-save] batch refresh failed", error));
  }, delay);
  timer.unref?.();
  pendingBatchRefreshes.set(key, timer);
}

async function createWithOfferRetry(payload, session) {
  try {
    return await createAiVariantListingDraftLightweight(payload, session);
  } catch (error) {
    if (!/offer[_\s-]*id|货号/i.test(error?.message || "") || !/已存在|重复|exist|duplicate|used|not unique/i.test(error?.message || "")) throw error;
    const generated = await generateListingOfferId({ prefix: String(payload.offer_prefix || "VAR").trim() || "VAR", existingIds: [] }, session);
    const offerId = generated.offerId;
    const retryPayload = { ...payload, offer_id: offerId, internal_code: offerId, patch: { ...(payload.patch || {}), offer_id: offerId, internal_code: offerId } };
    return createAiVariantListingDraftLightweight(retryPayload, session);
  }
}

async function refreshBatch(batchNo) {
  const rows = await mysqlQuery(`SELECT COUNT(*) total_count, SUM(status = 'completed') success_count, SUM(status = 'failed') failed_count, SUM(status IN ('queued', 'running')) active_count FROM ai_variant_draft_save_items WHERE batch_no = ?`, [batchNo]);
  const stats = rows[0] || {};
  const status = Number(stats.active_count || 0) ? "running" : Number(stats.failed_count || 0) && Number(stats.success_count || 0) ? "partial" : Number(stats.failed_count || 0) ? "failed" : "completed";
  await mysqlExecute("UPDATE ai_variant_draft_save_batches SET status = ?, total_count = ?, success_count = ?, failed_count = ? WHERE batch_no = ?", [status, Number(stats.total_count || 0), Number(stats.success_count || 0), Number(stats.failed_count || 0), batchNo]);
}

function mapBatch(row = {}) { return { batch_no: row.batch_no, status: row.status, total_count: Number(row.total_count || 0), success_count: Number(row.success_count || 0), failed_count: Number(row.failed_count || 0), created_at: row.created_at, updated_at: row.updated_at }; }
function mapItem(row = {}) { return { item_no: row.item_no, status: row.status, stage: row.stage, progress_percent: Number(row.progress_percent || 0), result_draft_id: Number(row.result_draft_id || 0) || null, shop_copy_count: Number(row.shop_copy_count || 0), error_message: row.error_message || "", attempts: Number(row.attempts || 0) }; }
function statusError(message, status) { const error = new Error(message); error.status = status; return error; }

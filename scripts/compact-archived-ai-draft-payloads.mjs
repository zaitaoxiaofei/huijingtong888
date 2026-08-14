import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import OSS from "ali-oss";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { ossStorageConfig } from "../src/services/object-storage.js";

const WRITE = process.argv.includes("--write");
const HASH_ARG = process.argv.find((item) => item.startsWith("--archive-sha256="));
const ARCHIVE_SHA256 = String(HASH_ARG?.split("=")[1] || "").trim().toLowerCase();
const BATCH_SIZE = Math.min(Math.max(Number(process.env.AI_DRAFT_COMPACT_BATCH_SIZE || 5), 1), 20);
const PREFIX = "database-archives/ai-variant-draft-save-items";

function payloadHash(value) {
  return crypto.createHash("sha256").update(String(value || "{}")).digest("hex");
}

async function downloadArchive(filePath) {
  if (!/^[a-f0-9]{64}$/.test(ARCHIVE_SHA256)) throw new Error("A valid --archive-sha256 is required");
  const storage = ossStorageConfig();
  if (!storage.enabled) throw new Error("OSS is not enabled");
  const client = new OSS({
    region: storage.region, bucket: storage.bucket, accessKeyId: storage.accessKeyId,
    accessKeySecret: storage.accessKeySecret, stsToken: storage.stsToken || undefined,
    secure: true, timeout: 60000
  });
  const objectKey = `${PREFIX}/${ARCHIVE_SHA256}.ndjson.gz`;
  await client.get(objectKey, filePath);
  return { bucket: storage.bucket, objectKey };
}

async function readManifest(filePath) {
  const stream = fs.createReadStream(filePath).pipe(createGunzip());
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const contentHash = crypto.createHash("sha256");
  const rows = [];
  for await (const line of lines) {
    if (!line) continue;
    contentHash.update(`${line}\n`);
    const row = JSON.parse(line);
    rows.push({ id: Number(row.id), resultDraftId: Number(row.result_draft_id), payloadHash: payloadHash(JSON.stringify(row.payload)) });
  }
  const contentSha256 = contentHash.digest("hex");
  if (contentSha256 !== ARCHIVE_SHA256) throw new Error(`Archive content hash mismatch: ${contentSha256}`);
  return rows;
}

async function validateCandidates(manifestRows) {
  const valid = [];
  const rejected = [];
  for (let offset = 0; offset < manifestRows.length; offset += BATCH_SIZE) {
    const batch = manifestRows.slice(offset, offset + BATCH_SIZE);
    const rows = await mysqlQuery(`
      SELECT i.id, i.status, i.result_draft_id, i.payload_json, d.id AS draft_exists
      FROM ai_variant_draft_save_items i
      LEFT JOIN listing_drafts d ON d.id = i.result_draft_id
      WHERE i.id IN (${batch.map(() => "?").join(",")})
    `, batch.map((row) => row.id));
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    for (const archived of batch) {
      const current = byId.get(archived.id);
      const reason = !current ? "missing_row"
        : current.status !== "completed" ? "not_completed"
        : !current.draft_exists ? "missing_result_draft"
        : String(current.payload_json || "{}") === "{}" ? "already_compacted"
        : Number(current.result_draft_id) !== archived.resultDraftId ? "result_draft_changed"
        : payloadHash(current.payload_json) !== archived.payloadHash ? "payload_changed"
        : "";
      if (reason) rejected.push({ id: archived.id, reason });
      else valid.push(archived.id);
    }
  }
  return { valid, rejected };
}

async function compact(validIds) {
  let updated = 0;
  for (let offset = 0; offset < validIds.length; offset += BATCH_SIZE) {
    const ids = validIds.slice(offset, offset + BATCH_SIZE);
    const result = await mysqlExecute(`
      UPDATE ai_variant_draft_save_items
      SET payload_json = '{}'
      WHERE status = 'completed' AND payload_json <> '{}'
        AND id IN (${ids.map(() => "?").join(",")})
    `, ids);
    updated += Number(result.affectedRows || 0);
  }
  return updated;
}

export async function compactArchivedAiDraftPayloads() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ozon-ai-draft-compact-"));
  const archivePath = path.join(tempDir, "archive.ndjson.gz");
  try {
    const object = await downloadArchive(archivePath);
    const manifestRows = await readManifest(archivePath);
    const validation = await validateCandidates(manifestRows);
    const plan = {
      mode: WRITE ? "write" : "dry-run", archiveSha256: ARCHIVE_SHA256, ...object,
      archivedRows: manifestRows.length, eligibleRows: validation.valid.length,
      rejectedRows: validation.rejected.length, rejected: validation.rejected.slice(0, 20), batchSize: BATCH_SIZE
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!WRITE) return plan;
    if (validation.rejected.length) throw new Error("Archive validation has rejected rows; refusing partial compaction");
    const updatedRows = await compact(validation.valid);
    if (updatedRows !== validation.valid.length) throw new Error(`Compaction count mismatch: ${updatedRows}`);
    const result = { ...plan, updatedRows };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

compactArchivedAiDraftPayloads()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(() => closeMysqlPool());

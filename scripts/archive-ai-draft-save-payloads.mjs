import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import OSS from "ali-oss";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { ossStorageConfig } from "../src/services/object-storage.js";

const WRITE = process.argv.includes("--write");
const BATCH_SIZE = Math.min(Math.max(Number(process.env.AI_DRAFT_ARCHIVE_BATCH_SIZE || 5), 1), 20);
const PREFIX = "database-archives/ai-variant-draft-save-items";

async function eligibleSummary() {
  const rows = await mysqlQuery(`
    SELECT COUNT(*) AS row_count, COALESCE(SUM(OCTET_LENGTH(i.payload_json)), 0) AS payload_bytes,
      MIN(i.id) AS min_id, MAX(i.id) AS max_id
    FROM ai_variant_draft_save_items i
    JOIN listing_drafts d ON d.id = i.result_draft_id
    WHERE i.status = 'completed' AND i.payload_json <> '{}'
  `);
  return rows[0] || {};
}

async function writeLine(stream, hash, value) {
  const line = `${JSON.stringify(value)}\n`;
  hash.update(line);
  if (!stream.write(line, "utf8")) await once(stream, "drain");
}

async function buildArchive(filePath) {
  const output = fs.createWriteStream(filePath, { flags: "wx" });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  const hash = crypto.createHash("sha256");
  let cursor = 0;
  let rowCount = 0;
  let payloadBytes = 0;
  for (;;) {
    const rows = await mysqlQuery(`
      SELECT i.id, i.item_no, i.batch_no, i.result_draft_id, i.created_at, i.finished_at, i.payload_json
      FROM ai_variant_draft_save_items i
      JOIN listing_drafts d ON d.id = i.result_draft_id
      WHERE i.status = 'completed' AND i.payload_json <> '{}' AND i.id > ?
      ORDER BY i.id LIMIT ?
    `, [cursor, BATCH_SIZE]);
    if (!rows.length) break;
    for (const row of rows) {
      const payloadText = String(row.payload_json || "{}");
      JSON.parse(payloadText);
      await writeLine(gzip, hash, {
        id: Number(row.id), item_no: row.item_no, batch_no: row.batch_no,
        result_draft_id: Number(row.result_draft_id), created_at: row.created_at,
        finished_at: row.finished_at, payload: JSON.parse(payloadText)
      });
      rowCount += 1;
      payloadBytes += Buffer.byteLength(payloadText);
      cursor = Number(row.id);
    }
  }
  gzip.end();
  await once(output, "close");
  const stat = await fsp.stat(filePath);
  return { rowCount, payloadBytes, compressedBytes: stat.size, contentSha256: hash.digest("hex") };
}

async function uploadArchive(filePath, manifest) {
  const storage = ossStorageConfig();
  if (!storage.enabled) throw new Error("OSS is not enabled");
  const objectKey = `${PREFIX}/${manifest.contentSha256}.ndjson.gz`;
  const client = new OSS({
    region: storage.region, bucket: storage.bucket, accessKeyId: storage.accessKeyId,
    accessKeySecret: storage.accessKeySecret, stsToken: storage.stsToken || undefined,
    secure: true, timeout: 60000
  });
  await client.multipartUpload(objectKey, filePath, {
    partSize: 1024 * 1024,
    parallel: 2,
    headers: { "Content-Type": "application/gzip" }
  });
  const head = await client.head(objectKey);
  const remoteBytes = Number(head?.res?.headers?.["content-length"] || head?.meta?.size || 0);
  if (remoteBytes !== manifest.compressedBytes) throw new Error(`OSS size mismatch: ${remoteBytes} != ${manifest.compressedBytes}`);
  return { bucket: storage.bucket, objectKey, remoteBytes };
}

export async function archiveAiDraftSavePayloads() {
  const summary = await eligibleSummary();
  const plan = {
    mode: WRITE ? "archive-only" : "dry-run",
    eligibleRows: Number(summary.row_count || 0),
    payloadBytes: Number(summary.payload_bytes || 0),
    minId: Number(summary.min_id || 0),
    maxId: Number(summary.max_id || 0),
    batchSize: BATCH_SIZE,
    databaseMutation: false
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!WRITE || !plan.eligibleRows) return plan;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ozon-ai-draft-archive-"));
  const filePath = path.join(tempDir, "payloads.ndjson.gz");
  try {
    const manifest = await buildArchive(filePath);
    if (manifest.rowCount !== plan.eligibleRows || manifest.payloadBytes !== plan.payloadBytes) {
      throw new Error("Archive source changed while exporting; retry without modifying MySQL");
    }
    const uploaded = await uploadArchive(filePath, manifest);
    const result = { ...plan, ...manifest, ...uploaded };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

archiveAiDraftSavePayloads()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(() => closeMysqlPool());

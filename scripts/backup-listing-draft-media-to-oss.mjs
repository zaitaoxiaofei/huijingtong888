import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import {
  canonicalMediaSource,
  mediaSourceFingerprint,
  markMediaMigrationFailed,
  markMediaMigrationVerified,
  registerMediaMigrationSource,
  resolvePreferredMediaUrl
} from "../src/services/media-migration-map.js";
import {
  archiveRemoteMediaObjectUrl,
  isManagedOssObjectUrl,
  ossStorageConfig,
  putContentAddressedObject
} from "../src/services/object-storage.js";

const ROOT_DIR = path.resolve(process.cwd());
const WRITE = process.argv.includes("--write");
const REPORT_STATUS = process.argv.includes("--status");
const NEWEST_FIRST = process.argv.includes("--newest-first");
const SKIP_FAILED = process.argv.includes("--skip-failed");
const QUIET = process.argv.includes("--quiet");
const CONCURRENCY_ARG = process.argv.find((item) => item.startsWith("--concurrency="));
const CONCURRENCY = Math.min(Math.max(Number(CONCURRENCY_ARG?.split("=")[1] || 1), 1), 12);
const LIMIT_ARG = process.argv.find((item) => item.startsWith("--limit="));
const LIMIT = Math.min(Math.max(Number(LIMIT_ARG?.split("=")[1] || 500), 1), 5000);
const OFFSET_ARG = process.argv.find((item) => item.startsWith("--offset="));
const OFFSET = Math.max(Number(OFFSET_ARG?.split("=")[1] || 0), 0);
const MAX_LOCAL_BYTES = 100 * 1024 * 1024;
const MEDIA_PATTERN = /(?:https?:\/\/[^\s"'<>\\]+|\/uploads\/[^\s"'<>\\]+)/gi;
const MEDIA_EXTENSION_PATTERN = /\.(?:avif|gif|jpe?g|png|webp|bmp|svg|mp4|webm|mov|m4v)(?:[?#]|$)/i;

function isDraftMediaReference(value = "") {
  const source = String(value || "").trim();
  return /^\/?uploads\//i.test(source) || MEDIA_EXTENSION_PATTERN.test(source);
}

export function extractDraftMediaReferences(row = {}) {
  const values = [
    row.source_images_json,
    row.template_payload_json,
    row.manual_facts_json,
    row.ai_payload_json
  ];
  const found = [];
  for (const value of values) {
    const text = typeof value === "string" ? value : JSON.stringify(value || "");
    found.push(...(text.match(MEDIA_PATTERN) || []));
  }
  return [...new Set(found
    .map((item) => item.replace(/[),\]}]+$/g, ""))
    .filter(isDraftMediaReference))];
}

function safeUploadsRelativePath(reference = "") {
  let pathname = String(reference || "");
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname;
  } catch {
    return "";
  }
  pathname = decodeURIComponent(pathname.split(/[?#]/, 1)[0]).replace(/\\/g, "/");
  const marker = "/uploads/";
  const index = pathname.toLowerCase().indexOf(marker);
  if (index < 0) return "";
  const relative = pathname.slice(index + marker.length);
  if (!relative || relative.split("/").includes("..")) return "";
  return relative;
}

export async function resolveDraftLocalMediaPath(reference, rootDir = ROOT_DIR) {
  const relative = safeUploadsRelativePath(reference);
  if (!relative) return "";
  const uploadRoots = [
    path.resolve(rootDir, "uploads"),
    path.resolve(rootDir, "public", "uploads"),
    path.resolve(rootDir, "dist", "live", "uploads"),
    path.resolve(rootDir, "dist", "live", "public", "uploads")
  ];
  const candidates = uploadRoots.map((uploadRoot) => path.resolve(uploadRoot, relative));
  for (const candidate of candidates) {
    if (!uploadRoots.some((root) => candidate.startsWith(`${root}${path.sep}`))) continue;
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

function contentTypeFor(filePath = "") {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"
  })[extension] || "application/octet-stream";
}

async function verifyPublicMediaUrl(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`OSS 公网校验失败：HTTP ${response.status}`);
}

async function backupReference(reference, context) {
  const sourceUrl = canonicalMediaSource(reference);
  await registerMediaMigrationSource({ sourceUrl, ...context });
  try {
    if (SKIP_FAILED) {
      const existingRows = await mysqlQuery(`
        SELECT status, oss_url FROM media_migration_map
        WHERE source_fingerprint = ? LIMIT 1
      `, [mediaSourceFingerprint(sourceUrl)]);
      if (existingRows[0]?.status === "verified" && existingRows[0]?.oss_url) {
        return { ok: true, sourceUrl, ossUrl: existingRows[0].oss_url, reused: true };
      }
      if (existingRows[0]?.status === "failed") {
        return { ok: false, sourceUrl, skipped: true, error: "已失败项留待单独重试" };
      }
    }
    const existingUrl = await resolvePreferredMediaUrl(sourceUrl);
    if (existingUrl && existingUrl !== sourceUrl) {
      return { ok: true, sourceUrl, ossUrl: existingUrl, reused: true };
    }
    let stored = null;
    const localPath = await resolveDraftLocalMediaPath(reference);
    if (localPath) {
      const stat = await fs.stat(localPath);
      if (stat.size > MAX_LOCAL_BYTES) throw new Error(`文件超过当前安全上限 ${MAX_LOCAL_BYTES} 字节`);
      const buffer = await fs.readFile(localPath);
      stored = await putContentAddressedObject(buffer, {
        prefix: "listing-media",
        extension: path.extname(localPath),
        contentType: contentTypeFor(localPath)
      });
    } else if (/^https:\/\//i.test(reference)) {
      const url = isManagedOssObjectUrl(reference)
        ? reference
        : await archiveRemoteMediaObjectUrl(reference, { prefix: "listing-media", timeoutMs: 1000 });
      stored = { url };
    } else {
      throw new Error("本地媒体文件不存在或地址暂不支持");
    }
    await verifyPublicMediaUrl(stored.url);
    const storage = ossStorageConfig();
    await markMediaMigrationVerified({
      sourceUrl,
      contentHashSha256: stored.hashSha256,
      byteSize: stored.size,
      ossBucket: stored.bucket || storage.bucket,
      ossObjectKey: stored.objectKey,
      ossUrl: stored.url
    });
    return { ok: true, sourceUrl, ossUrl: stored.url };
  } catch (error) {
    await markMediaMigrationFailed(sourceUrl, error);
    return { ok: false, sourceUrl, error: String(error?.message || error) };
  }
}

export async function runListingDraftMediaBackup() {
  const rows = await mysqlQuery(`
    SELECT id, source_images_json, template_payload_json, manual_facts_json, ai_payload_json
    FROM listing_drafts
    WHERE status <> 'deleted'
    ORDER BY id ${NEWEST_FIRST ? "DESC" : "ASC"}
    LIMIT ?
    OFFSET ?
  `, [LIMIT, OFFSET]);
  const candidates = rows.flatMap((row) => extractDraftMediaReferences(row).map((sourceUrl) => ({ draftId: row.id, sourceUrl })));
  const unique = [...new Map(candidates.map((item) => [canonicalMediaSource(item.sourceUrl), item])).values()];
  const summary = {
    mode: WRITE ? "write" : "dry-run",
    drafts: rows.length,
    references: candidates.length,
    unique: unique.length,
    succeeded: 0,
    failed: 0,
    reused: 0,
    skipped: 0
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!WRITE) {
    console.log("预演完成：未上传文件、未写入映射、未修改草稿。确认后使用 --write。 ");
    return summary;
  }
  let cursor = 0;
  let processed = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const item = unique[cursor++];
      const result = await backupReference(item.sourceUrl, {
        sourceModule: "listing_drafts",
        sourceTable: "listing_drafts",
        sourceRecordId: item.draftId,
        sourceField: "effective_media",
        mediaKind: /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(item.sourceUrl) ? "video" : "image"
      });
      if (result.ok) summary.succeeded += 1;
      else summary.failed += 1;
      if (result.reused) summary.reused += 1;
      if (result.skipped) summary.skipped += 1;
      processed += 1;
      if (!QUIET) console.log(JSON.stringify(result));
      if (QUIET && (processed % 100 === 0 || processed === unique.length)) {
        console.log(JSON.stringify({
          progress: `${processed}/${unique.length}`,
          succeeded: summary.succeeded,
          failed: summary.failed,
          reused: summary.reused,
          skipped: summary.skipped,
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

export async function reportListingDraftMediaMigrationStatus() {
  const rows = await mysqlQuery(`
    SELECT status, COUNT(1) AS count
    FROM media_migration_map
    WHERE source_module = 'listing_drafts'
    GROUP BY status
    ORDER BY status
  `);
  const summary = Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count || 0)]));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  (REPORT_STATUS ? reportListingDraftMediaMigrationStatus() : runListingDraftMediaBackup())
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(() => closeMysqlPool());
}

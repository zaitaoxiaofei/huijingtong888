import crypto from "node:crypto";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const VERIFIED_STATUS = "verified";
let mediaMigrationTableReadyPromise = null;

export function canonicalMediaSource(value = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/^[a-z]:[\\/]/i.test(source)) return `${source[0].toUpperCase()}${source.slice(1)}`.replace(/\\/g, "/");
  try {
    const parsed = new URL(source);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return source.replace(/\\/g, "/");
  }
}

export function mediaSourceFingerprint(value = "") {
  return crypto.createHash("sha256").update(canonicalMediaSource(value)).digest("hex");
}

export function preferredMediaUrl(sourceUrl = "", mapping = null) {
  const ossUrl = String(mapping?.oss_url || "").trim();
  return String(mapping?.status || "").trim() === VERIFIED_STATUS && ossUrl
    ? ossUrl
    : String(sourceUrl || "").trim();
}

export async function ensureMediaMigrationMapTable() {
  if (mediaMigrationTableReadyPromise) return mediaMigrationTableReadyPromise;
  mediaMigrationTableReadyPromise = mysqlExecute(`
    CREATE TABLE IF NOT EXISTS media_migration_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_fingerprint CHAR(64) NOT NULL,
      source_url TEXT NOT NULL,
      source_module VARCHAR(64) NOT NULL DEFAULT '',
      source_table VARCHAR(128) NOT NULL DEFAULT '',
      source_record_id VARCHAR(128) NOT NULL DEFAULT '',
      source_field VARCHAR(128) NOT NULL DEFAULT '',
      media_kind VARCHAR(16) NOT NULL DEFAULT 'other',
      content_hash_sha256 CHAR(64) NULL,
      byte_size BIGINT UNSIGNED NULL,
      oss_bucket VARCHAR(255) NULL,
      oss_object_key VARCHAR(1024) NULL,
      oss_url TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      verification_error VARCHAR(1000) NULL,
      verified_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_media_migration_source (source_fingerprint),
      KEY idx_media_migration_status (status, updated_at),
      KEY idx_media_migration_content_hash (content_hash_sha256)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `).catch((error) => {
    mediaMigrationTableReadyPromise = null;
    throw error;
  });
  return mediaMigrationTableReadyPromise;
}

export async function registerMediaMigrationSource({
  sourceUrl,
  sourceModule = "",
  sourceTable = "",
  sourceRecordId = "",
  sourceField = "",
  mediaKind = "other"
} = {}) {
  const canonicalSource = canonicalMediaSource(sourceUrl);
  if (!canonicalSource) throw new Error("媒体原地址不能为空");
  await ensureMediaMigrationMapTable();
  const sourceFingerprint = mediaSourceFingerprint(canonicalSource);
  await mysqlExecute(`
    INSERT INTO media_migration_map (
      source_fingerprint, source_url, source_module, source_table,
      source_record_id, source_field, media_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_module = COALESCE(NULLIF(VALUES(source_module), ''), source_module),
      source_table = COALESCE(NULLIF(VALUES(source_table), ''), source_table),
      source_record_id = COALESCE(NULLIF(VALUES(source_record_id), ''), source_record_id),
      source_field = COALESCE(NULLIF(VALUES(source_field), ''), source_field),
      media_kind = COALESCE(NULLIF(VALUES(media_kind), 'other'), media_kind)
  `, [sourceFingerprint, canonicalSource, sourceModule, sourceTable, String(sourceRecordId || ""), sourceField, mediaKind]);
  return { sourceFingerprint, sourceUrl: canonicalSource };
}

export async function markMediaMigrationVerified({
  sourceUrl,
  contentHashSha256,
  byteSize,
  ossBucket,
  ossObjectKey,
  ossUrl
} = {}) {
  const sourceFingerprint = mediaSourceFingerprint(sourceUrl);
  if (!sourceFingerprint || !String(ossUrl || "").trim()) throw new Error("验证成功必须提供原地址和 OSS 地址");
  await ensureMediaMigrationMapTable();
  const result = await mysqlExecute(`
    UPDATE media_migration_map SET
      content_hash_sha256 = ?, byte_size = ?, oss_bucket = ?, oss_object_key = ?,
      oss_url = ?, status = 'verified', verification_error = NULL, verified_at = CURRENT_TIMESTAMP
    WHERE source_fingerprint = ?
  `, [contentHashSha256 || null, Number(byteSize) || null, ossBucket || null, ossObjectKey || null, String(ossUrl).trim(), sourceFingerprint]);
  if (!Number(result?.affectedRows || 0)) throw new Error("媒体迁移映射不存在，请先登记原地址");
}

export async function markMediaMigrationFailed(sourceUrl, error) {
  await ensureMediaMigrationMapTable();
  await mysqlExecute(`
    UPDATE media_migration_map
    SET status = 'failed', verification_error = ?, verified_at = NULL
    WHERE source_fingerprint = ?
  `, [String(error?.message || error || "媒体迁移失败").slice(0, 1000), mediaSourceFingerprint(sourceUrl)]);
}

export async function resolvePreferredMediaUrl(sourceUrl = "") {
  const canonicalSource = canonicalMediaSource(sourceUrl);
  if (!canonicalSource) return "";
  await ensureMediaMigrationMapTable();
  const rows = await mysqlQuery(`
    SELECT status, oss_url
    FROM media_migration_map
    WHERE source_fingerprint = ?
    LIMIT 1
  `, [mediaSourceFingerprint(canonicalSource)]);
  return preferredMediaUrl(canonicalSource, rows[0] || null);
}

export async function resolvePreferredMediaUrls(values = []) {
  const sources = [...new Set((Array.isArray(values) ? values : []).map(canonicalMediaSource).filter(Boolean))];
  if (!sources.length) return [];
  await ensureMediaMigrationMapTable();
  const fingerprints = sources.map(mediaSourceFingerprint);
  const placeholders = fingerprints.map(() => "?").join(", ");
  const rows = await mysqlQuery(`
    SELECT source_fingerprint, status, oss_url
    FROM media_migration_map
    WHERE source_fingerprint IN (${placeholders})
  `, fingerprints);
  const mappings = new Map(rows.map((row) => [row.source_fingerprint, row]));
  return sources.map((source) => preferredMediaUrl(source, mappings.get(mediaSourceFingerprint(source))));
}

function isMediaLocator(value = "") {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text)
    || /^\/uploads\//i.test(text)
    || /^uploads\//i.test(text)
    || /^[a-z]:[\\/]/i.test(text);
}

export async function resolveMappedMediaInValue(value) {
  const sources = [];
  const collect = (item) => {
    if (typeof item === "string") {
      if (isMediaLocator(item)) sources.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(collect);
      return;
    }
    if (item && typeof item === "object") Object.values(item).forEach(collect);
  };
  collect(value);
  if (!sources.length) return value;
  const uniqueSources = [...new Set(sources.map(canonicalMediaSource))];
  const resolved = await resolvePreferredMediaUrls(uniqueSources);
  const bySource = new Map(uniqueSources.map((source, index) => [source, resolved[index] || source]));
  const replace = (item) => {
    if (typeof item === "string") {
      return isMediaLocator(item) ? (bySource.get(canonicalMediaSource(item)) || item) : item;
    }
    if (Array.isArray(item)) return item.map(replace);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, replace(nested)]));
    }
    return item;
  };
  return replace(value);
}

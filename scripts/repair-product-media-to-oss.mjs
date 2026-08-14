import fs from "node:fs/promises";
import path from "node:path";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { putContentAddressedObject } from "../src/services/object-storage.js";

const write = process.argv.includes("--write");
const limitArg = process.argv.find((item) => item.startsWith("--limit="));
const limit = Math.max(1, Math.min(Number(limitArg?.split("=")[1] || 10000), 100000));
const root = process.cwd();
const uploadRoots = [
  path.resolve(root, "uploads"),
  path.resolve(root, "public", "uploads"),
  path.resolve(root, "dist", "live", "uploads"),
  path.resolve(root, "dist", "live", "public", "uploads")
];

function localUploadRelative(value = "") {
  const clean = decodeURIComponent(String(value).split(/[?#]/, 1)[0]).replaceAll("\\", "/");
  const marker = "/uploads/";
  const index = clean.toLowerCase().indexOf(marker);
  if (index < 0) return "";
  const relative = clean.slice(index + marker.length);
  return relative && !relative.split("/").includes("..") ? relative : "";
}

async function resolveLocalFile(value) {
  const relative = localUploadRelative(value);
  if (!relative) return "";
  for (const uploadRoot of uploadRoots) {
    const candidate = path.resolve(uploadRoot, relative);
    if (!candidate.startsWith(`${uploadRoot}${path.sep}`)) continue;
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

function parseImages(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function contentType(filePath) {
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif"
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

const uploaded = new Map();
async function ossUrl(value) {
  if (!String(value).startsWith("/uploads/listing-media/")) return value;
  if (uploaded.has(value)) return uploaded.get(value);
  const localPath = await resolveLocalFile(value);
  if (!localPath) {
    uploaded.set(value, "");
    return "";
  }
  if (!write) {
    uploaded.set(value, `[local]${localPath}`);
    return `[local]${localPath}`;
  }
  const buffer = await fs.readFile(localPath);
  const stored = await putContentAddressedObject(buffer, {
    prefix: "listing-media",
    extension: path.extname(localPath),
    contentType: contentType(localPath)
  });
  if (!stored?.url) throw new Error("OSS is not enabled or upload returned no URL");
  const response = await fetch(stored.url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`OSS verification failed: HTTP ${response.status}`);
  uploaded.set(value, stored.url);
  return stored.url;
}

async function main() {
  const rows = await mysqlQuery(`
    SELECT id, image_url, detail_image_urls
    FROM products
    WHERE active = 1
      AND (image_url LIKE '/uploads/listing-media/%' OR detail_image_urls LIKE '%/uploads/listing-media/%')
    ORDER BY id
    LIMIT ?
  `, [limit]);
  const summary = { mode: write ? "write" : "dry-run", products: rows.length, changed: 0, files: 0, missing: 0, failed: 0 };
  for (const row of rows) {
    try {
      const mainSource = String(row.image_url || "");
      const detailSources = parseImages(row.detail_image_urls);
      const mainResult = await ossUrl(mainSource);
      const detailResults = await Promise.all(detailSources.map(ossUrl));
      const missing = [mainSource && !mainResult, ...detailSources.map((item, index) => item && !detailResults[index])].filter(Boolean).length;
      summary.missing += missing;
      const nextMain = write && mainResult ? mainResult : mainSource;
      const nextDetails = write ? detailSources.map((item, index) => detailResults[index] || item) : detailSources;
      const changed = Boolean(mainResult && mainResult !== mainSource)
        || detailResults.some((item, index) => item && item !== detailSources[index]);
      if (!changed) continue;
      summary.changed += 1;
      if (write) {
        await mysqlExecute(
          "UPDATE products SET image_url = ?, detail_image_urls = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [nextMain, JSON.stringify(nextDetails), Number(row.id)]
        );
      }
    } catch (error) {
      summary.failed += 1;
      console.error(JSON.stringify({ productId: row.id, error: String(error?.message || error) }));
    }
  }
  summary.files = [...uploaded.values()].filter(Boolean).length;
  console.log(JSON.stringify(summary, null, 2));
}

main().finally(closeMysqlPool).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

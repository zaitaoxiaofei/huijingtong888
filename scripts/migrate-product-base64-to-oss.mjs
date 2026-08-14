import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { ossStorageConfig, putContentAddressedObject } from "../src/services/object-storage.js";

const WRITE = process.argv.includes("--write");
const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

function extensionForContentType(contentType) {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif"
  })[String(contentType || "").toLowerCase()] || "";
}

async function migrateDataUrl(value, cache) {
  const text = String(value || "").trim();
  const match = DATA_URL_PATTERN.exec(text);
  if (!match) return text;
  if (cache.has(text)) return cache.get(text);
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("Embedded product image is empty");
  const stored = await putContentAddressedObject(buffer, {
    prefix: "product-media",
    extension: extensionForContentType(match[1]),
    contentType: match[1]
  });
  if (!stored?.url) throw new Error("OSS upload did not return a product media URL");
  cache.set(text, stored.url);
  return stored.url;
}

async function rewriteEmbeddedImages(value, cache) {
  if (typeof value === "string") return migrateDataUrl(value, cache);
  if (Array.isArray(value)) return Promise.all(value.map((item) => rewriteEmbeddedImages(item, cache)));
  if (!value || typeof value !== "object") return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await rewriteEmbeddedImages(item, cache)]));
  return Object.fromEntries(entries);
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

export async function migrateProductBase64ToOss() {
  const rows = await mysqlQuery(`
    SELECT id, image_url, detail_image_urls
    FROM products
    WHERE image_url LIKE 'data:image/%'
       OR detail_image_urls LIKE '%data:image/%'
    ORDER BY id
  `);
  const report = {
    mode: WRITE ? "write" : "dry-run",
    products: rows.length,
    mainImages: rows.filter((row) => DATA_URL_PATTERN.test(String(row.image_url || "").trim())).length,
    detailProducts: rows.filter((row) => String(row.detail_image_urls || "").includes("data:image/")).length,
    updated: 0,
    failed: []
  };
  console.log(JSON.stringify(report, null, 2));
  if (!WRITE) return report;
  if (!ossStorageConfig().enabled) throw new Error("OSS must be enabled before migrating embedded product images");
  const cache = new Map();
  for (const row of rows) {
    try {
      const imageUrl = await migrateDataUrl(row.image_url, cache);
      const detailImages = await rewriteEmbeddedImages(parseJson(row.detail_image_urls, []), cache);
      await mysqlExecute(`
        UPDATE products
        SET image_url = ?, detail_image_urls = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [imageUrl, JSON.stringify(detailImages), Number(row.id)]);
      report.updated += 1;
      console.log(JSON.stringify({ productId: Number(row.id), updated: report.updated, total: rows.length }));
    } catch (error) {
      report.failed.push({ productId: Number(row.id), error: error?.message || String(error) });
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length) process.exitCode = 2;
  return report;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  migrateProductBase64ToOss()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(() => closeMysqlPool());
}

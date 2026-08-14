import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { isManagedOssObjectUrl, putContentAddressedObject } from "../src/services/object-storage.js";

const write = process.argv.includes("--write");
const root = process.cwd();

function localMediaPath(value = "") {
  let pathname = String(value || "").trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = decodeURIComponent(new URL(pathname).pathname);
    } catch {
      return "";
    }
  }
  const relative = pathname.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^public\//i, "");
  if (!relative.startsWith("uploads/")) return "";
  const candidates = [
    path.resolve(root, "public", relative),
    path.resolve(root, "dist", "live", "public", relative),
    path.resolve(root, "dist", "preview", "public", relative)
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || "";
}

async function ossUrl(value) {
  const source = String(value || "").trim();
  if (!source || isManagedOssObjectUrl(source)) return source;
  const localPath = localMediaPath(source);
  if (!localPath) {
    throw new Error("local source file is missing");
  }
  const buffer = await fs.readFile(localPath);
  const extension = path.extname(localPath).toLowerCase();
  const stored = await putContentAddressedObject(buffer, {
    prefix: "listing-media",
    extension,
    contentType: extension === ".png" ? "image/png" : "image/jpeg"
  });
  if (!stored?.url) throw new Error(`OSS upload failed: ${source}`);
  return stored.url;
}

const targets = [
  { table: "asset_tail_templates", column: "image_path", where: "status <> 'deleted'" },
  { table: "shop_variant_rules", column: "tail_image_url", where: "tail_image_url IS NOT NULL AND tail_image_url <> ''" }
];

let changed = 0;
let failed = 0;
for (const target of targets) {
  const rows = await mysqlQuery(`SELECT id, ${target.column} AS source_url FROM ${target.table} WHERE ${target.where}`);
  for (const row of rows) {
    if (!write && row.source_url && !isManagedOssObjectUrl(row.source_url)) {
      if (localMediaPath(row.source_url)) {
        console.log(`${target.table}#${row.id}: would migrate`);
        changed += 1;
      } else {
        console.warn(`${target.table}#${row.id}: unavailable local source`);
        failed += 1;
      }
      continue;
    }
    let nextUrl = "";
    try {
      nextUrl = await ossUrl(row.source_url);
    } catch (error) {
      console.warn(`${target.table}#${row.id}: skipped (${error?.message || error})`);
      failed += 1;
      continue;
    }
    if (!nextUrl || nextUrl === row.source_url) continue;
    console.log(`${target.table}#${row.id}: ${write ? "migrated" : "would migrate"}`);
    if (write) await mysqlExecute(`UPDATE ${target.table} SET ${target.column} = ? WHERE id = ?`, [nextUrl, row.id]);
    changed += 1;
  }
}

console.log(`${write ? "Migrated" : "Would migrate"} ${changed} tail template reference(s) to OSS.`);
if (failed) console.log(`Skipped ${failed} unavailable tail template reference(s).`);
await closeMysqlPool();

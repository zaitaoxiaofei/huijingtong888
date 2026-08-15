import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import { ossStorageConfig, publicOssObjectUrl } from "../src/services/object-storage.js";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_LIMIT = 200;
const MEDIA_ROOTS = [
  { name: "ai-generated", relativePath: "uploads/ai-generated", prefixes: ["ai-unused", "listing-media"] },
  { name: "shop-variants", relativePath: "uploads/shop-variants", prefixes: ["listing-media"] }
];

function positiveInteger(value, fallback, maximum = 10000) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, parsed) : fallback;
}

export function parseCleanupArgs(argv = []) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : "";
  };
  return {
    write: argv.includes("--write"),
    retentionDays: positiveInteger(valueAfter("--days"), DEFAULT_RETENTION_DAYS, 3650),
    limit: positiveInteger(valueAfter("--limit"), DEFAULT_LIMIT, 10000)
  };
}

function normalizeExtension(filePath) {
  return path.extname(filePath).trim().toLowerCase();
}

export function candidateObjectKeys(hashSha256, extension, prefixes = []) {
  const name = `${hashSha256}${extension}`;
  return prefixes.map((prefix) => `${prefix}/${hashSha256.slice(0, 2)}/${name}`);
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { hashSha256: hash.digest("hex"), bytes };
}

async function collectFiles(root, cutoffMs, output = []) {
  let entries = [];
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectFiles(fullPath, cutoffMs, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsPromises.stat(fullPath);
    if (stat.mtimeMs <= cutoffMs) output.push({ filePath: fullPath, stat });
  }
  return output;
}

async function verifiedOssCopy(client, storage, file, prefixes) {
  const { hashSha256, bytes } = await hashFile(file.filePath);
  for (const objectKey of candidateObjectKeys(hashSha256, normalizeExtension(file.filePath), prefixes)) {
    try {
      const head = await client.head(objectKey);
      const remoteBytes = Number(head?.res?.headers?.["content-length"] || 0);
      if (remoteBytes !== bytes) continue;
      return {
        hashSha256,
        bytes,
        objectKey,
        ossUrl: publicOssObjectUrl({
          region: storage.region,
          bucket: storage.bucket,
          objectKey,
          publicBaseUrl: storage.publicBaseUrl
        })
      };
    } catch (error) {
      if (Number(error?.status || error?.statusCode || 0) === 404 || error?.code === "NoSuchKey") continue;
      throw error;
    }
  }
  return null;
}

async function removeEmptyDirectories(root, { preserveRoot = false } = {}) {
  let entries = [];
  try { entries = await fsPromises.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await removeEmptyDirectories(path.join(root, entry.name));
  }
  if (!preserveRoot) {
    try { await fsPromises.rmdir(root); } catch { /* keep non-empty and active directories */ }
  }
}

export async function cleanupVerifiedLocalMedia({
  write = false,
  retentionDays = DEFAULT_RETENTION_DAYS,
  limit = DEFAULT_LIMIT,
  cwd = process.cwd(),
  env = process.env,
  client = null,
  now = Date.now()
} = {}) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled) throw new Error("OSS is not enabled; local media cleanup is blocked");
  const ossClient = client || new OSS({
    region: storage.region,
    bucket: storage.bucket,
    accessKeyId: storage.accessKeyId,
    accessKeySecret: storage.accessKeySecret,
    stsToken: storage.stsToken || undefined,
    secure: true,
    timeout: 15000
  });
  const cutoffMs = now - retentionDays * 86400000;
  const report = {
    mode: write ? "write" : "dry-run",
    retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    scanned: 0,
    verified: 0,
    deleted: 0,
    reclaimedBytes: 0,
    keptWithoutVerifiedOss: 0,
    errors: 0,
    items: []
  };

  for (const rootConfig of MEDIA_ROOTS) {
    if (report.scanned >= limit) break;
    const root = path.resolve(cwd, rootConfig.relativePath);
    const files = (await collectFiles(root, cutoffMs)).sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
    for (const file of files) {
      if (report.scanned >= limit) break;
      report.scanned += 1;
      const relativePath = path.relative(cwd, file.filePath).replace(/\\/g, "/");
      try {
        const verified = await verifiedOssCopy(ossClient, storage, file, rootConfig.prefixes);
        if (!verified) {
          report.keptWithoutVerifiedOss += 1;
          report.items.push({ action: "kept", reason: "verified_oss_copy_not_found", root: rootConfig.name, relativePath });
          continue;
        }
        report.verified += 1;
        const item = { action: write ? "deleted" : "would_delete", root: rootConfig.name, relativePath, ...verified };
        if (write) {
          await fsPromises.unlink(file.filePath);
          report.deleted += 1;
          report.reclaimedBytes += verified.bytes;
        }
        report.items.push(item);
      } catch (error) {
        report.errors += 1;
        report.items.push({ action: "kept", reason: "verification_error", root: rootConfig.name, relativePath, error: error?.message || String(error) });
      }
    }
    if (write) await removeEmptyDirectories(root, { preserveRoot: true });
  }
  return report;
}

async function main() {
  const options = parseCleanupArgs(process.argv.slice(2));
  const report = await cleanupVerifiedLocalMedia(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

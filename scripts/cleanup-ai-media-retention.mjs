import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { auditAiMediaRetention, applyAiMediaRetention } from "../src/services/ai-media-retention.js";
import { ossStorageConfig, headManagedOssRetentionObject, deleteManagedOssRetentionObject, listManagedOssRetentionObjects } from "../src/services/object-storage.js";

const execFileAsync = promisify(execFile);
function optionsFromArgs(args) {
  const options = new Map();
  for (const argument of args) {
    const match = /^--(database|mysql-admin-socket|output|manifest|prior-manifest-dir|limit|max-scan-rows|apply|offline-maintenance|review-current-versions)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (["apply", "offline-maintenance", "review-current-versions"].includes(match[1]) ? match[2] !== undefined : !match[2])) throw new Error("Unknown, duplicate or incomplete retention option");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || "") || typeof socketPath !== "string"
    || !(socketPath.startsWith("/") || socketPath.startsWith("\\\\.\\pipe\\"))) throw new Error("Explicit database and local administrator MySQL socket required");
  const apply = options.has("apply"), offline = options.has("offline-maintenance");
  if (apply && options.has("review-current-versions")) throw new Error("Current-version review is preview-only; apply consumes the checksummed review in the manifest");
  const file = options.get(apply ? "manifest" : "output");
  if (!path.isAbsolute(file || "") || options.has(apply ? "output" : "manifest") || offline && !apply) throw new Error("An absolute output path for preview or manifest path for apply is required");
  const limit = Number(options.get("limit") || 200), maxScanRows = Number(options.get("max-scan-rows") || 2000000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25000 || !Number.isSafeInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > 2000000) throw new Error("Invalid retention scan bounds");
  const priorDir = options.get("prior-manifest-dir");
  if (priorDir && !path.isAbsolute(priorDir)) throw new Error("Prior retention queue directory must be absolute");
  return { database, socketPath, file, apply, offline, limit, maxScanRows, priorDir, reviewCurrentVersions: options.has("review-current-versions") };
}
async function privateWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function verifyAiMediaRetentionMaintenance({ query, platform = process.platform, inspectProcesses = null, pid = process.pid } = {}) {
  if (platform !== "linux") throw new Error("Physical media GC requires the local Linux production maintenance host");
  const processes = inspectProcesses ? await inspectProcesses() : (await execFileAsync("ps", ["-eo", "pid=,comm=,args="], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  let writerCount = 0;
  for (const line of String(processes).split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === pid) continue;
    const command = match[2].toLowerCase(), args = match[3];
    // A stopped PM2 supervisor is not an ERP writer; every other Node/tsx
    // process must be stopped, even when its entry-point name is unfamiliar.
    if (/^(?:node|nodejs|tsx|ts-node)(?:\s|$)/.test(command) && !/PM2.*God Daemon/.test(args)) writerCount++;
    if (/(?:python|python3)/.test(command) && /(?:ozon|erp).*(?:worker|server)|(?:worker|server).*(?:ozon|erp)/i.test(args)) writerCount++;
  }
  if (writerCount) throw new Error("Physical media GC refused: application or worker processes still running");
  const connections = await query("SELECT ID FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID() AND COMMAND<>'Daemon'");
  if (connections.length) throw new Error("Physical media GC refused: other database connections remain");
  return { verified: true, hostname: os.hostname(), checked_at: new Date().toISOString(), application_writers: 0, other_database_connections: 0 };
}

export async function runAiMediaRetentionCli(args) {
  const options = optionsFromArgs(args);
  const { default: mysql } = await import("mysql2/promise");
  const connection = await mysql.createConnection({ socketPath: options.socketPath, user: "root", database: options.database, timezone: "Z", dateStrings: true });
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  const execute = async (sql, params = []) => (await connection.execute(sql, params))[0];
  const transaction = async callback => {
    await connection.beginTransaction();
    try { const result = await callback({ query, execute }); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
  };
  try {
    await query("SET SESSION time_zone='+00:00'");
    await query("SET SESSION max_execution_time=20000");
    const storage = ossStorageConfig();
    if (!options.apply) {
      await query("SET SESSION TRANSACTION READ ONLY");
      const priorManifests = [];
      if (options.priorDir) {
        const entries = await fs.readdir(options.priorDir, { withFileTypes: true });
        if (entries.length > 10000) throw new Error("Retention queue file bound exceeded");
        let queueBytes = 0;
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const file = path.join(options.priorDir, entry.name), stat = await fs.lstat(file);
          queueBytes += stat.size;
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || queueBytes > 32 * 1024 * 1024) throw new Error("Retention queue memory bound exceeded; review a smaller explicit queue batch");
          const prior = JSON.parse(await fs.readFile(file, "utf8"));
          if (prior.format === "ai-media-retention-v1") priorManifests.push(prior);
        }
      }
      const objects = storage.enabled ? await listManagedOssRetentionObjects({ prefix: "ai-unused" }) : [];
      const manifest = await auditAiMediaRetention({ query, storage, objects, priorManifests,
        headObject: storage.enabled ? headManagedOssRetentionObject : null, limit: options.limit, maxScanRows: options.maxScanRows, reviewCurrentVersions: options.reviewCurrentVersions });
      await privateWrite(options.file, manifest);
      return { mode: "read_only_preview", manifest: options.file, manifest_sha256: manifest.manifest_sha256, complete: manifest.scan.complete,
        candidate_rows: manifest.rows.length, candidate_objects: manifest.objects.length, candidate_bytes: manifest.objects.reduce((sum, item) => sum + item.head.size, 0),
        retained_rows: manifest.kept.length, retained_objects: manifest.kept_objects.length, warnings: manifest.scan.warnings.length, missing_roots: manifest.scan.missing_roots };
    }
    const stat = await fs.lstat(options.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid or oversized reviewed retention manifest file; use a smaller batch");
    const manifest = JSON.parse(await fs.readFile(options.file, "utf8"));
    const maintenance = options.offline ? async () => verifyAiMediaRetentionMaintenance({ query }) : null;
    let evidenceFile = null;
    if (maintenance) {
      const evidence = await maintenance();
      evidenceFile = `${options.file}.maintenance-${Date.now()}.json`;
      await privateWrite(evidenceFile, { ...evidence, format: "ai-media-retention-maintenance-v1", database: options.database, manifest_sha256: manifest.manifest_sha256 });
    }
    const result = await applyAiMediaRetention({ query, transaction, manifest, headObject: headManagedOssRetentionObject,
      deleteObject: deleteManagedOssRetentionObject, deleteObjects: options.offline, maintenance });
    const resultFile = `${options.file}.result-${Date.now()}.json`;
    await privateWrite(resultFile, result);
    return { mode: options.offline ? "offline_physical_gc" : "database_indexes_only", rows_deleted: result.rows_deleted, objects_deleted: result.objects_deleted,
      reclaimed_bytes: result.reclaimed_bytes, retained_rows: result.rows.filter(item => item.retained || item.status === "row_changed").length,
      retained_objects: result.objects.filter(item => item.retained).length, older_versions_unenumerated: result.objects.some(item => item.older_versions_unenumerated), evidence_file: evidenceFile, result_file: resultFile };
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAiMediaRetentionCli(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || "AI_MEDIA_RETENTION_REFUSED", error: error.message }));
    process.exitCode = 1;
  });
}

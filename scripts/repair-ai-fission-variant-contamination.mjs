import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import mysql from "mysql2/promise";
import { inspectAiFissionVariantCleanup, applyAiFissionVariantCleanup } from "./lib/ai-fission-variant-cleanup.mjs";

// Explicit administrator socket only: this CLI never reads application .env.
let db;
try {
  const options = new Map();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(database|mysql-admin-socket|manifest|output|backup-dir|apply)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (match[1] === "apply" ? match[2] !== undefined : !match[2])) throw Error("Invalid or duplicate CLI argument");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket"), manifestPath = options.get("manifest");
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database || "") || !socketPath || !isAbsolute(manifestPath || "")) throw Error("Explicit database, local administrator socket and absolute manifest path required");
  for (const name of ["output", "backup-dir"]) if (options.has(name) && !isAbsolute(options.get(name))) throw Error("Output/backup paths must be absolute");
  if (options.has("apply") && !options.has("backup-dir")) throw Error("Apply requires an existing private backup directory");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  db = await mysql.createConnection({ socketPath, user: "root", database, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  await db.query("SET SESSION time_zone = '+00:00'");
  await db.query("SET SESSION innodb_lock_wait_timeout = 5");
  let result;
  if (options.has("apply")) result = await applyAiFissionVariantCleanup(db, manifest, options.get("backup-dir"));
  else {
    await db.query("START TRANSACTION READ ONLY");
    try {
      const plan = await inspectAiFissionVariantCleanup(db, manifest);
      result = { ...plan.summary, reviewed_manifest: plan.reviewed_manifest };
    } finally { await db.rollback(); }
  }
  const output = JSON.stringify({ ok: true, action: options.has("apply") ? "apply" : "audit", ...result }, null, 2) + "\n";
  if (options.has("output")) await writeFile(options.get("output"), output, { flag: "wx", mode: 0o600 });
  else process.stdout.write(output);
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error.safe ? error.message : "AI fission cleanup refused; raw database rows and SQL are redacted." }) + "\n");
  process.exitCode = 1;
} finally { if (db) await db.end(); }

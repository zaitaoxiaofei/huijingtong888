import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import mysql from "mysql2/promise";
import { inspectReviewedVariantCompatibility, applyReviewedVariantCompatibility } from "./lib/reviewed-variant-compatibility.mjs";

// Explicit local administrator socket; never load application credentials or .env.
// Run after the separately reviewed copy repair; full-row hashes preserve all other edits.
let db;
try {
  const options = new Map();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(database|mysql-admin-socket|manifest|output|backup-dir|apply)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (match[1] === "apply" ? match[2] !== undefined : !match[2])) throw Error("Invalid or duplicate argument");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket"), manifestPath = options.get("manifest");
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database || "") || !isAbsolute(socketPath || "") || !isAbsolute(manifestPath || "")) throw Error("Explicit database, absolute administrator socket and manifest required");
  for (const name of ["output", "backup-dir"]) if (options.has(name) && !isAbsolute(options.get(name))) throw Error("Absolute private output paths required");
  if (options.has("apply") && !options.has("backup-dir")) throw Error("Apply requires an existing private backup directory");
  const text = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error("Split reviewed manifest into smaller batches");
  const manifest = JSON.parse(text);
  db = await mysql.createConnection({ socketPath, user: "root", database, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  await db.query("SET SESSION time_zone = '+00:00'");
  await db.query("SET SESSION innodb_lock_wait_timeout = 5");
  await db.query("SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  let result;
  if (options.has("apply")) result = await applyReviewedVariantCompatibility(db, manifest, options.get("backup-dir"));
  else {
    await db.query("START TRANSACTION READ ONLY");
    try {
      const plan = await inspectReviewedVariantCompatibility(db, manifest);
      result = { rows: plan.rows.length, changed_rows: plan.changed_rows };
    } finally { await db.rollback(); }
  }
  const output = JSON.stringify({ ok: true, action: options.has("apply") ? "apply" : "audit", ...result }, null, 2) + "\n";
  if (options.has("output")) await writeFile(options.get("output"), output, { flag: "wx", mode: 0o600 });
  else process.stdout.write(output);
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: error.safe ? error.message : "Reviewed copy repair refused; raw database rows and SQL are redacted." }) + "\n");
  process.exitCode = 1;
} finally { if (db) await db.end(); }

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const group = String(process.argv[2] || "").trim().toLowerCase();
const supportedGroups = new Set(["unit", "mysql", "frontend", "build"]);
if (!supportedGroups.has(group)) {
  throw new Error(`Unknown test group: ${group || "(empty)"}`);
}

const testDir = path.resolve("test");
const names = (await readdir(testDir))
  .filter((name) => name.endsWith(".test.js"))
  .sort();

function classify(name, source) {
  if (
    source.includes("../src/mysql-pool.js")
    || source.includes("../src/services/mysql-cutover.js")
    || /\b(mysql|schema|paged-list)\b/i.test(name)
  ) return "mysql";
  if (/\b(build|deploy|release|package|proxy-cache)\b/i.test(name)) return "build";
  if (source.includes("../frontend/") || source.includes("frontend/")) return "frontend";
  return "unit";
}

const files = [];
for (const name of names) {
  const absolutePath = path.join(testDir, name);
  const source = await readFile(absolutePath, "utf8");
  if (classify(name, source) === group) files.push(path.relative(process.cwd(), absolutePath));
}

if (!files.length) throw new Error(`No tests found for group: ${group}`);
console.log(`Running ${files.length} ${group} test files.`);

const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-concurrency=1", ...files], {
  cwd: process.cwd(),
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});

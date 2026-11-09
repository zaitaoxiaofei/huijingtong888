import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const INSTALL_PROFILE = "npm-ci:omit-dev:include-optional:no-audit:v1";
export async function dependencyIdentity(root, runtime) {
  const packageBytes = await fs.readFile(path.join(root, "package.json"));
  const packageJson = JSON.parse(packageBytes);
  // Root lifecycle scripts can depend on application files or environment
  // outside the dependency lock. Always run a fresh install in that case.
  if (["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].some(name => packageJson.scripts?.[name])) return null;
  runtime ||= {
    node: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch,
    libc: process.report.getReport().header.glibcVersionRuntime || "non-glibc",
    npm: execFileSync("/usr/bin/npm", ["--version"], { encoding: "utf8" }).trim()
  };
  const inputs = [packageBytes, await fs.readFile(path.join(root, "package-lock.json")),
    JSON.stringify(runtime), INSTALL_PROFILE];
  const hash = crypto.createHash("sha256");
  for (const input of inputs) { hash.update(String(Buffer.byteLength(input))); hash.update(":"); hash.update(input); }
  return hash.digest("hex");
}

export async function inspectDependencyCache(cacheRoot, key, { uid = 0 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid dependency cache key");
  const entry = path.join(cacheRoot, key);
  try {
    const [receipt, directory, modules, receiptStat] = await Promise.all([
      fs.readFile(path.join(entry, "receipt.json"), "utf8"), fs.lstat(entry), fs.lstat(path.join(entry, "node_modules")), fs.lstat(path.join(entry, "receipt.json"))
    ]);
    for (const stat of [directory, modules]) if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o222)) throw Error("Dependency cache is not immutable");
    if (!receiptStat.isFile() || receiptStat.uid !== uid || (receiptStat.mode & 0o222)) throw Error("Dependency receipt is not immutable");
    const record = JSON.parse(receipt);
    if (record.key !== key || record.profile !== INSTALL_PROFILE) throw Error("Dependency cache receipt mismatch");
    return entry;
  } catch (error) {
    if (error.code === "ENOENT") {
      // An incomplete existing entry must never be reused or replaced while
      // an older release may still reference it.
      try { await fs.lstat(entry); } catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
      throw Error("Incomplete dependency cache; existing releases left untouched");
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, root, key] = process.argv.slice(2);
  if (command === "key") console.log(await dependencyIdentity(root) || "");
  else if (command === "find") {
    const entry = await inspectDependencyCache(root, key);
    if (entry) console.log(entry);
  } else if (command === "receipt" && /^[a-f0-9]{64}$/.test(key || "")) {
    await fs.writeFile(path.join(root, "receipt.json"), JSON.stringify({ key, profile: INSTALL_PROFILE }) + "\n", { flag: "wx", mode: 0o444 });
  } else if (command === "verify") {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const require = createRequire(path.join(root, "package.json"));
    for (const name of ["mysql2", "sharp", "pdf-lib"]) if (packageJson.dependencies?.[name]) require(name);
  } else throw Error("Unknown dependency cache operation");
}

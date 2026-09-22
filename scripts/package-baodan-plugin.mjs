import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(rootDir, "ozon-erp-collector-plugin");
const outputDir = path.resolve(rootDir, "..");
const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8"));
const version = String(manifest.version || "").trim();

if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Collector plugin manifest version is invalid");

const packageNames = [
  `ozon-baodan-erp-plugin-${version}.rar`,
  "ozon-baodan-erp-plugin.rar",
  "ozon-erp-collector-plugin.rar"
];

for (const name of packageNames) {
  const target = path.join(outputDir, name);
  await fs.rm(target, { force: true });
  await execFileAsync("zip", ["-q", "-r", target, "."], { cwd: pluginDir });
}

console.log(`Packaged collector plugin ${version}: ${packageNames.join(", ")}`);

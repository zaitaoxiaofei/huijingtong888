import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(rootDir, "ozon-erp-collector-plugin");
const outputDir = path.resolve(process.env.COLLECTOR_PLUGIN_OUTPUT_DIR || path.join(rootDir, ".."));
await execFileAsync(process.execPath, [path.join(rootDir, "scripts", "sync-unified-analytics.mjs")], { cwd: rootDir });
const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8"));
const version = String(manifest.version || "").trim();

if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Collector plugin manifest version is invalid");

const packageNames = [
  `ozon-baodan-erp-plugin-${version}.zip`,
  "ozon-baodan-erp-plugin.zip",
  "ozon-erp-collector-plugin.zip"
];

await fs.mkdir(outputDir, { recursive: true });
const versionedPath = path.join(outputDir, packageNames[0]);
await fs.rm(versionedPath, { force: true });
if (process.platform === "win32") {
  // Explicit top-level entries produce portable root paths, without './'.
  const entries = await fs.readdir(pluginDir);
  await execFileAsync("tar.exe", ["-a", "-c", "-f", versionedPath, "-C", pluginDir, ...entries]);
} else {
  await execFileAsync("zip", ["-q", "-r", versionedPath, "."], { cwd: pluginDir });
}
for (const name of packageNames.slice(1)) await fs.copyFile(versionedPath, path.join(outputDir, name));

console.log(`Packaged collector plugin ${version}: ${packageNames.join(", ")}`);

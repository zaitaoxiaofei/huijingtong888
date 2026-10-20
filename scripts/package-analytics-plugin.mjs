import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(rootDir, "pivot-table-master");
const outputDir = path.resolve(process.env.ANALYTICS_PLUGIN_OUTPUT_DIR || path.join(rootDir, ".."));
const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8"));
const version = String(manifest.version || "").trim();
if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Analytics plugin manifest version is invalid");
await fs.mkdir(outputDir, { recursive: true });

for (const name of [`ozon-seller-analytics-plugin-${version}.zip`, "ozon-seller-analytics-plugin.zip"]) {
  const target = path.join(outputDir, name);
  await fs.rm(target, { force: true });
  await execFileAsync("zip", ["-q", "-r", target, "."], { cwd: pluginDir });
  const contents = await execFileAsync("unzip", ["-p", target, "manifest.json"]);
  if (JSON.parse(contents.stdout).version !== version) throw new Error(`Analytics plugin package version mismatch: ${name}`);
}

console.log(`Packaged analytics plugin ${version}`);

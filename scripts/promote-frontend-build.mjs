import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const tempOutputDir = path.resolve(process.env.OZON_VITE_OUT_DIR || path.join(os.tmpdir(), "ozon-erp-frontend-build"));
const targetOutputDir = path.resolve(rootDir, "public", "vue-apps");
const targetAssetsDir = path.join(targetOutputDir, "assets");
const sourceAssetsDir = path.join(tempOutputDir, "assets");
const sourceManifestPath = path.join(tempOutputDir, ".vite", "manifest.json");
const targetManifestDir = path.join(targetOutputDir, ".vite");
const targetManifestPath = path.join(targetManifestDir, "manifest.json");
const targetManifestBackupPath = path.join(targetManifestDir, "manifest.build.json");

async function assertDirectoryExists(dir, label) {
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} was not found: ${dir}`);
  }
}

async function runPowerShell(command) {
  await new Promise((resolve, reject) => {
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], {
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell command failed with code ${code}`));
    });
  });
}

if (tempOutputDir === targetOutputDir) {
  console.log(`Frontend build already targets ${targetOutputDir}`);
  process.exit(0);
}

await assertDirectoryExists(sourceAssetsDir, "Frontend source assets directory");
await assertDirectoryExists(path.dirname(sourceManifestPath), "Frontend source manifest directory");
await fs.mkdir(targetAssetsDir, { recursive: true });
await fs.mkdir(targetManifestDir, { recursive: true });
await fs.copyFile(sourceManifestPath, targetManifestBackupPath);
await fs.copyFile(sourceManifestPath, targetManifestPath).catch(() => {});
if (process.platform === "win32") {
  const escapedSourceAssetsDir = sourceAssetsDir.replaceAll("'", "''");
  const escapedTargetAssetsDir = targetAssetsDir.replaceAll("'", "''");
  await runPowerShell(`$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath '${escapedSourceAssetsDir}' -Force | ForEach-Object { $source = $_; $destination = Join-Path '${escapedTargetAssetsDir}' $source.Name; for ($attempt = 1; $attempt -le 10; $attempt += 1) { try { Copy-Item -LiteralPath $source.FullName -Destination $destination -Recurse -Force -ErrorAction Stop; break } catch { $copied = Get-Item -LiteralPath $destination -ErrorAction SilentlyContinue; if ($copied -and $copied.Length -eq $source.Length) { break }; if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds ($attempt * 250) } } }`);
} else {
  await fs.cp(sourceAssetsDir, targetAssetsDir, { recursive: true, force: true });
}
const promotedAssets = await fs.readdir(targetAssetsDir).catch(() => []);
if (!promotedAssets.length) {
  throw new Error(`Frontend assets missing after promote: ${targetAssetsDir}`);
}
console.log(`Promoted frontend build from ${tempOutputDir} to ${targetOutputDir}`);

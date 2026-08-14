import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const publicFrontendOutputDir = path.resolve(rootDir, "public", "vue-apps");
const frontendOutputDir = path.resolve(process.env.OZON_VITE_OUT_DIR || publicFrontendOutputDir);
const frontendAssetsDir = path.join(frontendOutputDir, "assets");
const adminHtmlPath = path.resolve(rootDir, "public", "admin.html");
const adminCompressedPaths = [
  path.resolve(rootDir, "public", "admin.html.br"),
  path.resolve(rootDir, "public", "admin.html.gz")
];
const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 250 };
const removeFileOptions = { force: true, maxRetries: 10, retryDelay: 250 };
const ASSET_RETENTION_MS = Number(process.env.FRONTEND_ASSET_RETENTION_MS || 24 * 60 * 60 * 1000);
const transientRemoveErrors = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const isTempBuildOutput = frontendOutputDir !== publicFrontendOutputDir;

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeWithPowerShell(target, options) {
  const escapedTarget = String(target).replaceAll("'", "''");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    options.recursive
      ? `$ErrorActionPreference='SilentlyContinue'; Remove-Item -LiteralPath '${escapedTarget}' -Recurse -Force; exit 0`
      : `$ErrorActionPreference='SilentlyContinue'; Remove-Item -LiteralPath '${escapedTarget}' -Force; exit 0`
  ];
  await new Promise((resolve, reject) => {
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args, {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell remove failed for ${target} with code ${code}`));
    });
  });
}

async function removeWithRetries(target, options, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (process.platform === "win32") {
        await removeWithPowerShell(target, options);
      } else {
        await fs.rm(target, options);
      }
      return;
    } catch (error) {
      if (!transientRemoveErrors.has(error?.code) || attempt === attempts) throw error;
      await wait(attempt * 200);
    }
  }
}

await removeWithRetries(path.join(frontendOutputDir, ".vite"), removeOptions);
await removeWithRetries(adminHtmlPath, removeFileOptions);
for (const compressedPath of adminCompressedPaths) {
  await removeWithRetries(compressedPath, removeFileOptions);
}
if (isTempBuildOutput) {
  await removeWithRetries(frontendOutputDir, removeOptions);
}
await fs.mkdir(frontendOutputDir, { recursive: true });
if (!isTempBuildOutput) {
  await pruneOldAssets(frontendAssetsDir, ASSET_RETENTION_MS);
}

console.log(`Cleaned frontend build output: ${frontendOutputDir}`);

async function pruneOldAssets(assetsDir, retentionMs) {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return;
  let entries = [];
  try {
    entries = await fs.readdir(assetsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionMs;
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(assetsDir, entry.name);
    try {
      const stat = await fs.stat(target);
      if (stat.mtimeMs >= cutoff) return;
      await removeWithRetries(target, entry.isDirectory() ? removeOptions : removeFileOptions);
    } catch {
      // A concurrent build may have already replaced or removed the asset.
    }
  }));
}

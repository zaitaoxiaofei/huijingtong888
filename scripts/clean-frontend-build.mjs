import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const frontendOutputDir = path.resolve(rootDir, "public", "vue-apps");
const frontendAssetsDir = path.join(frontendOutputDir, "assets");
const adminHtmlPath = path.resolve(rootDir, "public", "admin.html");
const adminCompressedPaths = [
  path.resolve(rootDir, "public", "admin.html.br"),
  path.resolve(rootDir, "public", "admin.html.gz")
];
const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 250 };
const removeFileOptions = { force: true, maxRetries: 10, retryDelay: 250 };
const ASSET_RETENTION_MS = Number(process.env.FRONTEND_ASSET_RETENTION_MS || 24 * 60 * 60 * 1000);

await fs.rm(path.join(frontendOutputDir, ".vite"), removeOptions);
await fs.rm(adminHtmlPath, removeFileOptions);
for (const compressedPath of adminCompressedPaths) {
  await fs.rm(compressedPath, removeFileOptions);
}
await fs.mkdir(frontendOutputDir, { recursive: true });
await pruneOldAssets(frontendAssetsDir, ASSET_RETENTION_MS);

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
      await fs.rm(target, entry.isDirectory() ? removeOptions : removeFileOptions);
    } catch {
      // A concurrent build may have already replaced or removed the asset.
    }
  }));
}

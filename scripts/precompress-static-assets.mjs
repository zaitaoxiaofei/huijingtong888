import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const rootDir = process.cwd();
const publicDir = path.resolve(rootDir, "public");
const viteOutputDir = path.join(publicDir, "vue-apps");
const viteAssetsDir = path.join(viteOutputDir, "assets");
const viteManifestPath = path.join(viteOutputDir, ".vite", "manifest.json");
const compressExts = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md"]);
const sidecarExts = [".br", ".gz"];
const brotliQuality = clampInt(process.env.OZON_PRECOMPRESS_BROTLI_QUALITY, 6, 1, 11);
const gzipLevel = clampInt(process.env.OZON_PRECOMPRESS_GZIP_LEVEL, 6, 1, 9);
const concurrency = clampInt(process.env.OZON_PRECOMPRESS_CONCURRENCY, Math.max(2, Math.min(8, (await import("node:os")).cpus().length)), 1, 16);

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function addManifestEntry(manifest, key, keep, visited) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) return;
  if (entry.file) keep.add(path.resolve(viteOutputDir, entry.file));
  for (const file of entry.css || []) keep.add(path.resolve(viteOutputDir, file));
  for (const file of entry.assets || []) keep.add(path.resolve(viteOutputDir, file));
  for (const importKey of [...(entry.imports || []), ...(entry.dynamicImports || [])]) {
    addManifestEntry(manifest, importKey, keep, visited);
  }
}

async function pruneStaleViteAssets() {
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(viteManifestPath, "utf8"));
  } catch {
    return 0;
  }

  const keep = new Set();
  const visited = new Set();
  for (const key of Object.keys(manifest)) addManifestEntry(manifest, key, keep, visited);

  let removed = 0;
  const files = await walk(viteAssetsDir);
  await Promise.all(files.map(async (file) => {
    const sourceFile = sidecarExts.some((ext) => file.endsWith(ext))
      ? file.slice(0, file.endsWith(".br") ? -3 : -3)
      : file;
    if (keep.has(path.resolve(sourceFile))) return;
    await fs.rm(file, { force: true, maxRetries: 10, retryDelay: 250 });
    removed += 1;
  }));
  return removed;
}

async function isFresh(sourcePath, targetPath, sourceStat) {
  try {
    const targetStat = await fs.stat(targetPath);
    return targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size > 0;
  } catch {
    return false;
  }
}

async function writeCompressed(filePath) {
  if (filePath.endsWith(".br") || filePath.endsWith(".gz")) return false;
  if (!compressExts.has(path.extname(filePath).toLowerCase())) return false;
  const sourceStat = await fs.stat(filePath);
  const brPath = `${filePath}.br`;
  const gzPath = `${filePath}.gz`;
  const [hasFreshBr, hasFreshGz] = await Promise.all([
    isFresh(filePath, brPath, sourceStat),
    isFresh(filePath, gzPath, sourceStat)
  ]);
  if (hasFreshBr && hasFreshGz) return false;

  const source = await fs.readFile(filePath);
  await Promise.all([
    hasFreshBr ? null : brotliCompress(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality
      }
    }).then((br) => fs.writeFile(brPath, br)),
    hasFreshGz ? null : gzip(source, { level: gzipLevel }).then((gz) => fs.writeFile(gzPath, gz))
  ]);
  return true;
}

async function mapLimit(items, limit, mapper) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    let nextIndex = index;
    index += 1;
    while (nextIndex < items.length) {
      await mapper(items[nextIndex]);
      nextIndex = index;
      index += 1;
    }
  });
  await Promise.all(workers);
}

const removed = await pruneStaleViteAssets();
const files = await walk(publicDir);
let count = 0;
await mapLimit(files, concurrency, async (file) => {
  if (await writeCompressed(file)) count += 1;
});

console.log(`Precompressed ${count} static assets. Removed ${removed} stale Vite assets.`);

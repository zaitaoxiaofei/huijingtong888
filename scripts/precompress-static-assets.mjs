import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const rootDir = process.cwd();
const publicDir = path.resolve(rootDir, "public");
const compressExts = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md"]);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
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

async function writeCompressed(filePath) {
  if (filePath.endsWith(".br") || filePath.endsWith(".gz")) return false;
  if (!compressExts.has(path.extname(filePath).toLowerCase())) return false;
  const source = await fs.readFile(filePath);
  const [br, gz] = await Promise.all([
    brotliCompress(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11
      }
    }),
    gzip(source, { level: 9 })
  ]);
  await Promise.all([
    fs.writeFile(`${filePath}.br`, br),
    fs.writeFile(`${filePath}.gz`, gz)
  ]);
  return true;
}

const files = await walk(publicDir);
let count = 0;
for (const file of files) {
  if (await writeCompressed(file)) count += 1;
}

console.log(`Precompressed ${count} static assets.`);

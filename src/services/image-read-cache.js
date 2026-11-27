import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CACHE_FILE = /^[a-f0-9]{64}\.(?:bin|json|webp)$/;
const TEMP_FILE = /^[a-f0-9]{64}\.(?:bin|json|webp)\.[a-f0-9-]{36}\.tmp$/;

// Reproducible read caches only: a full/unsafe/unavailable cache never blocks images.
// Keep at most one write per process, without retaining a queue of image buffers.
// Another main/candidate can exceed the
// budget only by its one in-flight write, bounded to 8 MiB plus metadata.
export function createImageReadCacheWriter(directory, { maxBytes, maxFiles = 4096, now = Date.now } = {}) {
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 4096) throw new Error("Invalid image read cache budget");
  let writing = false;
  let blockedUntil = 0;
  let nextSweepAt = 0;
  async function write(entries) {
    if (now() < blockedUntil) return false;
    if (!Array.isArray(entries) || !entries.length || entries.length > 2
      || new Set(entries.map(entry => entry.name)).size !== entries.length
      || entries.some(entry => !CACHE_FILE.test(entry.name) || !Buffer.isBuffer(entry.buffer)
        || !entry.buffer.length || entry.buffer.length > (entry.name.endsWith(".json") ? 4096 : 8 * 1024 * 1024))
      || entries.reduce((bytes, entry) => bytes + entry.buffer.length, 0) > 8 * 1024 * 1024 + 4096) return false;
    const temporary = [];
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Release-local links may intentionally resolve to the dedicated shared cache.
      const root = await fs.realpath(directory);
      const files = new Map();
      let bytes = 0, scanned = 0, removed = 0;
      const sweep = now() >= nextSweepAt;
      if (sweep) nextSweepAt = now() + 60000;
      for await (const entry of await fs.opendir(root)) {
        if (++scanned > maxFiles) {
          blockedUntil = now() + 60000;
          return false;
        }
        if ((!CACHE_FILE.test(entry.name) && !TEMP_FILE.test(entry.name)) || !entry.isFile() || entry.isSymbolicLink()) {
          blockedUntil = now() + 60000;
          return false;
        }
        const stat = await fs.lstat(path.join(root, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || files.size >= maxFiles) {
          blockedUntil = now() + 60000;
          return false;
        }
        if (sweep && removed < 100 && CACHE_FILE.test(entry.name) && now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          const file = path.join(root, entry.name);
          const current = await fs.lstat(file);
          if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.ino === stat.ino
            && current.size === stat.size && current.mtimeMs === stat.mtimeMs) {
            await fs.unlink(file);
            removed += 1;
            continue;
          }
        }
        files.set(entry.name, stat.size);
        bytes += stat.size;
      }
      let count = files.size;
      for (const entry of entries) {
        bytes += entry.buffer.length - (files.get(entry.name) || 0);
        if (!files.has(entry.name)) count += 1;
      }
      if (bytes > maxBytes || count > maxFiles) {
        blockedUntil = now() + 60000;
        return false;
      }
      for (const entry of entries) {
        const file = path.join(root, entry.name);
        const staging = `${file}.${randomUUID()}.tmp`;
        temporary.push(staging);
        await fs.writeFile(staging, entry.buffer, { flag: "wx", mode: 0o600 });
        await fs.rename(staging, file);
      }
      return true;
    } catch {
      blockedUntil = now() + 60000;
      return false;
    } finally {
      // Only our own unfinished staging files, never any existing cached content.
      await Promise.all(temporary.map(file => fs.rm(file, { force: true }).catch(() => null)));
    }
  }
  return {
    async write(entries) {
      if (writing) return false;
      writing = true;
      try { return await write(entries); }
      finally { writing = false; }
    }
  };
}

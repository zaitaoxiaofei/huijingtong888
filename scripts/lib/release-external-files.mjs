import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const EXTERNAL_TOOL_FILES = ["tools/mutool.exe", "tools/SumatraPDF.exe"];
export async function fileHash(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function packageExternalFiles(root, output) {
  await fs.mkdir(output, { recursive: true });
  const result = [];
  for (const relative of EXTERNAL_TOOL_FILES) {
    const source = path.join(root, relative);
    const stat = await fs.lstat(source).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!stat) continue;
    if (!stat.isFile()) throw Error(`External tool must be a regular source file: ${relative}`);
    const sha256 = await fileHash(source), filename = `${sha256}.gz`;
    await pipeline(createReadStream(source), createGzip(), createWriteStream(path.join(output, filename)));
    result.push({ path: relative, sha256, size: stat.size, compressed_sha256: await fileHash(path.join(output, filename)) });
  }
  return result;
}
export function validateExternalFiles(files) {
  if (!Array.isArray(files) || files.length > EXTERNAL_TOOL_FILES.length) throw Error("Invalid external file manifest");
  const seen = new Set();
  for (const file of files) {
    if (!EXTERNAL_TOOL_FILES.includes(file.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !/^[a-f0-9]{64}$/.test(file.compressed_sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 128 * 1024 * 1024) throw Error("Invalid external file descriptor");
    seen.add(file.path);
  }
  return files;
}
export async function materializeExternalFiles(root, uploads, cache, { uid = 0 } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "deploy-manifest.json"), "utf8"));
  const files = validateExternalFiles(manifest.externalFiles || []);
  if (!files.length) return;
  await fs.mkdir(cache, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const target = path.join(cache, file.sha256);
    let stat = await fs.lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (stat) {
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o222) || stat.size !== file.size || await fileHash(target) !== file.sha256) throw Error("Immutable external file cache failed verification");
    } else {
      const compressed = path.join(uploads, `${file.sha256}.gz`);
      if (await fileHash(compressed) !== file.compressed_sha256) throw Error("Uploaded external file checksum mismatch");
      const temporary = `${target}.${crypto.randomBytes(6).toString("hex")}.partial`;
      try {
        let bytes = 0;
        const gunzip = createGunzip();
        gunzip.on("data", chunk => { bytes += chunk.length; if (bytes > file.size) gunzip.destroy(Error("External file exceeds declared size")); });
        await pipeline(createReadStream(compressed), gunzip, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        if (bytes !== file.size || await fileHash(temporary) !== file.sha256) throw Error("External file content checksum mismatch");
        await fs.chmod(temporary, 0o444);
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    const destination = path.join(root, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // A source file must not silently overwrite a separately materialized file.
    try { await fs.lstat(destination); throw Error("External file destination already exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.symlink(target, destination);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, root, uploads] = process.argv.slice(2);
  if (command !== "apply") throw Error("Unknown external file operation");
  await materializeExternalFiles(root, uploads, "/opt/ozon-erp/artifacts/files");
}

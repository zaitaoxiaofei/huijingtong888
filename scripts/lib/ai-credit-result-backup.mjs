import fs from "node:fs/promises";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const FILE = /^[1-9][0-9]*\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const MAX_BYTES = 2 * 1024 * 1024;
function absolute(value) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Explicit absolute backup paths required"); return path.resolve(value); }
function inside(parent, child) { const value = path.relative(parent, child); return !value || !value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value); }
async function notSymlink(target) { const info = await fs.lstat(target); if (info.isSymbolicLink()) throw new Error("AI backup refuses symbolic-link data"); return info; }
async function noSymlinkAncestors(target, allowMissing = false) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await notSymlink(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return; throw error; }
  }
}
async function readRegularFile(target, rootReal) {
  await noSymlinkAncestors(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(), named = await notSymlink(target);
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== named.dev || opened.ino !== named.ino
      || !inside(rootReal, await fs.realpath(target))) throw new Error("Private AI result changed or escapes private root");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error("Private AI result size changed");
    return bytes;
  } finally { await handle.close(); }
}
const line = value => `${JSON.stringify(value)}\n`;
async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, "r"); await handle.sync(); }
  catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

// File bytes are never logged. This snapshot is append-only result metadata;
// the separately verified SQL backup remains authoritative for customer bills.
export async function backupAiCreditResults({ root, output }) {
  root = absolute(root); output = absolute(output);
  if (inside(root, output)) throw new Error("Backup output must be outside private results");
  await noSymlinkAncestors(root);
  if (!(await notSymlink(root)).isDirectory()) throw new Error("Private result root is not a directory");
  const rootReal = await fs.realpath(root);
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) throw new Error("Unexpected private AI result directory");
    const directory = path.join(root, entry.name); await notSymlink(directory);
    for (const filename of await fs.readdir(directory)) {
      if (filename.endsWith(".tmp")) continue;
      const relative = `${entry.name}/${filename}`;
      if (!FILE.test(relative)) throw new Error("Unexpected private AI result filename");
      const metadata = await notSymlink(path.join(root, entry.name, filename));
      if (!metadata.isFile() || metadata.size > MAX_BYTES) throw new Error("Invalid private AI result file");
      files.push(relative);
    }
  }
  files.sort();
  const temporary = `${output}.${randomUUID()}.partial`, manifest = createHash("sha256");
  async function* content() {
    yield line({ format: "ozon-ai-private-results", version: 1 });
    for (const relative of files) {
      const bytes = await readRegularFile(path.join(root, ...relative.split("/")), rootReal);
      JSON.parse(bytes.toString("utf8"));
      const record = line({ file: relative, sha256: sha(bytes), data: bytes.toString("base64") });
      manifest.update(record); yield record;
    }
    yield line({ complete: true, count: files.length, sha256: manifest.digest("hex") });
  }
  await noSymlinkAncestors(path.dirname(output), true);
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await noSymlinkAncestors(path.dirname(output));
  let ownsTemporary = false, installed = false;
  try {
    const target = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    target.once("open", () => { ownsTemporary = true; });
    await pipeline(Readable.from(content()), createGzip(), target);
    const archive = await fs.open(temporary, "r+");
    try { await archive.sync(); } finally { await archive.close(); }
    // Never replace an existing verified archive.
    await fs.link(temporary, output);
    installed = true;
    const proof = await inspectAiCreditResultBackup({ input: output });
    await syncDirectory(path.dirname(output));
    return { ok: true, files: proof.files, output, content_sha256: proof.content_sha256 };
  } catch (error) { if (installed) await fs.unlink(output); throw error; }
  finally { if (ownsTemporary) await fs.rm(temporary, { force: true }); }
}

async function consume(input, each) {
  const source = createReadStream(input, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }), decoder = createGunzip();
  source.on("error", error => decoder.destroy(error));
  const stream = source.pipe(decoder);
  let lineBytes = 0;
  stream.on("data", chunk => {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      if (lineBytes + end - start > 3 * 1024 * 1024) { decoder.destroy(new Error("AI backup line exceeds limit")); return; }
      lineBytes = 0; start = end + 1;
    }
    lineBytes += chunk.length - start;
    if (lineBytes > 3 * 1024 * 1024) decoder.destroy(new Error("AI backup line exceeds limit"));
  });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const manifest = createHash("sha256"), seen = new Set();
  let header = false, complete = false, footer;
  // Pipe errors must also terminate the async line iterator.
  const onError = error => reader.close();
  let streamError; stream.on("error", error => { streamError = error; onError(error); });
  try {
    for await (const text of reader) {
      if (text.length > 3 * 1024 * 1024 || complete) throw new Error("Invalid AI result archive framing");
      const record = JSON.parse(text);
      if (!header) {
        if (record.format !== "ozon-ai-private-results" || record.version !== 1) throw new Error("Unsupported AI result backup format");
        header = true; continue;
      }
      if (record.complete === true) { complete = true; footer = record; continue; }
      if (!FILE.test(record.file) || seen.has(record.file) || typeof record.data !== "string"
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)) throw new Error("Invalid AI result archive entry");
      const bytes = Buffer.from(record.data, "base64");
      if (bytes.length > MAX_BYTES || bytes.toString("base64") !== record.data || sha(bytes) !== record.sha256) throw new Error("AI result archive content hash mismatch");
      JSON.parse(bytes.toString("utf8"));
      seen.add(record.file); manifest.update(text + "\n");
      if (each) await each(record.file, bytes, record.sha256);
    }
    if (streamError) throw streamError;
    const expected = manifest.digest("hex");
    if (!complete || footer.count !== seen.size || footer.sha256 !== expected) throw new Error("AI result backup incomplete or corrupt");
    return { files: seen.size, content_sha256: expected };
  } finally { reader.close(); stream.destroy(); source.destroy(); }
}

export async function inspectAiCreditResultBackup({ input }) {
  input = absolute(input); await noSymlinkAncestors(input);
  if (!(await notSymlink(input)).isFile()) throw new Error("AI result archive must be a regular file");
  return consume(input);
}

export async function restoreAiCreditResults({ input, root, apply = false }) {
  input = absolute(input); root = absolute(root);
  if (inside(root, input)) throw new Error("Restore source must be outside the result directory");
  const proof = await inspectAiCreditResultBackup({ input }); // Validate all entries before any writes.
  if (!apply) return { ok: true, mode: "dry-run", ...proof, written: 0 };
  await noSymlinkAncestors(root, true);
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); await noSymlinkAncestors(root);
  const rootReal = await fs.realpath(root), created = [];
  try {
    let written = 0;
    const after = await consume(input, async (relative, bytes, expected) => {
      const file = path.join(root, ...relative.split("/")), directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await notSymlink(directory);
      if (!inside(rootReal, await fs.realpath(directory))) throw new Error("Restore destination escapes private root");
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle, ownsTemporary = false;
      try {
        handle = await fs.open(temporary, "wx", 0o600); ownsTemporary = true;
        await handle.writeFile(bytes); await handle.sync();
        const identity = await handle.stat();
        await fs.link(temporary, file); created.push({ file, dev: identity.dev, ino: identity.ino });
        written += 1;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (sha(await readRegularFile(file, rootReal)) !== expected) throw new Error("Existing result differs; refusing overwrite");
      } finally {
        await handle?.close();
        if (ownsTemporary) await fs.unlink(temporary);
      }
      await syncDirectory(directory);
    });
    if (after.files !== proof.files || after.content_sha256 !== proof.content_sha256) throw new Error("Archive changed during restore");
    await syncDirectory(root);
    return { ok: true, mode: "apply", ...after, written };
  } catch (error) {
    // Remove only files created by this attempt. No existing data is replaced.
    for (const { file, dev, ino } of created) {
      if (!inside(root, file)) continue;
      const current = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (current && !current.isSymbolicLink() && current.dev === dev && current.ino === ino) await fs.unlink(file);
    }
    throw error;
  }
}

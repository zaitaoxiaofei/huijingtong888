import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import {assertMediaCacheDiskSpace} from './media-cache-space.js';
import { ossStorageConfig, putContentAddressedFile, consumeVerifiedContentAddressedBody } from "./object-storage.js";
import { createServerOssClient } from "./oss-client.js";

const queryDatabase = async (...args) => (await import("../mysql-pool.js")).mysqlQuery(...args);
const registerSource = async (...args) => (await import("./media-migration-map.js")).registerMediaMigrationSource(...args);
const markVerified = async (...args) => (await import("./media-migration-map.js")).markMediaMigrationVerified(...args);
export const cacheSourceFingerprint = source => crypto.createHash("sha256").update(source).digest("hex");

export const MEDIA_CACHE_ROOTS = ["ai-generated", "ai-cropped", "shop-variants", "shop-watermarks", "asset-tail-templates", "temp"];
export const MEDIA_CACHE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".mp4", ".webm", ".mov"]);
const MAX_BYTES = 100 * 1024 * 1024;
const recovering = new Map();
let activeRecoveries=0;
const recoveryWaiters=[];
async function boundedRecovery(work){
  if(activeRecoveries>=2)await new Promise(resolve=>recoveryWaiters.push(resolve));else activeRecoveries++;
  try{return await work();}finally{const next=recoveryWaiters.shift();if(next)next();else activeRecoveries--;}
}

export function mediaCacheSource(filePath, cwd = process.cwd()) {
  const relative = path.relative(path.resolve(cwd, "uploads"), path.resolve(filePath)).split(path.sep).join("/");
  if (!MEDIA_CACHE_ROOTS.includes(relative.split("/")[0]) || relative.split("/").some(part => !part || part === "..")
    || relative.startsWith("temp/") && !relative.startsWith("temp/image-cropper/")
    || !MEDIA_CACHE_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error("File is outside managed media cache roots");
  return `/uploads/${relative}`;
}

// Enumerate bounded recovery metadata without downloading any media bodies.
export async function listMediaCacheDirectorySources(root, { cwd=process.cwd(),query=queryDatabase }={}) {
  root=path.resolve(root);
  await assertCacheLocation(path.join(root,"index.png"),cwd);
  const prefix=mediaCacheSource(path.join(root,"index.png"),cwd).replace(/index\.png$/,"");
  const pattern=`${prefix.replace(/[!_%]/g,match=>`!${match}`)}%`;
  const rows=await query("SELECT source_url, UNIX_TIMESTAMP(created_at)*1000 AS created_ms FROM media_migration_map WHERE status='verified' AND source_url LIKE ? ESCAPE '!' LIMIT 1001",[pattern])
    .catch(error=>{if(error.code==="ER_NO_SUCH_TABLE")return [];throw error;});
  if(rows.length>1000)throw new Error("Media cache task exceeds directory recovery bound");
  return rows.map(row=>{
    if(typeof row.source_url!=="string"||!row.source_url.startsWith(prefix))throw new Error("Media cache source differs from recovery directory");
    const file=path.resolve(root,row.source_url.slice(prefix.length));
    if(!file.startsWith(`${root}${path.sep}`))throw new Error("Media cache directory traversal");
    return {filePath:file,createdMs:Number(row.created_ms)||0};
  });
}

export async function restoreMediaCacheDirectory(root, { cwd=process.cwd(),query=queryDatabase,directOnly=false,...options }={}) {
  const sources=await listMediaCacheDirectorySources(root,{cwd,query});
  for(const {filePath:file} of sources){
    if(directOnly&&path.dirname(file)!==path.resolve(root))continue;
    if(!await restoreMediaCacheFile(file,{cwd,query,...options}))throw new Error("Media cache recovery mapping disappeared");
  }
  return sources.length;
}

function clientFromEnv(env) {
  const storage = ossStorageConfig(env);
  if (!storage.enabled) throw Object.assign(new Error("OSS 未启用，不能将图片或视频仅保存为本地文件"), { statusCode: 503 });
  return createServerOssClient(storage, { env });
}

async function assertCacheLocation(filePath, cwd) {
  const source = mediaCacheSource(filePath, cwd), area = source.split("/")[2];
  const root = path.resolve(cwd, "uploads", area);
  await fsp.mkdir(root, { recursive: true });
  const realRoot = await fsp.realpath(root);
  let parent = path.dirname(filePath);
  for (;;) {
    try {
      const realParent = await fsp.realpath(parent), relative = path.relative(realRoot, realParent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Media cache parent escapes its root");
      break;
    } catch (error) { if (error.code !== "ENOENT") throw error; parent = path.dirname(parent); }
  }
}

function assertMediaObjectFingerprint(object) {
  if (!/^[a-f0-9]{64}$/.test(object.hashSha256 || "") || !Number.isSafeInteger(object.size) || object.size <= 0 || object.size > MAX_BYTES
    || !/^(?:listing-media|ai-task-media)\/[a-zA-Z0-9_./-]+$/.test(object.objectKey || "")
    || object.objectKey.split("/").some(part => !part || part === ".." || part === ".")) throw new Error("Invalid media object fingerprint");
}

// Verify the actual remote body. A matching object name/size alone is not proof.
export async function verifyMediaObject(client, object, { destination = null } = {}) {
  assertMediaObjectFingerprint(object);
  const response = await client.getStream(object.objectKey);
  const hash = crypto.createHash("sha256"); let bytes = 0;
  const verifier = new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    if (bytes > object.size) return done(new Error("OSS media size mismatch"));
    hash.update(chunk); done(null, chunk);
  } });
  if (destination) await pipeline(response.stream, verifier, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  else { verifier.resume(); await pipeline(response.stream, verifier); }
  if (bytes !== object.size || hash.digest("hex") !== object.hashSha256) throw new Error("OSS media checksum mismatch");
  return { size: bytes, hashSha256: object.hashSha256 };
}

export async function archiveMediaCacheFile(filePath, { cwd = process.cwd(), sourceUrl = "", storedObject = null,
  env = process.env, client = null, put = putContentAddressedFile, register = registerSource, mark = markVerified } = {}) {
  const source = mediaCacheSource(filePath, cwd), oss = client || clientFromEnv(env);
  await assertCacheLocation(filePath, cwd);
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_BYTES) throw new Error("Invalid media cache file");
  const extension = path.extname(filePath).toLowerCase();
  const contentType = ({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".avif":"image/avif",".mp4":"video/mp4",".webm":"video/webm",".mov":"video/quicktime"})[extension];
  const stored = storedObject || await put(filePath, { prefix: "ai-task-media", extension, contentType, privateObject: true, env, client: oss });
  if (!stored) throw new Error("OSS media persistence failed");
  const localHash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) localHash.update(chunk);
  if (stored.size !== stat.size || stored.hashSha256 !== localHash.digest("hex")) throw new Error("Local media differs from OSS fingerprint");
  assertMediaObjectFingerprint(stored);
  if (!consumeVerifiedContentAddressedBody(stored, { client: oss })) await verifyMediaObject(oss, stored);
  const after = await fsp.lstat(filePath);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Media cache changed while archiving");
  for (const url of new Set([source, sourceUrl].filter(Boolean))) {
    await register({ sourceUrl: url, sourceModule: "durable_media_cache", mediaKind: /^\.(mp4|mov|webm)$/.test(path.extname(filePath)) ? "video" : "image" });
    await mark({ sourceUrl: url, contentHashSha256: stored.hashSha256, byteSize: stored.size,
      ossBucket: stored.bucket, ossObjectKey: stored.objectKey, ossUrl: stored.url });
  }
  return { source, ...stored };
}

export async function restoreMediaCacheFile(filePath, { cwd = process.cwd(), env = process.env, client = null, query = queryDatabase } = {}) {
  filePath = path.resolve(filePath);
  const source = mediaCacheSource(filePath, cwd);
  if (recovering.has(filePath)) return recovering.get(filePath);
  const work = (async () => {
    await assertCacheLocation(filePath, cwd);
    const existing = await fsp.lstat(filePath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) { if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe media cache file"); return true; }
    return boundedRecovery(async () => {
      const [row] = await query("SELECT content_hash_sha256, byte_size, oss_object_key, oss_bucket FROM media_migration_map WHERE source_fingerprint=? AND status='verified' LIMIT 1", [cacheSourceFingerprint(source)]).catch(error => { if (error.code === "ER_NO_SUCH_TABLE") return []; throw error; });
      if (!row) return false;
      const storage = ossStorageConfig(env);
      if (row.oss_bucket !== storage.bucket) throw new Error("Media cache OSS bucket differs from configured storage");
      const object = { hashSha256: row.content_hash_sha256, size: Number(row.byte_size), objectKey: row.oss_object_key };
      await assertMediaCacheDiskSpace({directory:path.resolve(cwd,'uploads'),additionalBytes:object.size,env});
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${crypto.randomUUID()}.partial`;
      try {
        await verifyMediaObject(client || clientFromEnv(env), object, { destination: temporary });
        await fsp.rename(temporary, filePath);
        return true;
      } finally { await fsp.rm(temporary, { force: true }); }
    });
  })();
  recovering.set(filePath, work);
  try { return await work; } finally { recovering.delete(filePath); }
}

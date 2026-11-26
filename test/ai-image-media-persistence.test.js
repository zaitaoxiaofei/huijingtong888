import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { Readable } from "node:stream";
import { parse } from "acorn";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "media_cache_test";
process.env.DB_USER ||= "test";
const { archiveMediaCacheFile, restoreMediaCacheFile } = await import("../src/services/media-cache-files.js");

async function loadFunction(context, file, name) {
  const source = await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const declaration = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .map(node => node.declaration || node).find(node => node.type === "FunctionDeclaration" && node.id.name === name);
  assert.ok(declaration, `Missing actual function ${name}`);
  vm.runInContext(source.slice(declaration.start, declaration.end), context, { filename: file });
}

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-media-persistence-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("ai-media-persistence-"));
    return fs.rm(cwd, { recursive: true, force: true });
  });
  const env = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-test", OSS_BUCKET: "test", OSS_ACCESS_KEY_ID: "id", OSS_ACCESS_KEY_SECRET: "secret", STORAGE_VERIFIED_WRITES_ENABLED: "1", MEDIA_CACHE_LIFECYCLE_ENABLED: "1", MEDIA_CACHE_MIN_FREE_BYTES: String(512 * 1024 ** 2) };
  const content = Buffer.from("generated owned media"), objects = new Map(), events = [];
  let providerCalls = 0, archives = 0, downloads = 0, failArchive = false;
  const client = {
    async head(key) { if (!objects.has(key)) throw Object.assign(Error("missing"), { status: 404 });return { res: { headers: { "content-length": String(objects.get(key).length) } } }; },
    async putStream(key, stream, options) { assert.equal(options.headers["x-oss-object-acl"], "private");const chunks=[];for await (const chunk of stream) chunks.push(chunk);objects.set(key, Buffer.concat(chunks)); },
    async getACL() { return { acl: "private" }; },
    async getStream(key) { downloads++;return { stream: Readable.from([objects.get(key)]) }; }
  };
  const resolveGeneratedTaskDir = id => path.join(cwd, "uploads", "ai-generated", id);
  const restore = file => restoreMediaCacheFile(file, { cwd, env, client, query: async () => [] });
  const context = vm.createContext({
    fs, path, crypto, Buffer, process: { env }, SIZE_BY_RATIO: { "3:4": "1024x1536" },
    console: { error() {} }, withMediaCacheLease: async work => work(),
    aiImageRuntimeConfig: async () => ({ provider: "fixture" }), validateTaskId: id => id,
    clampImageCount: value => Number(value), normalizeRatio: () => "3:4", resolveGeneratedTaskDir,
    restoreMediaCacheFile: restore, registerAiImageTaskOwner: async () => {},
    firstProviderJob: () => null, resolveSourceImagesWithFallback: async () => null,
    assertCurrentAiTenantPermission: async () => {},
    requestCompatibleImage: async () => { providerCalls++;events.push("provider");return content; },
    createImageRecord: (taskId, scope, filename) => ({ filename, url: `/api/ai/file/${taskId}/${scope}/${filename}` }),
    getAiTaskFile: async (taskId, _scope, filename) => { const filePath=path.join(resolveGeneratedTaskDir(taskId),filename);await restore(filePath);return { filePath }; },
    zipUrl: taskId => `/api/ai/download-zip/${taskId}`,
    archiveMediaCacheFile: async (file, options) => {
      archives++;events.push("archive");if(failArchive)throw Error("OSS offline");
      return archiveMediaCacheFile(file, { ...options, cwd, env, client, register: async () => {}, mark: async () => {} });
    }
  });
  await loadFunction(context, "src/server/services/openai/imageGenerationService.js", "generateOpenAiImages");
  await loadFunction(context, "src/server/services/ai/aiWorkflowService.js", "generateImagesInternal");
  return { context, events, get providerCalls() { return providerCalls; }, get archives() { return archives; }, get downloads() { return downloads; }, set failArchive(value) { failArchive=value; } };
}

test("workflow checkpoints a generated original before one archive and one complete OSS readback", async t => {
  const f = await fixture(t);
  const result = await f.context.generateImagesInternal({ finalPrompt: "fixture", imageCount: 1, autoCrop: false, onGeneratedOutput: async () => f.events.push("checkpoint") });
  assert.equal(result.generatedImages.length, 1);
  assert.deepEqual(f.events, ["provider", "checkpoint", "archive"]);
  assert.equal(f.providerCalls, 1);assert.equal(f.archives, 1);assert.equal(f.downloads, 1);
});

test("storage retry reuses the checkpointed local original without another provider purchase", async t => {
  const f = await fixture(t);let taskId;
  const payload = { finalPrompt: "fixture", imageCount: 1, autoCrop: false, onGeneratedOutput: async ({ result }) => { taskId=result.taskId;f.events.push("checkpoint"); } };
  f.failArchive = true;
  await assert.rejects(f.context.generateImagesInternal(payload), error => error.code === "AI_GENERATION_STORAGE_PENDING");
  assert.ok(taskId);assert.equal(f.providerCalls, 1);
  f.failArchive = false;
  const result = await f.context.generateImagesInternal(payload, taskId);
  assert.equal(result.taskId, taskId);assert.equal(f.providerCalls, 1);assert.equal(f.archives, 2);assert.equal(f.downloads, 1);
});

test("direct provider adapter calls retain default media persistence", async t => {
  const f = await fixture(t);
  await f.context.generateOpenAiImages({ taskId: "direct-task", finalPrompt: "fixture", imageCount: 1 });
  assert.equal(f.providerCalls, 1);assert.equal(f.archives, 1);assert.equal(f.downloads, 1);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import {
  AI_WORKBENCH_PROXY_FALLBACK_ASSET_NAMES,
  AI_WORKBENCH_PROXY_FALLBACK_ASSETS
} from "../src/http/aiWorkbenchProxyAssets.js";
import { createStaticHandler } from "../src/http/static.js";

function createMockResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers || {};
  };
  res.bodyText = () => Buffer.concat(chunks).toString("utf8");
  return res;
}

test("static handler falls back to ai-workbench-proxy for the pinned AI runtime chunk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js"),
    "export default { name: 'LegacyAiWorkbench' };\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/vue-apps/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.match(res.bodyText(), /LegacyAiWorkbench/);
  assert.equal(res.headers["Content-Type"], "text/javascript; charset=utf-8");
});

test("static handler does not fall back to ai-workbench-proxy for non-workbench chunks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "vendor-legacy-20260611213517.js"),
    "export const legacyVendor = true;\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/vue-apps/assets/vendor-legacy-20260611213517.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.bodyText(), /legacyVendor/);
});

test("static handler falls back only for known AI workbench runtime dependencies", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "vendor-Ca6FriUE-20260611213517.js"),
    "export const knownAiWorkbenchVendor = true;\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/vue-apps/assets/vendor-Ca6FriUE-20260611213517.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.match(res.bodyText(), /knownAiWorkbenchVendor/);
});

test("static handler includes all known direct AI workbench dependency chunks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "vendor-pinia-CvTdJpv6-20260611213517.js"),
    "export const knownPiniaDependency = true;\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/ai-workbench-proxy/assets/vendor-pinia-CvTdJpv6-20260611213517.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.match(res.bodyText(), /knownPiniaDependency/);
  assert.equal(res.headers["Cache-Control"], "no-store, must-revalidate");
});

test("static handler only serves versioned proxy chunks through vue-apps fallback", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "vendor.js"),
    "export const unversionedVendor = true;\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/vue-apps/assets/vendor.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.bodyText(), /unversionedVendor/);
});

test("direct allowed ai-workbench-proxy assets are not browser cached", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js"),
    "export default { name: 'RuntimeAsset' };\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store, must-revalidate");
  assert.match(res.bodyText(), /RuntimeAsset/);
});

test("direct ai-workbench-proxy assets reject files outside the allowlist", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "UnexpectedWorkbenchPatch-20260611213517.js"),
    "export const unexpectedPatch = true;\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/ai-workbench-proxy/assets/UnexpectedWorkbenchPatch-20260611213517.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.bodyText(), /unexpectedPatch/);
});

test("static handler rejects traversal into sibling directories with matching prefix", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  const siblingDir = path.join(tmpDir, "public-evil");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(path.join(siblingDir, "secret.js"), "export const leaked = true;\n", "utf8");

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/../public-evil/secret.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.notEqual(res.statusCode, 200);
  assert.doesNotMatch(res.bodyText(), /leaked/);
});

test("static handler serves admin shell when reload query is present", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, "admin.html"), "<div id=\"adminApp\"></div>\n", "utf8");

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/admin.html?_erp_chunk_reload=test#/asset-variant-center/wizard",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.match(res.bodyText(), /adminApp/);
  assert.equal(res.headers["Cache-Control"], "no-store, must-revalidate");
});

test("all allowlisted AI workbench proxy assets exist in the checked-in proxy directory", async () => {
  const proxyAssetsDir = path.resolve("public", "ai-workbench-proxy", "assets");
  const missing = [];

  for (const fileName of AI_WORKBENCH_PROXY_FALLBACK_ASSETS) {
    try {
      const stat = await fs.stat(path.join(proxyAssetsDir, fileName));
      if (!stat.isFile()) missing.push(fileName);
    } catch {
      missing.push(fileName);
    }
  }

  assert.deepEqual(missing, []);
});

test("AI workbench proxy allowlist contains only direct js/css asset basenames", () => {
  const invalid = AI_WORKBENCH_PROXY_FALLBACK_ASSET_NAMES.filter((fileName) => {
    return fileName !== path.basename(fileName) || !/\.(?:js|css)$/i.test(fileName) || /\.(?:br|gz)$/i.test(fileName);
  });
  assert.deepEqual(invalid, []);
  assert.equal(AI_WORKBENCH_PROXY_FALLBACK_ASSETS.size, AI_WORKBENCH_PROXY_FALLBACK_ASSET_NAMES.length);
});

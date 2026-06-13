import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
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

test("static handler falls back to ai-workbench-proxy for legacy AI split chunks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-static-"));
  const publicDir = path.join(tmpDir, "public");
  await fs.mkdir(path.join(publicDir, "ai-workbench-proxy", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "ai-workbench-proxy", "assets", "AiOptimizationWorkbenchV2-oldhash-20260611213517.js"),
    "export default { name: 'LegacyAiWorkbench' };\n",
    "utf8"
  );

  const serveStatic = createStaticHandler(publicDir);
  const res = createMockResponse();
  serveStatic(
    "/vue-apps/assets/AiOptimizationWorkbenchV2-oldhash-20260611213517.js",
    { headers: {} },
    res
  );

  await new Promise((resolve) => res.on("finish", resolve));
  assert.equal(res.statusCode, 200);
  assert.match(res.bodyText(), /LegacyAiWorkbench/);
  assert.equal(res.headers["Content-Type"], "text/javascript; charset=utf-8");
});

test("static handler does not serve proxy vendor chunks through vue-apps fallback", async () => {
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

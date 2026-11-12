import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { createStaticHandler, isVersionedVueAssetPath } from "../src/http/static.js";

test("public build assets include the fingerprinted Ozon PNG without opening private files", () => {
  for (const name of [
    "/vue-apps/assets/ozon-CRKsgubQ.png",
    "/vue-apps/assets/admin-view-BUbM7yDj.js",
    "/vue-apps/assets/admin-style-abcdef.css"
  ]) assert.equal(isVersionedVueAssetPath(name), true, name);
  for (const name of [
    "/uploads/shop-variants/ozon-CRKsgubQ.png",
    "/uploads/ai-generated/private-abcdef.png",
    "/api/products/1/image",
    "/vue-apps/assets/ozon.png",
    "/vue-apps/assets/private-abcdef.json",
    "/vue-apps/assets/nested/ozon-CRKsgubQ.png",
    "/vue-apps/assets/../uploads/private-abcdef.png"
  ]) assert.equal(isVersionedVueAssetPath(name), false, name);
});

test("fingerprinted PNG is served as an immutable image and a missing image stays a 404", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-built-images-"));
  try {
    await fs.mkdir(path.join(root, "vue-apps", "assets"), { recursive: true });
    const logo = await fs.readFile(new URL("../frontend/admin/assets/marketplaces/ozon.png", import.meta.url));
    await fs.writeFile(path.join(root, "vue-apps", "assets", "ozon-CRKsgubQ.png"), logo);
    const serve = createStaticHandler(root);
    for (const [file, status] of [["ozon-CRKsgubQ.png", 200], ["missing-abcdef.png", 404]]) {
      const chunks = [];
      const response = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
      response.writeHead = (code, headers) => { response.statusCode = code; response.headers = headers; };
      const finished = once(response, "finish");
      serve("/vue-apps/assets/" + file, { method: "GET", headers: {} }, response);
      await finished;
      assert.equal(response.statusCode, status);
      assert.equal(response.headers["Content-Type"], "image/png");
      if (status === 200) {
        assert.deepEqual(Buffer.concat(chunks), logo);
        assert.match(response.headers["Cache-Control"], /public.*immutable/);
      }
    }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "ozon-built-images-")));
    await fs.rm(root, { recursive: true, force: true });
  }
});

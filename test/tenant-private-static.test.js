import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import { createStaticHandler } from "../src/http/static.js";

test("private attachments and original AI media cannot bypass authentication through static aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-private-static-test-"));
  try {
    const paths = ["uploads/team-attachments/a.pdf", "uploads/ai-generated/a.png", "uploads/ai-cropped/a.png", "uploads/temp/image-cropper/task/source.png", "uploads/shop-variants/a.png", "uploads/shop-watermarks/a.png", "preview/uploads/ai-generated/a.png"];
    for (const name of [...paths, "uploads/listing-media/public-product.png"]) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), "private data");
    }
    const serve = createStaticHandler(root, { extraRouteRoots: [{ prefix: "/uploads/team-attachments/", roots: [path.join(root, "uploads/team-attachments")] }] });
    for (const method of ["GET", "HEAD"]) for (const name of paths) {
      const chunks = [];
      const response = new Writable({ write(chunk, encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
      response.writeHead = status => { response.statusCode = status; };
      const finished = once(response, "finish");
      serve(`/${name}`, { method, headers: { range: "bytes=0-10", "if-none-match": "anything" } }, response);
      await finished;
      assert.equal(response.statusCode, 404, `${method} ${name}`);
      assert.ok(!Buffer.concat(chunks).toString().includes("private data"));
    }
    const response = new Writable({ write(chunk, encoding, next) { next(); } });
    response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
    const finished = once(response, "finish");
    serve("/uploads/listing-media/public-product.png", { method: "GET", headers: {} }, response);
    await finished;
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["Cache-Control"], /public/);
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.join(os.tmpdir(), "ozon-private-static-test-")));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

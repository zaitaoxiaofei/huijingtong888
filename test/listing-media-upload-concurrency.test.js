import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { putContentAddressedFile } from "../src/services/object-storage.js";

const client = readFileSync(new URL("../frontend/admin/api/tools/imageCropper.js", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declaration = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).find(node => node.type === "FunctionDeclaration" && node.id.name === "readListingMediaMultipart");

test("sixteen concurrent FormData uploads keep independent responses, temp files and byte-addressed OSS keys", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listing-upload-isolation-"));
  try {
  const tempFiles = [], requests = [], stored = new Map();
  const server = vm.createContext({ Buffer, fs, path, crypto, os: { tmpdir: () => directory },
    LISTING_MEDIA_MAX_BYTES: 1024 * 1024, LISTING_MEDIA_MULTIPART_FIELD_MAX_BYTES: 65536, LISTING_MEDIA_MULTIPART_HEADER_MAX_BYTES: 65536 });
  vm.runInContext(source.slice(declaration.start, declaration.end), server);
  const context = vm.createContext({ FormData, crypto, setTimeout, getAuthToken: () => "fixture-token",
    apiClient: new Proxy({}, { get() { throw new Error("Multipart uploads must not enter the JSON request cache"); } }),
    fetch: async (url, options) => {
      assert.equal(url, "/api/listing/media/upload");
      assert.equal(options.method, "POST");
      assert.ok(options.body instanceof FormData);
      const request = new Request("https://fixture.invalid" + url, options);
      const incoming = Readable.fromWeb(request.body);
      incoming.headers = Object.fromEntries(request.headers);
      const file = await server.readListingMediaMultipart(incoming);
      tempFiles.push(file.filePath);
      requests.push({ source: file.fields.source_id, requestId: file.fields.upload_request_id });
      const storedObject = await putContentAddressedFile(file.filePath, {
        extension: ".jpg", contentType: "image/jpeg",
        env: { OSS_ENABLED: "true", OSS_REGION: "oss-cn-test", OSS_BUCKET: "fixture-bucket", OSS_ACCESS_KEY_ID: "fixture", OSS_ACCESS_KEY_SECRET: "fixture" },
        client: { head: async () => { throw Object.assign(new Error("Missing fixture object"), { status: 404 }); },
          putStream: async (key, stream) => {
            const chunks = []; for await (const chunk of stream) chunks.push(chunk);
            stored.set(key, Buffer.concat(chunks));
          } }
      });
      return { ok: true, status: 200, json: async () => ({ ok: true, publishUrl: storedObject.url, source_id: file.fields.source_id, hash: storedObject.hashSha256 }) };
    } });
  vm.runInContext(client.replace(/^\uFEFF?import[^;]*;\r?\n/m, "").replaceAll("export ", ""), context);
    // Deliberately identical filenames and wall clock: storage must depend on
    // request-local bytes, never on a filename, source template or millisecond.
    const files = Array.from({ length: 16 }, (_, i) => Buffer.from(`independent-image-bytes-${i}`));
    const results = await Promise.all(files.map((bytes, index) => context.uploadListingMedia(
      new File([bytes], "watermarked-4-2.jpg", { type: "image/jpeg" }),
      { source_id: `draft-${Math.floor(index / 8)}:4:${index % 8 + 1}`, shop_id: 4 }
    )));
    assert.equal(requests.length, 16);
    assert.equal(new Set(requests.map(item => item.requestId)).size, 16);
    assert.equal(new Set(tempFiles).size, 16);
    assert.equal(stored.size, 16);
    assert.equal(new Set(results.map(item => item.publishUrl)).size, 16);
    for (const [index, result] of results.entries()) {
      assert.equal(result.source_id, `draft-${Math.floor(index / 8)}:4:${index % 8 + 1}`);
      assert.equal(result.hash, crypto.createHash("sha256").update(files[index]).digest("hex"));
      const key = decodeURIComponent(new URL(result.publishUrl).pathname.slice(1));
      assert.deepEqual(stored.get(key), files[index]);
    }
  } finally {
    // Only the freshly created fixture directory is removed, using one Node
    // filesystem API; no production/runtime upload roots are involved.
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  resolvePersistentUploadsRoot,
  resolveRuntimeProjectRoot,
  resolveUploadSubdirRoots
} from "../src/runtime-uploads.js";

test("persistent uploads default outside deploy runtime folder", () => {
  const cwd = path.resolve("dist", "deploy");
  assert.equal(resolveRuntimeProjectRoot(cwd), path.resolve("."));
  assert.equal(resolvePersistentUploadsRoot({ cwd, env: {} }), path.resolve("uploads"));
});

test("persistent uploads can be configured relative to runtime folder", () => {
  const cwd = path.resolve("dist", "deploy");
  assert.equal(
    resolvePersistentUploadsRoot({ cwd, env: { UPLOADS_ROOT: "..\\..\\runtime-uploads" } }),
    path.resolve("runtime-uploads")
  );
});

test("upload subdir roots keep legacy deploy path for reads", () => {
  const cwd = path.resolve("dist", "deploy");
  assert.deepEqual(resolveUploadSubdirRoots("shop-watermarks", { cwd, env: {} }), [
    path.resolve("uploads", "shop-watermarks"),
    path.resolve("dist", "deploy", "uploads", "shop-watermarks")
  ]);
});

test("listing media uses the persistent upload roots before legacy public paths", async () => {
  const serviceSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/services/listing-automation.js", import.meta.url), "utf8"));
  const serverSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/server.js", import.meta.url), "utf8"));
  assert.match(serviceSource, /resolveUploadSubdirRoots\("listing-media"\)/);
  assert.match(serverSource, /resolveUploadSubdirRoots\("listing-media"\)/);
});

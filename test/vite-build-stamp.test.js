import test from "node:test";
import assert from "node:assert/strict";

test("release branch provenance cannot create nested asset paths or URL fragments", async () => {
  const previous = process.env.OZON_BUILD_STAMP;
  try {
    process.env.OZON_BUILD_STAMP = "release/hotfix@abc123?x#y\\z";
    const { default: config } = await import(`../vite.config.js?stamp-test=${Date.now()}`);
    const output = config.build.rollupOptions.output;
    for (const key of ["entryFileNames", "chunkFileNames", "assetFileNames"]) {
      assert.equal(output[key].split("/").length, 2);
      assert.ok(output[key].includes("release-hotfix-abc123-x-y-z"));
      assert.doesNotMatch(output[key], /[@?#\\]/);
    }
  } finally {
    if (previous === undefined) delete process.env.OZON_BUILD_STAMP;
    else process.env.OZON_BUILD_STAMP = previous;
  }
});

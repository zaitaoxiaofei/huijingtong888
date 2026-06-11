import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const releaseManagerSource = readFileSync(new URL("../tools/release-manager/server.mjs", import.meta.url), "utf8");

test("release replacement preserves runtime upload roots when release packages exclude uploads", () => {
  assert.match(releaseManagerSource, /function replaceDirFromRelease/);
  assert.match(releaseManagerSource, /\["public", "uploads"\]/);
  assert.match(releaseManagerSource, /\["uploads"\]/);
  assert.match(releaseManagerSource, /removeDirContentsExcept/);
  assert.doesNotMatch(releaseManagerSource, /fs\.rename\(targetUploads/);
});

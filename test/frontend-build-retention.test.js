import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/clean-frontend-build.mjs", import.meta.url), "utf8");

test("frontend build cleanup keeps recent route chunks to avoid first-open white screens", () => {
  assert.match(source, /const frontendAssetsDir = path\.join\(frontendOutputDir, "assets"\)/);
  assert.match(source, /const ASSET_RETENTION_MS = Number\(process\.env\.FRONTEND_ASSET_RETENTION_MS \|\| 24 \* 60 \* 60 \* 1000\)/);
  assert.doesNotMatch(source, /await fs\.rm\(frontendOutputDir, removeOptions\)/);
  assert.match(source, /await fs\.rm\(path\.join\(frontendOutputDir, "\.vite"\), removeOptions\)/);
  assert.match(source, /async function pruneOldAssets\(assetsDir, retentionMs\)/);
});

test("admin shell links vendor CSS before mounting Vue", () => {
  const shell = readFileSync(new URL("../scripts/generate-admin-shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /adminEntry\.imports \|\| \[\]\)\s*\n\s*\.flatMap\(\(key\) => manifest\[key\]\?\.css \|\| \[\]\)/);
  assert.match(shell, /const styleTags = \[\.\.\.new Set\(styleFiles\)\]/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const releaseManagerSource = readFileSync(new URL("../tools/release-manager/server.mjs", import.meta.url), "utf8");

test("release replacement preserves runtime env logs and upload roots", () => {
  assert.match(releaseManagerSource, /function replaceDirFromRelease/);
  assert.match(releaseManagerSource, /\["\.env"\]/);
  assert.match(releaseManagerSource, /\["logs"\]/);
  assert.match(releaseManagerSource, /\["public", "uploads"\]/);
  assert.match(releaseManagerSource, /\["uploads"\]/);
  assert.match(releaseManagerSource, /removeDirContentsExcept/);
  assert.doesNotMatch(releaseManagerSource, /fs\.rename\(targetUploads/);
});

test("preview deployment seeds a missing runtime env without packaging secrets", () => {
  assert.match(releaseManagerSource, /async function ensurePreviewRuntimeEnv/);
  assert.match(releaseManagerSource, /path\.join\(config\.projectDir, "\.env"\)/);
  assert.match(releaseManagerSource, /path\.join\(config\.liveDir, "\.env"\)/);
  assert.match(releaseManagerSource, /await fs\.copyFile\(sourceEnv, previewEnv\)/);
  assert.match(releaseManagerSource, /await ensurePreviewRuntimeEnv\(config\)/);
});

test("Windows deploy startup passes Unicode paths without cmd shell rewriting", () => {
  assert.match(releaseManagerSource, /function runProcess/);
  assert.match(releaseManagerSource, /shell: false/);
  assert.match(releaseManagerSource, /"-DeployDir", deployDir/);
  assert.match(releaseManagerSource, /runProcess\("powershell\.exe", args/);
});

test("online release is prepared before stopping 8787 and switched by directory rename", () => {
  const prepareIndex = releaseManagerSource.indexOf("await prepareReleaseSwap(releaseDir, config.liveDir, config.projectDir)");
  const stopIndex = releaseManagerSource.indexOf("await stopErpServerOnPort(config, 8787)");
  assert.ok(prepareIndex >= 0 && prepareIndex < stopIndex);
  assert.match(releaseManagerSource, /const runtimeEnv = \[\["\.env"\]\]/);
  assert.doesNotMatch(releaseManagerSource, /const runtimeEnv = \["\.env"\]/);
  assert.match(releaseManagerSource, /async function accessWithRetry/);
  assert.match(releaseManagerSource, /async function copyRuntimeEnvWithRetry/);
  assert.match(releaseManagerSource, /targetRuntimePath,[\s\S]*path\.join\(projectDir, \.\.\.parts\)/);
  assert.match(releaseManagerSource, /setTimeout\(resolve, attempt \* 150\)/);
  assert.match(releaseManagerSource, /await accessWithRetry\(path\.join\(stagedDir, "\.env"\)\)/);
  assert.match(releaseManagerSource, /await fs\.rename\(prepared\.stagedDir, target\)/);
  assert.match(releaseManagerSource, /await fs\.rename\(prepared\.previousDir, target\)\.catch/);
  assert.match(releaseManagerSource, /停服后切换用时/);
});

test("version history excludes large runtime directories from deploy artifacts", () => {
  assert.match(releaseManagerSource, /DEPLOY_OUTPUT_DIR: releaseDir/);
  assert.match(releaseManagerSource, /await fs\.access\(path\.join\(releaseDir, "deploy-manifest\.json"\)\)/);
  assert.doesNotMatch(releaseManagerSource, /copyDir\(config\.deployOutputDir, releaseDir/);
});

test("release history automatically retains only current and preview releases", () => {
  assert.match(releaseManagerSource, /releaseRetention: Math\.max\(2,/);
  assert.match(releaseManagerSource, /async function pruneReleaseHistory/);
  assert.match(releaseManagerSource, /new Set\(\[current\.version, preview\.version\]\.filter\(Boolean\)\)/);
  assert.match(releaseManagerSource, /await pruneReleaseHistory\(config\)/);
  assert.match(releaseManagerSource, /publishedRecords\.filter\(\(record\) => !removed\.has\(record\.version\)\)/);
});

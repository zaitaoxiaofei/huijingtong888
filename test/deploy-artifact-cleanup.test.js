import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageDeploySource = fs.readFileSync("scripts/package-deploy.mjs", "utf8");

test("deployment promotion removes stale runtime data from generated artifacts", () => {
  assert.match(packageDeploySource, /path\.join\("public", "uploads"\)/);
  assert.match(packageDeploySource, /"uploads"/);
  assert.match(packageDeploySource, /"backups"/);
  assert.match(packageDeploySource, /"logs"/);
});

test("deployment copy still excludes source uploads unless explicitly enabled", () => {
  assert.match(packageDeploySource, /OZON_DEPLOY_INCLUDE_UPLOADS/);
  assert.match(packageDeploySource, /relativeSource !== "uploads"/);
});

test("deployment output directory creation retries transient Windows and OneDrive failures", () => {
  assert.match(packageDeploySource, /async function mkdirWithRetry/);
  assert.match(packageDeploySource, /\['EPERM', 'EACCES', 'ENOENT'\]/);
  assert.match(packageDeploySource, /await mkdirWithRetry\(finalOutputDir\)/);
});

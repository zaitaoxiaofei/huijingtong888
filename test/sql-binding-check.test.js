import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditProjectSqlBindings, auditSqlSource } from "../scripts/check-sql-bindings.mjs";

test("SQL binding audit accepts aligned INSERT values with nested commas", () => {
  const source = `
    INSERT INTO sample_table (id, payload, updated_at)
    VALUES (?, JSON_OBJECT('left', ?, 'right', ?), CURRENT_TIMESTAMP)
  `;
  assert.deepEqual(auditSqlSource(source), []);
});

test("SQL binding audit reports mismatched INSERT columns and values", () => {
  const source = `
    INSERT INTO sample_table (id, title, status)
    VALUES (?, ?)
  `;
  assert.deepEqual(auditSqlSource(source, "fixture.js"), [{
    file: "fixture.js",
    line: 2,
    table: "sample_table",
    columns: 3,
    values: 2
  }]);
});

test("project SQL INSERT column and value counts stay aligned", async () => {
  assert.deepEqual(await auditProjectSqlBindings(), []);
});

test("deployment packaging runs safety checks before frontend build", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deploySource = readFileSync(new URL("../scripts/package-deploy.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["check:sql-bindings"], "node scripts/check-sql-bindings.mjs");
  const preflightIndex = deploySource.indexOf('runNpmScript("check:deploy-preflight"');
  const encodingIndex = deploySource.indexOf('runNpmScript("check:encoding"');
  const sqlIndex = deploySource.indexOf('runNpmScript("check:sql-bindings"');
  const buildIndex = deploySource.indexOf('runNpmScript("build:frontend"');
  assert.ok(preflightIndex >= 0 && preflightIndex < encodingIndex);
  assert.ok(encodingIndex < sqlIndex);
  assert.ok(sqlIndex < buildIndex);
});

test("deployment promotion overwrites managed files without unlinking them first", () => {
  const deploySource = readFileSync(new URL("../scripts/package-deploy.mjs", import.meta.url), "utf8");
  assert.match(deploySource, /if \(!stat \|\| stat\.isFile\(\)\) continue/);
});

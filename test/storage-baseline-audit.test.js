import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/audit-storage-baseline.mjs", import.meta.url), "utf8");

test("storage baseline audit is metadata-only unless deep mode is explicit", () => {
  assert.match(source, /process\.argv\.includes\("--deep"\)/);
  assert.match(source, /mode: DEEP \? "deep" : "metadata-only"/);
  assert.match(source, /deepLargeFieldUsage: DEEP \? await deepLargeFieldUsage\(\) : null/);
});

test("storage baseline audit bounds every query runtime", () => {
  assert.match(source, /Math\.min\(Math\.max\([^)]*15000[^)]*\), 1000\), 60000\)/);
  assert.match(source, /SET STATEMENT max_execution_time=\$\{MAX_EXECUTION_MS\} FOR/);
});

test("storage baseline audit does not contain mutation statements", () => {
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE|OPTIMIZE)\b\s+/i);
});

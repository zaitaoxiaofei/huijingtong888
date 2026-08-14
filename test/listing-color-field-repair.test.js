import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const scriptSource = readFileSync(new URL("../scripts/repair-listing-color-fields.mjs", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("listing color field repair is dry-run first and write-gated", () => {
  assert.match(serviceSource, /export async function repairListingColorFieldPollution/);
  assert.match(serviceSource, /const apply = body\.apply === true \|\| body\.dryRun === false \|\| body\.dry_run === false/);
  assert.match(scriptSource, /dryRun: !hasFlag\("write"\)/);
  assert.match(packageJson, /"repair:listing-colors": "node scripts\/repair-listing-color-fields\.mjs"/);
  assert.match(packageJson, /"repair:listing-colors:write": "node scripts\/repair-listing-color-fields\.mjs --write"/);
});

test("listing color mapping rejects numeric and quantity-like color text", () => {
  assert.match(serviceSource, /function isInvalidColorText/);
  assert.match(serviceSource, /\^\\d\+\(\?:\[\.,\]\\d\+\)\?\$/);
  assert.match(serviceSource, /COLOR_QUANTITY_UNIT_PATTERN/);
  assert.match(serviceSource, /color: normalizeSafeColorText\(body\.color \|\| inheritedLogistics\.color \|\| inheritedVariant\.color \|\| ""\)/);
  assert.match(serviceSource, /color: normalizeSafeColorText\(body\.color\)/);
  assert.match(serviceSource, /if \(isInvalidColorText\(text\)\) return ""/);
  assert.match(serviceSource, /\.filter\(\(item\) => !isInvalidColorText\(item\)\)/);
});

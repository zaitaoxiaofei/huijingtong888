import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const strategySource = readFileSync(new URL("../frontend/admin/views/settings/writebackStrategies.js", import.meta.url), "utf8");

test("online product template creation returns both legacy top-level row and template wrapper", () => {
  assert.match(listingSource, /const result = await createListingCategoryTemplate\(standardizedPayload, session\)/);
  assert.match(listingSource, /ok:\s*true/);
  assert.match(listingSource, /template:\s*result/);
  assert.match(listingSource, /diagnostics:\s*standardizedPayload\.mapping_diagnostics \|\| null/);
});

test("online product AI writeback opens generated template and reports diagnostics risk", () => {
  assert.match(strategySource, /const templateId = result\?\.template\?\.id/);
  assert.match(strategySource, /path:\s*"\/listing-automation"/);
  assert.match(strategySource, /const summary = result\?\.diagnostics\?\.summary \|\| result\?\.template\?\.mapping_diagnostics\?\.summary \|\| \{\}/);
  assert.match(strategySource, /诊断 \$\{Number\(summary\.blockers \|\| 0\)\} 个阻断 \/ \$\{Number\(summary\.warnings \|\| 0\)\} 个提醒/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const selectorSource = readFileSync(new URL("../frontend/admin/components/listing/OzonCategorySelect.vue", import.meta.url), "utf8");

test("category browsing loads one complete level at a time", () => {
  assert.match(selectorSource, /new URLSearchParams\(\{ mode: "browse" \}\)/);
  assert.match(selectorSource, /await loadBrowseLevel\(node\.path, columnIndex \+ 1\)/);
  assert.match(selectorSource, /node\.children\?\.length \|\| node\.has_children/);
  assert.doesNotMatch(selectorSource, /BROWSE_CATEGORY_LIMIT/);
  assert.doesNotMatch(selectorSource, /@mouseenter="handleBrowseNode/);
});

test("category browse API does not truncate hierarchy branches", () => {
  const branch = serviceSource.match(/if \(String\(query\.mode[\s\S]*?return \{ parent_path: parentPath, nodes: \[\.\.\.nodes\.values\(\)\] \};/)?.[0] || "";
  assert.match(branch, /has_children/);
  assert.match(branch, /category: hasChildren \? null : category/);
  assert.doesNotMatch(branch, /LIMIT/);
});

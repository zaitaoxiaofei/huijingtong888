import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");

test("AI variant import keeps template material while excluding source-draft images", () => {
  const normalizeImportCandidate = source.match(/function normalizeImportCandidate\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(normalizeImportCandidate, /const draftCurrentImageList = source === "draft"/);
  assert.match(normalizeImportCandidate, /row\.effective_images/);
  assert.match(normalizeImportCandidate, /row\.list_image_url/);
  assert.match(normalizeImportCandidate, /const sourceImageList = firstNonEmptyImageList\(\[/);
  assert.match(normalizeImportCandidate, /const templateImageList = firstNonEmptyImageList\(\[/);
  assert.match(normalizeImportCandidate, /const templateOnlyImages = templateImageList\.filter\(\(url\) => !sourceImageList\.includes\(url\)\)/);
  assert.match(normalizeImportCandidate, /const fallbackImageList = templateOnlyImages\.length \? templateOnlyImages/);
  assert.match(normalizeImportCandidate, /const imageList = draftCurrentImageList\.length/);
  assert.doesNotMatch(normalizeImportCandidate, /uniqueList\(normalizeImageList\(\[/);
});

test("AI variant import does not append duplicate detail snapshots behind the selected material", () => {
  assert.match(source, /detailImages: uniqueList\(imageList\.length > 1 \? imageList\.slice\(1\) : explicitDetailImages\)/);
  assert.match(source, /function firstNonEmptyImageList\(values = \[\]\)/);
});

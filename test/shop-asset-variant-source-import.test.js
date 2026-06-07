import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ShopAssetVariantCenter.vue", import.meta.url), "utf8");

test("collector source image import is bounded and timed out", () => {
  assert.match(source, /const SOURCE_DETAIL_IMAGE_LIMIT = 24/);
  assert.match(source, /const SOURCE_IMAGE_META_CONCURRENCY = 4/);
  assert.match(source, /const SOURCE_IMAGE_META_TIMEOUT_MS = 4500/);
  assert.match(source, /async function imageMetasFromUrls\(urls = \[\]\)/);
  assert.match(source, /slice\(0, SOURCE_DETAIL_IMAGE_LIMIT\)/);
  assert.match(source, /Math\.min\(SOURCE_IMAGE_META_CONCURRENCY, limitedUrls\.length\)/);
  assert.match(source, /window\.setTimeout/);
});

test("collector source import does not load every detail image at once", () => {
  assert.doesNotMatch(source, /detailImages\.map\(\(url, index\) => imageMetaFromUrl\(url, `详情图 \$\{index \+ 1\}`\)\)/);
  assert.match(source, /material\.detailImages = await imageMetasFromUrls\(detailImages\)/);
});

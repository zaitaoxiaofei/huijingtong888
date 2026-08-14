import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractDraftMediaReferences, resolveDraftLocalMediaPath } from "../scripts/backup-listing-draft-media-to-oss.mjs";

test("draft backup extracts nested media without duplicates", () => {
  const rows = extractDraftMediaReferences({
    source_images_json: JSON.stringify(["/uploads/a.jpg", { url: "/uploads/a.jpg" }]),
    template_payload_json: JSON.stringify({
      images: ["https://example.com/b.png"],
      productUrl: "https://www.ozon.ru/product/example-123/",
      apiUrl: "https://seller.ozon.ru/api/v1/search"
    })
  });
  assert.deepEqual(rows, ["/uploads/a.jpg", "https://example.com/b.png"]);
});

test("draft backup rejects traversal outside uploads roots", async () => {
  assert.equal(await resolveDraftLocalMediaPath("/uploads/../.env"), "");
});

test("draft backup resolves media from the packaged live runtime", async (t) => {
  const root = path.resolve("tmp", `draft-media-${process.pid}-${Date.now()}`);
  const mediaPath = path.join(root, "dist", "live", "public", "uploads", "listing-media", "sample.mp4");
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, "video");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(await resolveDraftLocalMediaPath("/uploads/listing-media/sample.mp4", root), mediaPath);
});

test("draft backup remains dry-run by default and requires explicit write", () => {
  const source = fs.readFileSync(path.resolve("scripts/backup-listing-draft-media-to-oss.mjs"), "utf8");
  assert.match(source, /const WRITE = process\.argv\.includes\("--write"\)/);
  assert.match(source, /if \(!WRITE\)/);
  assert.doesNotMatch(source, /UPDATE listing_drafts/i);
  assert.doesNotMatch(source, /DELETE FROM listing_drafts/i);
});

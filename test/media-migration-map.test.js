import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalMediaSource,
  mediaSourceFingerprint,
  preferredMediaUrl,
  resolveMappedMediaInValue
} from "../src/services/media-migration-map.js";

test("canonical media source removes temporary query credentials", () => {
  assert.equal(
    canonicalMediaSource("https://example.com/a/image.jpg?token=secret#preview"),
    "https://example.com/a/image.jpg"
  );
  assert.equal(canonicalMediaSource("C:\\uploads\\a.jpg"), "C:/uploads/a.jpg");
});

test("media source fingerprint is stable after query removal", () => {
  assert.equal(
    mediaSourceFingerprint("https://example.com/a.jpg?x=1"),
    mediaSourceFingerprint("https://example.com/a.jpg?x=2")
  );
});

test("only verified OSS mappings override the original address", () => {
  const source = "/uploads/original.jpg";
  const oss = "https://bucket.oss-cn-heyuan.aliyuncs.com/media/a.jpg";
  assert.equal(preferredMediaUrl(source, { status: "uploaded", oss_url: oss }), source);
  assert.equal(preferredMediaUrl(source, { status: "failed", oss_url: oss }), source);
  assert.equal(preferredMediaUrl(source, { status: "verified", oss_url: oss }), oss);
});

test("mysql initialization contains the resumable media mapping table", () => {
  const source = fs.readFileSync(path.resolve("scripts/init-mysql-schema.mjs"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS media_migration_map/);
  assert.match(source, /UNIQUE KEY uk_media_migration_source \(source_fingerprint\)/);
  assert.match(source, /status VARCHAR\(32\) NOT NULL DEFAULT 'pending'/);
  assert.match(source, /verified_at DATETIME NULL/);
});

test("deep resolver leaves values unchanged when no media address exists", async () => {
  const value = {
    title: "测试草稿",
    attributes: [{ name: "颜色", value: "黑色" }],
    quantity: 1
  };
  assert.deepEqual(await resolveMappedMediaInValue(value), value);
});

test("listing drafts resolve verified OSS mappings after effective image selection", () => {
  const source = fs.readFileSync(path.resolve("src/services/listing-automation.js"), "utf8");
  assert.match(source, /resolveMappedMediaInValue\(normalizeDraftRow\(item\)\)/);
  assert.match(source, /effective_images: effectiveMedia\.images/);
  assert.match(source, /if \(!draft\?\.template_payload\) return resolveMappedMediaInValue\(draft\)/);
  assert.match(source, /return resolveMappedMediaInValue\(\{[\s\S]*?template_payload: templatePayload[\s\S]*?\}\)/);
});

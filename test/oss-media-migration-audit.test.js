import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditMysqlReferences, runAudit, scanMediaDirectories } from "../scripts/audit-oss-media-migration.mjs";

test("scans media types, sizes, extensions, and duplicate hashes without changing files", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-media-audit-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "uploads", "nested"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "public", "uploads"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "uploads", "a.jpg"), "same");
  await fs.writeFile(path.join(rootDir, "uploads", "nested", "clip.mp4"), "video");
  await fs.writeFile(path.join(rootDir, "public", "uploads", "copy.jpg"), "same");
  await fs.writeFile(path.join(rootDir, "public", "uploads", "work.tmp"), "tmp");

  const result = await scanMediaDirectories({ rootDir });

  assert.equal(result.totals.files, 4);
  assert.equal(result.extensions[".jpg"].files, 2);
  assert.equal(result.directories[0].kinds.video.files, 1);
  assert.equal(result.directories[1].kinds.temporary.files, 1);
  assert.equal(result.duplicateGroups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(rootDir, "uploads", "a.jpg"), "utf8"), "same");
});

test("classifies database media references and reports missing local files with redacted samples", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-media-db-audit-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "uploads"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "uploads", "exists.jpg"), "image");
  const connection = {
    async query(sql) {
      if (sql.includes("information_schema.COLUMNS")) return [[{ TABLE_NAME: "products", COLUMN_NAME: "images_json", DATA_TYPE: "json" }]];
      return [[{
        audit_value: JSON.stringify([
          "data:image/png;base64,AAAA",
          "/uploads/exists.jpg",
          "/uploads/missing.jpg",
          "https://bucket.oss-cn-hangzhou.aliyuncs.com/a.jpg?AccessKeyId=secret",
          "https://example.com/image.jpg?token=secret"
        ])
      }]];
    }
  };

  const result = await auditMysqlReferences({ connection, database: "erp", rootDir });

  assert.deepEqual(result.categories, { dataImageBase64: 1, localUploads: 2, oss: 1, external: 1 });
  assert.equal(result.missingLocalFiles, 1);
  assert.ok(result.samples.every((item) => !item.reference.includes("secret")));
  assert.match(result.samples[0].reference, /redacted/);
});

test("writes JSON and Markdown reports in no-db mode", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-media-report-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const result = await runAudit({ rootDir, noDb: true, now: new Date("2026-07-31T01:02:03.000Z") });
  const json = JSON.parse(await fs.readFile(result.jsonPath, "utf8"));
  const markdown = await fs.readFile(result.markdownPath, "utf8");
  assert.equal(json.mode, "read-only");
  assert.equal(json.mysql.skipped, true);
  assert.match(markdown, /未上传、移动、删除文件，未更新数据库/);
});

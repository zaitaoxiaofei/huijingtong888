import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const readers = [
  ["src/services/ai-variant-lab.js", "resolveLocalPublicImageFile"],
  ["src/server/services/ai/aiWorkflowService.js", "resolveLocalPublicSourceImage"]
].map(([file, name]) => {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ fs, fsSync: fs, path, URL });
  vm.runInContext(source.slice(start, end + 2), context, { filename: file });
  return { name, read: value => {
    const result = context[name](value, new URL(value).pathname);
    return typeof result === "string" ? result : result?.filePath || "";
  } };
});

test("public fission media stays inside its real root, including when that root is shared", async t => {
  const originalCwd = process.cwd();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ozon-fission-media-test-"));
  const files = [], links = [], directories = [fixture];
  const owned = target => {
    const relative = path.relative(fixture, path.resolve(target));
    assert.ok(!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), "Cleanup target escaped fixture");
    return target;
  };
  function directory(target) {
    owned(target);
    if (fs.existsSync(target)) return;
    directory(path.dirname(target));
    fs.mkdirSync(target); directories.push(target);
  }
  function image(target) {
    directory(path.dirname(target));
    fs.writeFileSync(owned(target), Buffer.from("fixture public image")); files.push(target);
    return fs.realpathSync(target);
  }
  function link(target, destination) {
    directory(path.dirname(destination));
    fs.symlinkSync(owned(target), owned(destination), process.platform === "win32" ? "junction" : "dir");
    links.push(destination);
  }
  try {
    for (const shared of [false, true]) {
      const app = path.join(fixture, shared ? "shared-app" : "direct-app");
      const publicMedia = path.join(app, "public", "uploads", "listing-media");
      const mediaRoot = shared ? path.join(fixture, "shared", "listing-media") : publicMedia;
      const expected = image(path.join(mediaRoot, "historical", "published.png"));
      // All targets are disposable fixtures, never actual private attachments.
      image(path.join(path.dirname(mediaRoot), "team-attachments", "private-fixture.png"));
      const privateDirectory = path.join(fixture, shared ? "private-shared" : "private-direct");
      image(path.join(privateDirectory, "private-fixture.png"));
      link(privateDirectory, path.join(mediaRoot, "escape"));
      if (shared) link(mediaRoot, publicMedia);
      process.chdir(app);

      for (const reader of readers) {
        await t.test(`${reader.name}: ${shared ? "shared symlink" : "direct"} root permits historical published media`, () => {
          for (const host of ["https://erp.hjt888.xyz", "http://localhost:8788", "http://127.0.0.1:8788"]) {
            const result = reader.read(`${host}/uploads/listing-media/historical/published.png`);
            assert.equal(result, expected);
            assert.equal(fs.readFileSync(result, "utf8"), "fixture public image");
          }
        });
        await t.test(`${reader.name}: ${shared ? "shared" : "direct"} root rejects encoded separators and child symlink escape`, () => {
          for (const suffix of [
            "..%2Fteam-attachments/private-fixture.png",
            "..%5Cteam-attachments%5Cprivate-fixture.png",
            "historical%2F..%2F..%2Fteam-attachments/private-fixture.png",
            "historical%5C..%5C..%5Cteam-attachments%5Cprivate-fixture.png",
            "escape/private-fixture.png",
            "historical/",
            "missing.png"
          ]) assert.equal(reader.read(`https://erp.hjt888.xyz/uploads/listing-media/${suffix}`), "", suffix);
          assert.equal(reader.read("https://foreign.example/uploads/listing-media/historical/published.png"), "");
          assert.equal(reader.read("https://erp.hjt888.xyz/uploads/team-attachments/private-fixture.png"), "");
        });
      }
    }
  } finally {
    process.chdir(originalCwd);
    // Only explicitly created fixture paths are removed, with no recursive delete.
    for (const target of links.reverse()) fs.unlinkSync(owned(target));
    for (const target of files.reverse()) fs.unlinkSync(owned(target));
    for (const target of directories.sort((a, b) => b.length - a.length)) fs.rmdirSync(owned(target));
  }
});

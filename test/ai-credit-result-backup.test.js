import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { backupAiCreditResults as backup, inspectAiCreditResultBackup as inspect, restoreAiCreditResults as restore } from "../scripts/lib/ai-credit-result-backup.mjs";

const first = "1/11111111-1111-4111-8111-111111111111.json";
const second = "2/22222222-2222-4222-8222-222222222222.json";
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "erp-ai-result-backup-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "private"), output = path.join(base, "archive.jsonl.gz");
  for (const file of [first, second]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify({ value: file, label: "生成结果" }));
  }
  return { base, root, output };
}

test("private AI backup verifies bytes, defaults to dry-run, restores and replays without replacement", async t => {
  const { base, root, output } = await fixture(t), destination = path.join(base, "restored");
  await fs.writeFile(path.join(root, "1/partial.tmp"), "incomplete");
  const proof = await backup({ root, output });
  assert.equal(proof.files, 2);
  assert.equal((await inspect({ input: output })).content_sha256, proof.content_sha256);
  assert.equal((await restore({ root: destination, input: output })).written, 0);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  assert.equal((await restore({ root: destination, input: output, apply: true })).written, 2);
  for (const file of [first, second]) assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(path.join(root, file)));
  assert.equal((await restore({ root: destination, input: output, apply: true })).written, 0);
});

test("backup refuses overwrite and leaves an existing archive byte-for-byte unchanged", async t => {
  const { root, output } = await fixture(t);
  await backup({ root, output }); const before = await fs.readFile(output);
  await assert.rejects(backup({ root, output }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(output), before);
  assert.equal((await fs.readdir(path.dirname(output))).filter(name => name.endsWith(".partial")).length, 0);
});

test("corrupt or truncated archive is rejected before restore creates any files", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const original = await fs.readFile(output), corrupt = path.join(base, "corrupt.gz"), destination = path.join(base, "restore");
  await fs.writeFile(corrupt, original.subarray(0, original.length - 6));
  await assert.rejects(restore({ input: corrupt, root: destination, apply: true }));
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  const records = gunzipSync(original).toString("utf8").trimEnd().split("\n").map(JSON.parse);
  records[1].sha256 = "0".repeat(64);
  await fs.writeFile(corrupt, gzipSync(records.map(JSON.stringify).join("\n") + "\n"));
  await assert.rejects(restore({ input: corrupt, root: destination, apply: true }), /hash mismatch/);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("restore conflict rolls back only newly written files and preserves existing content", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const destination = path.join(base, "restore"); await fs.mkdir(path.dirname(path.join(destination, second)), { recursive: true });
  await fs.writeFile(path.join(destination, second), "existing customer data");
  await assert.rejects(restore({ input: output, root: destination, apply: true }), /refusing overwrite/);
  await assert.rejects(fs.stat(path.join(destination, first)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(destination, second), "utf8"), "existing customer data");
});

test("archive framing, traversal, duplicate paths and oversized lines fail closed", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const records = gunzipSync(await fs.readFile(output)).toString("utf8").trimEnd().split("\n").map(JSON.parse);
  const cases = [records.slice(0, -1), [records[0], { ...records[1], file: "../escape.json" }, records.at(-1)],
    [records[0], records[1], records[1], records.at(-1)], [...records, records.at(-1)]];
  for (let index = 0; index < cases.length; index++) {
    const input = path.join(base, `invalid-${index}.gz`);
    await fs.writeFile(input, gzipSync(cases[index].map(JSON.stringify).join("\n") + "\n"));
    await assert.rejects(inspect({ input }));
  }
  const input = path.join(base, "oversized.gz");
  await fs.writeFile(input, gzipSync(" ".repeat(3 * 1024 * 1024 + 1)));
  await assert.rejects(inspect({ input }), /limit/);
});

test("missing sources, relative paths and nested backup destinations reject promptly", async t => {
  const { base, root } = await fixture(t);
  await assert.rejects(inspect({ input: path.join(base, "missing.gz") }), { code: "ENOENT" });
  await assert.rejects(inspect({ input: "relative.gz" }), /absolute/);
  await assert.rejects(inspect({}), /absolute/);
  await assert.rejects(backup({ root, output: path.join(root, "nested.gz") }), /outside/);
});

test("source and destination symlinks never expose or replace external files", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const external = path.join(base, "external"); await fs.mkdir(external);
  const destination = path.join(base, "restore"); await fs.mkdir(destination);
  await fs.symlink(external, path.join(destination, "1"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(restore({ input: output, root: destination, apply: true }), /symbolic-link/);
  assert.deepEqual(await fs.readdir(external), []);
  await fs.symlink(external, path.join(root, "3"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(backup({ root, output: path.join(base, "linked.gz") }), /directory|symbolic-link/);
});

test("ancestor directory links and aliased output parents reject before writing through the link", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const external = path.join(base, "external"), alias = path.join(base, "alias");
  await fs.mkdir(external); await fs.symlink(external, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(restore({ input: output, root: path.join(alias, "new-private"), apply: true }), /symbolic-link/);
  assert.deepEqual(await fs.readdir(external), [], "restore must not even create a directory through an ancestor link");
  await assert.rejects(backup({ root, output: path.join(alias, "nested", "backup.gz") }), /symbolic-link/);
  assert.deepEqual(await fs.readdir(external), []);
  await fs.mkdir(path.join(external, "source"));
  await assert.rejects(backup({ root: path.join(alias, "source"), output: path.join(base, "other.gz") }), /symbolic-link/);
});

test("restore installs complete immutable bytes atomically instead of exposing a partially written final path", async t => {
  const { base, root, output } = await fixture(t); await backup({ root, output });
  const destination = path.join(base, "restore"), original = fs.link;
  let installs = 0;
  fs.link = async (temporary, target) => {
    if (target.startsWith(destination + path.sep)) {
      installs += 1; await assert.rejects(fs.stat(target), { code: "ENOENT" });
      assert.deepEqual(await fs.readFile(temporary), await fs.readFile(path.join(root, path.relative(destination, target))));
    }
    return original(temporary, target);
  };
  try { assert.equal((await restore({ input: output, root: destination, apply: true })).written, 2); }
  finally { fs.link = original; }
  assert.equal(installs, 2);
  for (const name of ["1", "2"]) assert.ok((await fs.readdir(path.join(destination, name))).every(file => !file.endsWith(".tmp")));
});

test("the documented private-result CLI arguments create, inspect and restore without logging result bytes", async t => {
  const { base, root, output } = await fixture(t), execute = promisify(execFile);
  const cli = fileURLToPath(new URL("../scripts/backup-private-ai-results.mjs", import.meta.url));
  const run = async args => JSON.parse((await execute(process.execPath, [cli, ...args], { windowsHide: true })).stdout);
  assert.equal((await run([`--root=${root}`, `--output=${output}`])).files, 2);
  assert.equal((await run(["--inspect", `--input=${output}`])).files, 2);
  const destination = path.join(base, "cli-restored");
  assert.equal((await run(["--restore", `--input=${output}`, `--root=${destination}`])).written, 0);
  assert.equal((await run(["--restore", "--apply", `--input=${output}`, `--root=${destination}`])).written, 2);
  await assert.rejects(run(["--apply", `--root=${root}`, `--output=${path.join(base, "bad.gz")}`]));
  await assert.rejects(run(["--inspect", `--input=${output}`, `--input=${output}`]));
});

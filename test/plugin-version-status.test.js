import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { globalUpdateStatus } from "../src/server/notifications.js";
const execFileAsync = promisify(execFile);

test("collector plugin update status defaults to the plugin manifest version", () => {
  const manifest = JSON.parse(fs.readFileSync("ozon-erp-collector-plugin/manifest.json", "utf8"));
  const status = globalUpdateStatus();
  assert.equal(status.plugin.version, manifest.version);
  assert.equal(status.plugin.package_name, `ozon-baodan-erp-plugin-${manifest.version}.zip`);
});

test("analytics plugin update status defaults to the analytics manifest version", () => {
  const manifest = JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8"));
  const status = globalUpdateStatus();
  assert.equal(status.analytics_plugin.version, manifest.version);
  assert.equal(status.analytics_plugin.package_name, `ozon-seller-analytics-plugin-${manifest.version}.zip`);
});

test("analytics plugin package contains the advertised manifest version", async () => {
  const outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-analytics-plugin-"));
  try {
    await execFileAsync(process.execPath, ["scripts/package-analytics-plugin.mjs"], {
      env: { ...process.env, ANALYTICS_PLUGIN_OUTPUT_DIR: outputDir }
    });
    const version = JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8")).version;
    const filename = path.join(outputDir, `ozon-seller-analytics-plugin-${version}.zip`);
    const { stdout } = await execFileAsync("unzip", ["-p", filename, "manifest.json"]);
    assert.equal(JSON.parse(stdout).version, version);
    assert.deepEqual(await fsPromises.readFile(path.join(outputDir, "ozon-seller-analytics-plugin.zip")), await fsPromises.readFile(filename));
  } finally {
    await fsPromises.rm(outputDir, { recursive: true, force: true });
  }
});

test("plugin download aliases use the server release artifact instead of a browser-reported version", () => {
  const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /const filename = parts\[1\]/);
  assert.doesNotMatch(serverSource, /filename = status\.plugin\.package_name/);
  assert.match(serverSource, /application\/zip/);
  assert.match(serverSource, /Location.*latestPackage/);
});

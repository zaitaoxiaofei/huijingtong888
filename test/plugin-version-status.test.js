import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import test from "node:test";

import { globalUpdateStatus } from "../src/server/notifications.js";
const execFileAsync = promisify(execFile);

function readZipEntry(archive, filename) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, "ZIP end directory exists");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "ZIP central directory entry");
    const nameLength = archive.readUInt16LE(offset + 28);
    const entryName = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (entryName === filename) {
      const method = archive.readUInt16LE(offset + 10);
      const compressedSize = archive.readUInt32LE(offset + 20);
      const localOffset = archive.readUInt32LE(offset + 42);
      assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, "ZIP local file entry");
      const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      const compressed = archive.subarray(start, start + compressedSize);
      if (method === 0) return compressed;
      assert.equal(method, 8, "ZIP entry uses stored or deflate compression");
      return inflateRawSync(compressed);
    }
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  assert.fail(`ZIP entry is missing: ${filename}`);
}

async function pluginStatusesWithMetadata(metadata, installedVersions) {
  const fixtureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-plugin-update-policy-"));
  try {
    for (const directory of ["ozon-erp-collector-plugin", "pivot-table-master", "pdd-procurement-logistics-plugin"]) {
      await fsPromises.mkdir(path.join(fixtureDir, directory));
      await fsPromises.writeFile(path.join(fixtureDir, directory, "manifest.json"), JSON.stringify({ version: "1.0.30" }), "utf8");
    }
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e",
      `const { globalUpdateStatus, updateGlobalUpdateStatus } = await import(process.argv[1]);
       const { metadata, installedVersions } = JSON.parse(process.argv[2]);
       updateGlobalUpdateStatus({ plugin: metadata, analytics_plugin: metadata, pdd_procurement_plugin: metadata });
       console.log(JSON.stringify(installedVersions.map((version) => globalUpdateStatus({
         plugin_version: version, analytics_plugin_version: version, pdd_procurement_plugin_version: version
       }))));`,
      new URL("../src/server/notifications.js", import.meta.url).href,
      JSON.stringify({ metadata, installedVersions })
    ], {
      cwd: fixtureDir,
      env: { ...process.env, COLLECTOR_PLUGIN_VERSION: "1.0.30", ANALYTICS_PLUGIN_VERSION: "1.0.30", PDD_PROCUREMENT_PLUGIN_VERSION: "1.0.30" }
    });
    return JSON.parse(stdout);
  } finally {
    await fsPromises.rm(fixtureDir, { recursive: true, force: true });
  }
}

function assertPluginUpdateFlags(status, { available, required }) {
  for (const key of ["plugin", "analytics_plugin", "pdd_procurement_plugin"]) {
    assert.equal(status[key].update_available, available, `${key} update_available`);
    assert.equal(status[key].update_required, required, `${key} update_required`);
    assert.equal(status[key].mandatory, required, `${key} mandatory`);
  }
}

test("plugin enhancements remain optional even with legacy mandatory metadata", async () => {
  const [status] = await pluginStatusesWithMetadata({ mandatory: true }, ["1.0.9"]);
  assertPluginUpdateFlags(status, { available: true, required: false });
});

test("plugin updates compare numeric versions and never ask future or unknown clients to downgrade", async () => {
  const statuses = await pluginStatusesWithMetadata({}, ["1.0.9", "1.0.30", "1.0.30.0", "1.0.31", "2.0.0", "", "unknown"]);
  assertPluginUpdateFlags(statuses[0], { available: true, required: false });
  for (const status of statuses.slice(1)) assertPluginUpdateFlags(status, { available: false, required: false });
});

test("only clients below an explicit system bug minimum require a plugin update", async () => {
  const statuses = await pluginStatusesWithMetadata({
    mandatory: true,
    minimum_supported_version: "1.0.20",
    update_reason_type: "system_bug",
    update_reason: "Versions below the minimum contain a system bug."
  }, ["1.0.19", "1.0.20", "1.0.29", "1.0.30", "1.0.31", ""]);
  assertPluginUpdateFlags(statuses[0], { available: true, required: true });
  for (const status of statuses.slice(1, 3)) assertPluginUpdateFlags(status, { available: true, required: false });
  for (const status of statuses.slice(3)) assertPluginUpdateFlags(status, { available: false, required: false });
});

test("incomplete or feature-only plugin requirements remain optional", async () => {
  const criticalPolicy = {
    mandatory: true,
    minimum_supported_version: "1.0.20",
    update_reason_type: "system_bug",
    update_reason: "System bug requires a minimum compatible version."
  };
  for (const overrides of [
    { mandatory: false },
    { minimum_supported_version: "" },
    { minimum_supported_version: "invalid" },
    { minimum_supported_version: "2.0.0" },
    { update_reason_type: "feature" },
    { update_reason_type: "" },
    { update_reason: " " }
  ]) {
    const [status] = await pluginStatusesWithMetadata({ ...criticalPolicy, ...overrides }, ["1.0.10"]);
    assertPluginUpdateFlags(status, { available: true, required: false });
  }
});

test("analytics plugin frontend forwards server compatibility flags and clears updates for future versions", async () => {
  const source = fs.readFileSync(new URL("../frontend/admin/App.vue", import.meta.url), "utf8");
  const syncSource = source.slice(source.indexOf("async function syncAnalyticsPluginUpdate"), source.indexOf("\nuseGlobalImagePreviewDismiss();"));
  for (const [installedVersion, updateAvailable, updateRequired] of [
    ["1.0.9", true, false], ["1.0.9", true, true], ["1.0.31", false, false], ["", false, false]
  ]) {
    const events = [];
    const calls = [];
    const sync = new Function("apiClient", "window", "CustomEvent", `${syncSource}; return syncAnalyticsPluginUpdate;`)(
      { get: async (url) => {
        calls.push(url);
        return url.includes("plugin-status") ? { plugin_version: installedVersion } : {
          analytics_plugin: { version: "1.0.30", update_available: updateAvailable, update_required: updateRequired, mandatory: updateRequired }
        };
      } },
      { dispatchEvent: (event) => events.push(event) },
      class { constructor(type, { detail }) { this.type = type; this.detail = detail; } }
    );
    await sync({ analytics_plugin: { version: "1.0.30" } });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, updateAvailable ? "app:plugin-update" : "app:plugin-update-clear");
    if (updateAvailable) assert.equal(events[0].detail.mandatory, updateRequired);
    assert.equal(calls.length, installedVersion ? 2 : 1);
    if (installedVersion) assert.match(calls[1], new RegExp(`analytics_plugin_version=${installedVersion.replaceAll(".", "\\.")}`));
  }
});

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
  const outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ozon-analytics-plugin space-$'-"));
  try {
    await execFileAsync(process.execPath, ["scripts/package-analytics-plugin.mjs"], {
      env: { ...process.env, ANALYTICS_PLUGIN_OUTPUT_DIR: outputDir }
    });
    const version = JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8")).version;
    const filename = path.join(outputDir, `ozon-seller-analytics-plugin-${version}.zip`);
    const archive = await fsPromises.readFile(filename);
    assert.equal(JSON.parse(readZipEntry(archive, "manifest.json").toString("utf8")).version, version);
    assert.deepEqual(readZipEntry(archive, "content/erp-relay-page.js"), await fsPromises.readFile("pivot-table-master/content/erp-relay-page.js"));
    assert.deepEqual(await fsPromises.readFile(path.join(outputDir, "ozon-seller-analytics-plugin.zip")), archive);
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

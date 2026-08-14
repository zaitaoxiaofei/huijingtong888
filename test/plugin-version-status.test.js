import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { globalUpdateStatus } from "../src/server/notifications.js";

test("collector plugin update status defaults to the plugin manifest version", () => {
  const manifest = JSON.parse(fs.readFileSync("ozon-erp-collector-plugin/manifest.json", "utf8"));
  const status = globalUpdateStatus();
  assert.equal(status.plugin.version, manifest.version);
  assert.equal(status.plugin.package_name, `ozon-baodan-erp-plugin-${manifest.version}.rar`);
});

test("analytics plugin update status defaults to the analytics manifest version", () => {
  const manifest = JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8"));
  const status = globalUpdateStatus();
  assert.equal(status.analytics_plugin.version, manifest.version);
  assert.equal(status.analytics_plugin.package_name, `ozon-seller-analytics-plugin-${manifest.version}.rar`);
});

test("plugin download aliases use the server release artifact instead of a browser-reported version", () => {
  const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /const filename = parts\[1\]/);
  assert.doesNotMatch(serverSource, /filename = status\.plugin\.package_name/);
});

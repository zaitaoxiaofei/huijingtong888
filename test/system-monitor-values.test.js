import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, compileScript, compileStyle, compileTemplate } from "@vue/compiler-sfc";
import { monitorNumber, monitorBytesText, monitorGrowthText, monitorDiskShareText } from "../frontend/admin/utils/system-monitor-values.js";

test("missing monitoring values remain null and explicitly display as uncollected", () => {
  for (const value of [null, undefined, "", "  ", false, true, NaN, Infinity, {}, []]) {
    assert.equal(monitorNumber(value), null);
    assert.equal(monitorBytesText(value), "未采集");
    assert.equal(monitorGrowthText(value), "未采集");
    assert.equal(monitorDiskShareText(value, 1024), "未采集");
  }
});

test("measured zero and existing numeric values retain their original formatting", () => {
  assert.equal(monitorNumber(0), 0);
  assert.equal(monitorNumber("1024"), 1024);
  assert.equal(monitorBytesText(0), "0.0 B");
  assert.equal(monitorBytesText(1024), "1.0 KB");
  assert.equal(monitorBytesText(2 * 1024 ** 3), "2.00 GB");
  assert.equal(monitorGrowthText(0), "无明显增长");
  assert.equal(monitorGrowthText(1024), "+1.0 KB");
  assert.equal(monitorGrowthText(-1024), "-1.0 KB");
  assert.equal(monitorDiskShareText(0, 1024), "0.0%");
  assert.equal(monitorDiskShareText(256, 1024), "25.0%");
  for (const total of [0, null, undefined, NaN]) assert.equal(monitorDiskShareText(256, total), "未采集");
});

test("the existing monitoring component and its unchanged styles compile", () => {
  const filename = "frontend/admin/views/settings/SystemMonitoringView.vue";
  const source = readFileSync(filename, "utf8"), { descriptor, errors } = parse(source, { filename });
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "system-monitor-values" });
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: "system-monitor-values", compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename, id: "data-v-system-monitor-values", scoped: style.scoped }).errors, []);
});

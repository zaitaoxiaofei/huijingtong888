import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shanghaiDateTimeText } from "../frontend/admin/utils/shanghai-date.js";

const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");

test("shared frontend formatter renders ISO timestamps as Beijing time", () => {
  assert.equal(shanghaiDateTimeText("2026-06-11T13:16:00Z", { assumeUtcWhenNaive: true }), "2026/06/11 21:16:00");
  assert.equal(shanghaiDateTimeText("2026-06-11T13:16:00", { assumeUtcWhenNaive: true }), "2026/06/11 21:16:00");
});

test("collector box uses shared Beijing time formatting instead of slicing ISO strings", () => {
  assert.match(collectorBoxSource, /import \{ shanghaiDateTimeText \} from "\.\.\/\.\.\/utils\/shanghai-date\.js";/);
  assert.match(collectorBoxSource, /function formatDateTime\(value\) \{\s*return shanghaiDateTimeText\(value, \{ assumeUtcWhenNaive: true \}\);\s*\}/);
  assert.doesNotMatch(collectorBoxSource, /slice\(0,\s*16\)/);
});

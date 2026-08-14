import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(
  path.resolve("frontend/admin/components/listing/OzonRichContentEditor.vue"),
  "utf8"
);

test("rich-content editor initializes content when mounted already visible", () => {
  assert.match(
    source,
    /watch\(\s*\(\) => props\.visible,[\s\S]*?if \(visible\) loadFromJson\(props\.modelValue\);[\s\S]*?\{ immediate: true \}\s*\);/
  );
});

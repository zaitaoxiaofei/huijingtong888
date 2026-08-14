import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("collector list survives internal workbench query updates", () => {
  const source = read("frontend/admin/views/listing/CollectorBoxView.vue");
  assert.match(
    source,
    /apiClient\.get\(`\/api\/listing\/collector-box[\s\S]*?routeScoped:\s*false/
  );
});

test("publish task list survives internal tab query updates", () => {
  const source = read("frontend/admin/views/listing/ListingPublishRecordsView.vue");
  assert.match(
    source,
    /apiClient\.get\(`\/api\/listing\/publish-tasks[\s\S]*?routeScoped:\s*false/
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("create listing draft writes required ai_payload_json", () => {
  assert.match(source, /ai_payload_json,\s*\n\s*created_by_person_id/);
  assert.match(source, /JSON\.stringify\(aiPayload\)/);
  assert.match(source, /ai_payload:\s*objectValue\(body\.ai_payload \|\| body\.aiPayload\)/);
});

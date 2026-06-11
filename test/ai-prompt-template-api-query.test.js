import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiSource = readFileSync(new URL("../frontend/admin/api/settings/aiPromptTemplates.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/ai-prompt-templates.js", import.meta.url), "utf8");

test("AI prompt template search sends query params and searches payload text", () => {
  assert.match(apiSource, /new URLSearchParams/);
  assert.ok(apiSource.includes("`/api/ai-prompt-templates${suffix}`"));
  assert.match(serviceSource, /description LIKE/);
  assert.match(serviceSource, /prompt_payload_json LIKE/);
});

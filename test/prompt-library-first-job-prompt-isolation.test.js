import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/settings/PromptLibraryView.vue", import.meta.url), "utf8");

test("prompt library keeps drawer prompt edits isolated from batch generation task state", () => {
  assert.match(source, /const promptEditorState = reactive\(\{/);
  assert.match(source, /const previewContext = reactive\(\{/);
  assert.match(source, /promptEditorState\.positivePrompt = item\.finalPositivePrompt \|\| finalPrompt\.value/);
  assert.match(source, /promptEditorState\.negativePrompt = item\.finalNegativePrompt \|\| finalNegativePrompt\.value/);
  assert.match(source, /previewContext\.targetModel = item\.targetModel \|\| task\.targets\[0\] \|\| ""/);
  assert.match(source, /previewContext\.job = \{ \.\.\.item \}/);
  assert.match(source, /previewContext\.targetModel = firstJob\?\.targetModel \|\| task\.targets\[0\] \|\| ""/);
  assert.doesNotMatch(source, /task\.advancedPositivePrompt = item\.finalPositivePrompt \|\| finalPrompt\.value/);
  assert.doesNotMatch(source, /task\.advancedNegativePrompt = item\.finalNegativePrompt \|\| finalNegativePrompt\.value/);
  assert.doesNotMatch(source, /const workbenchPreviewJob = computed\(\(\) => buildGenerationJobs\(\)\[0\] \|\| \{\}\)/);
  assert.match(source, /v-model="promptEditorState\.positivePrompt"/);
  assert.match(source, /v-model="promptEditorState\.negativePrompt"/);
});

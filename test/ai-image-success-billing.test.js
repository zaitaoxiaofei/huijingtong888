import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import vm from "node:vm";
import crypto from "node:crypto";
import { aiImageCharge } from "../src/shared/ai-image-pricing.js";
import { checkAiCreditProviderBoundary } from "../src/services/ai-credit-provider-context.js";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";
import { createAiCreditExecutor } from "../src/services/ai-credit-execution.js";
import { tryGenerateCreditedImage } from "../src/services/ai-credit-image-adapter.js";

test("text is free for every valid enterprise even without a wallet", async () => {
  const query = async () => { throw new Error("Free text must not read the money ledger"); };
  assert.equal((await checkAiCreditProviderBoundary({ tenant: { id: 7, slug: "default" } }, "text", query)).mode, "free");
  assert.equal((await checkAiCreditProviderBoundary({ tenant: { id: 7, slug: "customer" } }, "text", query)).mode, "free");
  await assert.rejects(checkAiCreditProviderBoundary({ tenant: null }, "text", query), { code: "AI_SKILLS_DISABLED" });
  assert.deepEqual(aiImageCharge(3), { successfulImages: 3, points: 30, amountCents: 30 });
  assert.throws(() => aiImageCharge(0.5));
});

test("a platform price write cannot change the fixed image tariff", async () => {
  let writes = 0;
  const ledger = createAiCreditLedger({ transaction: async () => { writes++; } });
  for (const pointsPerResult of [1, 3, 11]) await assert.rejects(ledger.createPrice({}, { priceKey: "image.generate", version: 1, pointsPerResult }), { code: "AI_CREDIT_INVALID" });
  assert.equal(writes, 0);
});

async function fixture(t, behavior) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "image-success-billing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const tasks = new Map(), attempts = new Map(), saved = new Map();
  let available = 100, frozen = 0, submits = 0, settlements = 0;
  const ledger = {
    async reserve(_session, input) {
      let task = tasks.get(input.idempotencyKey);
      if (task) { assert.equal(task.input_sha256, input.inputSha256); return { ...task }; }
      task = { id: randomUUID(), status: "reserved", input_sha256: input.inputSha256, reserved_points: 10, charged_points: 0 };
      tasks.set(input.idempotencyKey, task); available -= 10; frozen += 10;
      return { ...task };
    },
    async latestAttempt(_session, id) { return attempts.get(id); },
    async startAttempt(_session, id, input) {
      const attempt = { id: randomUUID(), ...input, attempt_number: 1, status: "submitted", should_submit: true };
      attempts.set(id, attempt); [...tasks.values()].find(task => task.id === id).status = "running";
      return { ...attempt };
    },
    async recordOutcome(_session, id, outcome) {
      const task = [...tasks.values()].find(task => task.id === id);
      if (outcome.outcome === "unknown") { task.status = "unknown"; attempts.get(id).status = "unknown"; return { ...task }; }
      settlements++; frozen -= 10;
      if (outcome.outcome === "succeeded") {
        assert.equal(outcome.successfulResults, 1); task.charged_points = 10;
        task.result_reference = outcome.resultReference; task.result_sha256 = outcome.resultSha256;
      } else available += 10;
      task.status = outcome.outcome; attempts.get(id).status = outcome.outcome;
      return { ...task };
    }
  };
  const resultStore = {
    async write(task, result) { saved.set(task.id, structuredClone(result)); return { reference: task.id, sha256: "a".repeat(64) }; },
    async read(reference) { return structuredClone(saved.get(reference)); }
  };
  const getFile = async (id, _scope, filename) => ({ filePath: path.join(directory, id, filename), size: png.length });
  const run = async input => {
    submits++;
    const action = behavior(input, submits);
    if (action === "failed") throw Object.assign(new Error("supplier rejected task"), { code: "provider_job_terminal_failed" });
    if (action === "unknown") throw new Error("connection lost after upstream acceptance");
    await fs.mkdir(path.join(directory, input.taskId), { recursive: true });
    await fs.writeFile(path.join(directory, input.taskId, "generated.png"), action === "invalid" ? "broken image" : png);
    return { taskId: input.taskId, generatedImages: [{ filename: "generated.png", url: `/api/ai/file/${input.taskId}/generated/generated.png` }], croppedImages: input.autoCrop ? [{ filename: "generated.png", url: `/api/ai/file/${input.taskId}/cropped/generated.png` }] : [] };
  };
  const runtime = {
    async mode() { return { mode: "credits" }; },
    async execute(session, { provider, ...input }) {
      return createAiCreditExecutor({ ledger, resultStore, providers: { image: provider }, authorize: async () => {} })(session, input);
    }
  };
  const generate = payload => tryGenerateCreditedImage({ finalPrompt: "test product", idempotencyKey: "persisted-operation", ...payload }, {
    run, getFile, runtime, resolveRuntimes: async () => [{ provider: "offline", imageModel: "test", apiKey: "fixture" }],
    mergeResults: async (results, imageFailures) => ({ generatedImages: results.flatMap(result => result.generatedImages), imageFailures,
      billing: aiImageCharge(results.length) })
  });
  return { generate, stats: () => ({ available, frozen, submits, settlements }) };
}

test("three images with one definite failure cost 20 points; replay never resubmits or charges again", async t => {
  const f = await fixture(t, input => input.batchImageIndex === 1 ? "failed" : "success");
  const first = await f.generate({ imageCount: 3 });
  assert.equal(first.result.generatedImages.length, 2);
  assert.equal(first.result.imageFailures.length, 1);
  assert.deepEqual(first.result.billing, { successfulImages: 2, points: 20, amountCents: 20 });
  assert.deepEqual(f.stats(), { available: 80, frozen: 0, submits: 3, settlements: 3 });
  await f.generate({ imageCount: 3 });
  assert.deepEqual(f.stats(), { available: 80, frozen: 0, submits: 3, settlements: 3 });
});

test("invalid media and an unknown provider acceptance do not charge or blindly retry", async t => {
  for (const behavior of ["invalid", "unknown"]) {
    const f = await fixture(t, () => behavior);
    await assert.rejects(f.generate({ imageCount: 1 }), { code: "AI_CREDIT_RESULT_PENDING" });
    assert.deepEqual(f.stats(), { available: 90, frozen: 10, submits: 1, settlements: 0 });
    await assert.rejects(f.generate({ imageCount: 1 }), { code: "AI_CREDIT_RESULT_PENDING" });
    assert.deepEqual(f.stats(), { available: 90, frozen: 10, submits: 1, settlements: 0 });
  }
});

test("single image-to-image output costs 10 points, cropped derivatives add no fee", async t => {
  const f = await fixture(t, () => "success");
  const response = await f.generate({ sourceImageUrl: "https://owned.invalid/reference.png", autoCrop: true });
  assert.equal(response.result.croppedImages.length, 1);
  assert.equal(response.result.billing.chargedPoints, 10);
  assert.equal(response.result.billing.amountCents, 10);
  await f.generate({ sourceImageUrl: "https://owned.invalid/reference.png", autoCrop: true });
  assert.deepEqual(f.stats(), { available: 90, frozen: 0, submits: 1, settlements: 1 });
});

test("combined downloads preserve every successful generated/cropped file and reuse the same owned task", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "image-combined-delivery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = await fs.readFile(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");
  const start = source.indexOf("async function mergeCreditedImageResults("), end = source.indexOf("\nasync function validateCreditedImageInput", start);
  const owners = new Set();
  const merge = vm.runInNewContext(`(${source.slice(start, end)})`, { crypto, fs, path, aiImageCharge,
    registerAiImageTaskOwner: async id => { if (owners.has(id)) throw Object.assign(new Error(), { code: "ER_DUP_ENTRY" }); owners.add(id); },
    assertAiImageTaskOwner: async id => assert.ok(owners.has(id)),
    getAiTaskFile: async (id, scope, filename) => ({ filePath: path.join(directory, id, scope, filename) }),
    resolveGeneratedTaskDir: id => path.join(directory, id, "generated"),
    resolveCroppedTaskDir: id => path.join(directory, id, "cropped"),
    createImageRecord: (id, scope, filename) => ({ filename, url: `/api/ai/file/${id}/${scope}/${filename}` }),
    zipUrl: id => `/api/ai/zip/${id}`
  });
  const results = [];
  for (let index = 0; index < 2; index++) {
    const taskId = randomUUID();
    for (const scope of ["generated", "cropped"]) {
      await fs.mkdir(path.join(directory, taskId, scope), { recursive: true });
      await fs.writeFile(path.join(directory, taskId, scope, "same.png"), `image-${index}-${scope}`);
    }
    results.push({ taskId, generatedImages: [{ filename: "same.png" }], croppedImages: [{ filename: "same.png", width: 42 }],
      billing: { chargedPoints: 10, creditTaskIds: [taskId] } });
  }
  const combined = await merge(results, [{ index: 1, code: "AI_CREDIT_TASK_FAILED" }]);
  assert.equal(combined.generatedImages.length, 2); assert.equal(combined.croppedImages.length, 2);
  assert.equal(combined.croppedImages[1].width, 42);
  assert.equal(combined.billing.chargedPoints, 20);
  for (const [index, image] of combined.generatedImages.entries()) {
    assert.equal(await fs.readFile(path.join(directory, combined.taskId, "generated", image.filename), "utf8"), `image-${index}-generated`);
    assert.ok(image.url.includes(combined.taskId));
  }
  assert.equal((await merge(results, [])).taskId, combined.taskId);
  assert.equal(owners.size, 1);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { prepareVisionImageTransfers } from "../src/services/vision-image-transfer.js";

const source = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
const names = ["visionWithAiProvider", "visionProviderError", "callOpenAiCompatibleChat", "callOpenAiResponses",
  "streamAiProviderResponse",
  "responsesEndpoint", "messagesToResponsesInput", "messageContentToResponsesContent", "extractAiTextContent",
  "normalizeAiContentValue", "finiteNumber", "statusError"];
const implementation = names.map(name => {
  const node = declarations.find(node => node.type === "FunctionDeclaration" && node.id.name === name);
  assert.ok(node, name);
  return source.slice(node.start, node.end);
}).join("\n");

for (const apiMode of ["chat", "responses"]) {
  for (const scenario of ["success", "quota", "revoked", "retry-429", "non-retryable"]) {
    test(`vision ${apiMode}: ${scenario} reserves and authorizes every actual attempt`, async () => {
      const events = [];
      let attempts = 0, reservations = 0, active = true;
      const denial = Object.assign(new Error(scenario === "quota" ? "Quota exhausted" : "Member revoked"), {
        statusCode: scenario === "quota" ? 409 : 403, code: scenario === "quota" ? "TENANT_AI_QUOTA_EXCEEDED" : "TENANT_TASK_ACCESS_DENIED"
      });
      const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
        assertAiCreditProviderBoundary: async () => ({ mode: "free" }),
        resolveRuntimeConfig: async () => ({ apiMode, provider: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture", textModel: "fixture" }),
        normalizeVisionMessages: messages => messages, cleanText: value => String(value || "").trim(),
        prepareVisionImageTransfers: async messages => messages,
        assertCurrentAiTenantPermission: async () => {},
        reserveTenantAiRequest: async kind => {
          assert.equal(kind, "text"); events.push("authorize");
          if (!active || (scenario === "quota" && reservations === 1)) throw denial;
          reservations++; events.push("reserve");
        },
        delay: async () => { events.push("backoff"); if (scenario === "revoked") active = false; },
        fetch: async (url, options) => {
          assert.equal(url, `https://fixture.invalid/${apiMode === "chat" ? "chat/completions" : "responses"}`);
          assert.equal(options.method, "POST");
          assert.equal(active, true);
          assert.equal(reservations, ++attempts, "Quota must be reserved before each network attempt");
          events.push("fetch");
          const status = attempts === 1 ? (scenario === "non-retryable" ? 400 : 503) : scenario === "retry-429" ? 429 : 200;
          return { ok: status === 200, status, json: async () => status === 200
            ? { output_text: "Result", choices: [{ message: { content: "Result" } }] }
            : { error: { message: "Fixture upstream error" } } };
        }
      });
      vm.runInContext(implementation, context);
      const request = context.visionWithAiProvider({ tenant_id: 3, person_id: 999, messages: [{ role: "user", content: "Fixture" }] });
      if (["quota", "revoked"].includes(scenario)) {
        await assert.rejects(request, error => error === denial, "Auth/quota errors must retain their statusCode/code and not become 502");
        assert.equal(attempts, 1);
        assert.equal(reservations, 1);
        assert.deepEqual(events, ["authorize", "reserve", "fetch", "backoff", "authorize"]);
      } else if (scenario === "non-retryable") {
        await assert.rejects(request, { status: 400 });
        assert.equal(attempts, 1);
        assert.equal(reservations, 1);
      } else {
        if (scenario === "retry-429") await assert.rejects(request, { status: 429 });
        else assert.equal((await request).content, "Result");
        assert.equal(attempts, 2);
        assert.equal(reservations, 2);
        assert.deepEqual(events, ["authorize", "reserve", "fetch", "backoff", "authorize", "reserve", "fetch"]);
      }
    });
  }
}

for (const apiMode of ["chat", "responses", "stream"]) {
  test(`vision ${apiMode} sends the prepared image without changing model/routing or repeating OSS reads on retry`, async () => {
    const original = `https://fixture-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/aa/${"a".repeat(64)}.png`;
    const env = { OSS_INTERNAL_READ: "true", OSS_ENABLED: "true", OSS_BUCKET: "fixture-bucket", OSS_REGION: "oss-cn-heyuan",
      OSS_ACCESS_KEY_ID: "fixture-id", OSS_ACCESS_KEY_SECRET: "fixture-secret" };
    let reads = 0, requests = 0, reservations = 0, authorizations = 0;
    const verifyMessages = messages => assert.match(messages[0].content[1].image_url.url, /^data:image\/webp;base64,/);
    const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
      resolveRuntimeConfig: async (_, options) => {
        assert.equal(options.route, "vision");
        return { apiMode: apiMode === "responses" ? "responses" : "chat", provider: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture", textModel: "unchanged-model" };
      },
      normalizeVisionMessages: messages => messages,
      prepareVisionImageTransfers: (messages, options) => prepareVisionImageTransfers(messages, { ...options, env,
        readImage: async () => { reads++; return { buffer: Buffer.alloc(4000), contentType: "image/png" }; },
        encodeImage: async () => Buffer.alloc(20) }),
      assertCurrentAiTenantPermission: async () => { authorizations++; },
      reserveTenantAiRequest: async () => { reservations++; },
      assertAiCreditProviderBoundary: async () => ({ mode: "free" }),
      cleanText: value => String(value || "").trim(), delay: async () => {},
      streamOpenAiCompatibleChat: async (runtime, options) => {
        assert.equal(runtime.textModel, "unchanged-model"); verifyMessages(options.messages); requests++;
        return { content: "stream-result" };
      },
      fetch: async (url, options) => {
        requests++;
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, "unchanged-model");
        if (apiMode === "responses") assert.match(payload.input[0].content[1].image_url, /^data:image\/webp;base64,/);
        else verifyMessages(payload.messages);
        const status = requests === 1 ? 503 : 200;
        return { ok: status === 200, status, json: async () => status === 200
          ? { output_text: "Result", choices: [{ message: { content: "Result" } }] }
          : { error: { message: "Transient fixture failure" } } };
      }
    });
    vm.runInContext(implementation, context);
    const payload = { route: "vision", messages: [{ role: "user", content: [{ type: "text", text: "Inspect product" },
      { type: "image_url", image_url: { url: original } }] }] };
    if (apiMode === "stream") await context.streamAiProviderResponse(payload, {});
    else await context.visionWithAiProvider(payload);
    assert.equal(reads, 1);
    assert.equal(requests, apiMode === "stream" ? 1 : 2);
    assert.equal(reservations, requests);
    assert.ok(authorizations >= 3);
    assert.equal(payload.messages[0].content[1].image_url.url, original);
  });
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
const names = ["visionWithAiProvider", "visionProviderError", "callOpenAiCompatibleChat", "callOpenAiResponses",
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
        resolveRuntimeConfig: async () => ({ apiMode, provider: "fixture", baseUrl: "https://fixture.invalid", apiKey: "fixture", textModel: "fixture" }),
        normalizeVisionMessages: messages => messages, cleanText: value => String(value || "").trim(),
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

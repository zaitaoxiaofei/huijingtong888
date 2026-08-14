import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("onboarding knowledge is wired into navigation and router", () => {
  const navigation = fs.readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
  const router = fs.readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
  assert.match(navigation, /label: "入职须知"/);
  assert.match(navigation, /route: "\/onboarding"/);
  assert.match(router, /path: "onboarding"/);
  assert.match(router, /OnboardingKnowledgeView/);
});

test("onboarding mutations require manager role and record session identity", () => {
  const authorization = fs.readFileSync(new URL("../src/server/authorization.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../src/server/routes/onboardingKnowledge.js", import.meta.url), "utf8");
  const service = fs.readFileSync(new URL("../src/services/onboarding-knowledge.js", import.meta.url), "utf8");
  assert.match(authorization, /parts\[1\] === "onboarding"/);
  assert.match(authorization, /hasMinimumRole\(session, "manager"\)/);
  assert.match(routes, /req\._session/);
  assert.match(service, /onboarding_article_versions/);
  assert.match(service, /changed_by_person_id/);
  assert.match(service, /updated_by_person_id/);
});

test("knowledge viewer renders structured text without raw html injection", () => {
  const view = fs.readFileSync(new URL("../frontend/admin/views/onboarding/OnboardingKnowledgeView.vue", import.meta.url), "utf8");
  assert.doesNotMatch(view, /v-html/);
  assert.match(view, /parseContent/);
  assert.match(view, /最后修改/);
  assert.match(view, /北京时间/);
});

test("knowledge seed includes the GUOO and CEL packing standard", () => {
  const service = fs.readFileSync(new URL("../src/services/onboarding-knowledge.js", import.meta.url), "utf8");
  assert.match(service, /GUOO \/ CEL 报价与打包发货标准/);
  assert.match(service, /包装完成后的实际重量/);
  assert.match(service, /H 型封箱/);
  assert.match(service, /GUOO 禁运红线/);
  assert.match(service, /CEL产品资费表 V7\.24/);
});

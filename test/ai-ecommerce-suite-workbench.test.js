import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const view = read("frontend/admin/views/listing/AiEcommerceSuiteWorkbenchView.vue");
const router = read("frontend/admin/router/index.js");
const navigation = read("frontend/admin/constants/navigation.js");
const listingService = read("src/services/listing-automation.js");
const generationTasks = read("src/services/ai-generation-tasks.js");
const aiWorkflow = read("src/server/services/ai/aiWorkflowService.js");
const adminLayout = read("frontend/admin/layouts/AdminLayout.vue");
const workbenchWindow = read("frontend/admin/utils/ai-variant-lab-window.js");

test("AI ecommerce suite workbench is routed and available in AI navigation", () => {
  assert.match(router, /AiEcommerceSuiteWorkbenchView/);
  assert.match(router, /ai-ecommerce-suite/);
  assert.match(navigation, /AI电商套图/);
});

test("suite workbench requires product facts while keeping style references optional", () => {
  assert.match(view, /OzonCategorySelect/);
  assert.match(view, /matchingTemplates/);
  assert.match(view, /descriptionCategoryId/);
  assert.match(view, /productTitleZh/);
  assert.match(view, /sellingPointsZh/);
  assert.match(view, /factsConfirmed/);
  assert.match(view, /productImages/);
  assert.match(view, /styleImages/);
  assert.match(view, /generationReferenceImages/);
  assert.match(view, /style references only/);
  assert.match(view, /上传参考图（可选）/);
  assert.match(view, /AI 将自主设计风格/);
  const factsReadySource = view.slice(view.indexOf("const factsReady"), view.indexOf("const storyboard"));
  assert.doesNotMatch(factsReadySource, /!styleImages\.value\.length/);
});

test("suite workbench keeps the recommended image plan under user control", () => {
  assert.match(view, /recommendedShots/);
  assert.match(view, /shotPlan/);
  assert.match(view, /addShot/);
  assert.match(view, /removeShot/);
  assert.match(view, /moveShot/);
  assert.match(view, /商品事实与套图计划（需要时再展开）/);
});

test("suite workbench separates AI candidates from accepted listing outcomes", () => {
  assert.match(view, /const accepted = reactive/);
  assert.match(view, /acceptImage/);
  assert.match(view, /acceptCopy/);
  assert.match(view, /重新生成不会覆盖已采纳内容/);
  assert.match(view, /最新 AI 建议/);
  assert.match(view, /采纳并替换标题/);
  assert.match(view, /listingChecks/);
  assert.match(view, /listingReady/);
});

test("GPT-style composer can generate an image directly from product media and conversation", () => {
  assert.match(view, /canGenerateImage/);
  assert.match(view, /effectiveProductImage/);
  assert.match(view, /styleImages\.value\[0\]/);
  assert.match(view, /USER CONVERSATION INSTRUCTIONS/);
  assert.match(view, /生成主图/);
  assert.match(view, /已自动将第1张作为产品图/);
  assert.match(view, /sourceImageUrls/);
  assert.match(view, /productImageCount/);
  assert.match(generationTasks, /sourceImageUrls/);
  assert.match(aiWorkflow, /buildServerReferenceBoard/);
  assert.match(aiWorkflow, /import sharp from "sharp"/);
  assert.match(view, /attachment-strip/);
  assert.doesNotMatch(view, /:disabled="!factsReady" @click="generateSuite"/);
});

test("GPT-style composer streams a vision-aware reply with complete conversation memory", () => {
  assert.match(view, /streamAiProviderResponse/);
  assert.match(view, /route: "vision"/);
  assert.match(view, /buildChatMessages/);
  assert.match(view, /imageToVisionDataUrl/);
  assert.match(view, /onDelta\(delta\)/);
  assert.match(view, /必须记住并综合全部历史消息/);
  assert.match(view, /upstream request failed/);
  assert.match(view, /自动改用商品文字事实继续对话/);
  assert.doesNotMatch(view, /function nextQuestion/);
});

test("autonomous style mode preserves system-level ecommerce image rules", () => {
  assert.match(view, /ECOMMERCE_IMAGE_SYSTEM_RULES/);
  assert.match(view, /SYSTEM-LEVEL ECOMMERCE RULES \(always apply\)/);
  assert.match(view, /no style reference was supplied/i);
  assert.match(view, /Never render Chinese/);
  assert.match(view, /Never add watermarks/);
});

test("image tasks report progress in chat and product facts do not block draft saving", () => {
  const listingChecksSource = view.slice(view.indexOf("const listingChecks"), view.indexOf("const listingReady"));
  assert.doesNotMatch(listingChecksSource, /factsConfirmed/);
  assert.match(view, /const progress = reactive/);
  assert.match(view, /completedCount \+= 1/);
  assert.match(view, /progress\.streaming = false/);
  assert.match(view, /风格参考图可选/);
  assert.match(view, /本次对话没有得到有效回复/);
});

test("vision chat avoids browser CORS fetches for public cross-origin images", () => {
  assert.match(view, /resolved\.origin !== window\.location\.origin/);
  assert.match(view, /return resolved\.href/);
  assert.match(view, /\$\{label\}读取失败，请删除后重新上传/);
  assert.match(view, /浏览器未收到 ERP 响应/);
});

test("completed outcomes create a draft and enter the existing listing editor", () => {
  assert.match(view, /enterListingEditor/);
  assert.match(view, /name: "listing-automation"/);
  assert.match(view, /query: \{ draftId \}/);
  assert.match(view, /进入上架编辑/);
});

test("Russian listing copy includes Chinese review translations without writing them to draft fields", () => {
  assert.match(aiWorkflow, /titleZh/);
  assert.match(aiWorkflow, /tagsZh/);
  assert.match(aiWorkflow, /descriptionZh/);
  assert.match(view, /中文翻译/);
  assert.match(view, /result\.titleZh/);
  assert.match(view, /accepted\.descriptionZh/);
  assert.doesNotMatch(view, /patch: \{[^}]*titleZh/);
  assert.match(aiWorkflow, /completeCommerceCopyTranslations/);
  assert.match(aiWorkflow, /必须把俄语完整翻译为自然、准确的简体中文/);
});

test("main and detail images receive concise Russian headlines and selling points", () => {
  assert.match(aiWorkflow, /imageHeadline/);
  assert.match(aiWorkflow, /imageSellingPoints/);
  assert.match(aiWorkflow, /detailImageTexts/);
  assert.match(view, /REQUIRED RUSSIAN IMAGE HEADLINE/);
  assert.match(view, /REQUIRED RUSSIAN SELLING POINTS/);
  assert.match(view, /最新 AI 建议/);
  assert.match(view, /item\.imageHeadline/);
  assert.match(view, /item\.imageSellingPoints/);
});

test("suite workbench generates Russian copy and a bounded 3:4 image suite", () => {
  assert.match(view, /generateAiCommerceCopy/);
  assert.match(view, /generateAiImages/);
  assert.match(view, /ratio: "3:4"/);
  assert.match(view, /Never render Chinese/);
  assert.match(view, /runWithConcurrency\(stageShots, 3/);
});

test("suite workbench writes selected media into an existing category template draft", () => {
  assert.match(view, /\/api\/listing\/templates/);
  assert.match(view, /\/api\/listing\/drafts\/ai-variant-lightweight/);
  assert.match(view, /images_manually_edited: true/);
  assert.match(view, /image_edit_intent: "manual"/);
  assert.match(view, /clone_source_draft: false/);
  assert.match(listingService, /optimizationSource === "ai_ecommerce_suite_workbench"/);
});

test("missing category templates are created automatically instead of blocking draft save", () => {
  assert.match(view, /ensureCategoryTemplate/);
  assert.match(view, /await ensureCategoryTemplate\(images\)/);
  assert.match(view, /apiClient\.post\("\/api\/listing\/templates"/);
  assert.match(view, /保存时会自动创建/);
  assert.match(view, /同步\/创建模板/);
});

test("accepted main and detail media support manual uploads and drag ordering", () => {
  assert.match(view, /uploadAcceptedMedia/);
  assert.match(view, /手动上传\/替换主图/);
  assert.match(view, /批量上传详情图/);
  assert.match(view, /acceptedDetailDrag/);
  assert.match(view, /draggable="true"/);
  assert.match(view, /@dragstart="startAcceptedDetailDrag\(index\)"/);
  assert.match(view, /@dragover\.prevent="acceptedDetailDrag\.over=index"/);
  assert.match(view, /@drop="reorderAcceptedDetail\(acceptedDetailDrag\.from,index\)"/);
  assert.match(view, /@dragend="finishAcceptedDetailDrag"/);
  assert.match(view, /role: kind === "main" \? "listing_main" : "listing_detail"/);
});

test("AI ecommerce suite opens as a dedicated standalone browser window", () => {
  assert.match(workbenchWindow, /aiEcommerceSuiteUrl/);
  assert.match(workbenchWindow, /standalone: "1"/);
  assert.match(workbenchWindow, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(adminLayout, /openAiEcommerceSuiteWindow/);
  assert.match(view, /在独立窗口打开/);
});

test("copy, main image and detail images are independent generation actions", () => {
  assert.match(view, /generateCopyCandidate/);
  assert.match(view, /generateImages\('main'\)/);
  assert.match(view, /generateImages\('details'\)/);
  assert.match(view, /loading\.copy/);
  assert.match(view, /loading\.main/);
  assert.match(view, /loading\.details/);
  assert.doesNotMatch(view, /async function generateSuite/);
  assert.doesNotMatch(view, /chatInput\.value\.trim\(\) && !\(await sendChat\(\)\)/);
  assert.match(view, /generatedImages\.value\.filter\(\(item\) => item\.targetRole !== targetRole\)/);
});

test("AI suggestions live inside their matching right-side material slots", () => {
  const template = view.slice(view.indexOf("<template>"));
  const mainColumn = template.slice(template.indexOf('<main class="creator-panel">'), template.indexOf("</main>"));
  const rightColumn = template.slice(template.indexOf('<aside class="outcome-panel">'), template.indexOf("</aside>"));
  assert.match(view, /inline-suggestion/);
  assert.match(view, /mainCandidate/);
  assert.match(view, /detailCandidates/);
  assert.match(view, /grid-template-rows: auto minmax\(520px,1fr\) auto auto/);
  assert.doesNotMatch(mainColumn, /最新 AI 建议/);
  assert.match(rightColumn, /最新 AI 建议/);
});

test("accepted copy suggestions collapse until a new generation supplies replacements", () => {
  assert.match(view, /result\.title = ""/);
  assert.match(view, /result\.titleZh = ""/);
  assert.match(view, /result\.titleOptions = \[\]/);
  assert.match(view, /result\.tags = \[\]/);
  assert.match(view, /result\.tagsZh = \[\]/);
  assert.match(view, /result\.description = ""/);
  assert.match(view, /result\.descriptionZh = ""/);
});

test("AI stream cancellation only follows a real aborted request or unfinished response", () => {
  const server = read("src/server.js");
  assert.match(server, /req\.on\("aborted"/);
  assert.match(server, /if \(!res\.writableEnded\) controller\.abort\(\)/);
  assert.doesNotMatch(server, /req\.on\("close", \(\) => controller\.abort\(\)\)/);
});

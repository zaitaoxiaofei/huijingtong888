<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Delete, MagicStick, Picture, UploadFilled } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api.js";
import { uploadListingMedia, withImageToken } from "../../api/tools/imageCropper.js";
import { generateAiCommerceCopy, generateAiImages, streamAiProviderResponse } from "../../api/tools/aiImageGenerator.js";
import { openAiEcommerceSuiteWindow } from "../../utils/ai-variant-lab-window.js";
import OzonCategorySelect from "../../components/listing/OzonCategorySelect.vue";

const router = useRouter();
const templates = ref([]);
const productImages = ref([]);
const styleImages = ref([]);
const generatedImages = ref([]);
const messages = ref([
  { role: "assistant", text: "请先上传产品图。我会分析商品并逐项追问，不会替你猜商品事实；类目和模板可以等素材完成后再选择。" }
]);
const chatInput = ref("");
const chatCanvas = ref(null);
const loading = reactive({ templates: false, uploadProduct: false, uploadStyle: false, uploadOutcome: false, chat: false, copy: false, main: false, details: false, save: false });
const acceptedDetailDrag = reactive({ from: -1, over: -1 });
const result = reactive({ title: "", titleOptions: [], tags: [], description: "", titleZh: "", tagsZh: [], descriptionZh: "", draftId: "", referenceBoardUrl: "" });
const accepted = reactive({ mainImage: "", detailImages: [], title: "", tags: [], description: "", titleZh: "", tagsZh: [], descriptionZh: "" });
const recommendedShots = [
  { role: "main", title: "商品主图", objective: "准确展示商品主体、适配对象和最重要卖点", selected: true },
  { role: "package", title: "套装内容", objective: "展示真实数量和包装包含内容", selected: true },
  { role: "detail", title: "细节结构", objective: "展示已经确认的材质、纹理或结构细节", selected: true },
  { role: "installation", title: "安装方式", objective: "仅在信息已确认时说明安装位置和方式", selected: true },
  { role: "benefit", title: "核心卖点", objective: "围绕用户提供的真实卖点解决购买疑问", selected: true },
  { role: "scene", title: "使用场景", objective: "展示商品真实、合理的使用环境", selected: true }
];
const ECOMMERCE_IMAGE_SYSTEM_RULES = [
  "SYSTEM-LEVEL ECOMMERCE RULES (always apply): preserve the exact uploaded product identity, geometry, material, color, quantity and confirmed compatibility.",
  "Use a 3:4 portrait ecommerce composition with strong mobile readability and clear product prominence.",
  "All visible marketing copy must be natural, correctly spelled Russian. Never render Chinese, pseudo-text or random letters.",
  "Never add watermarks, marketplace/platform logos, fake certification, official-authorization claims, unverified dimensions, or accessories not confirmed by the operator.",
  "Keep the result photorealistic and commercially polished; do not let creative styling alter product facts."
].join("\n");
const shotPlan = ref(recommendedShots.map((item) => ({ ...item })));
const form = reactive({
  ozonCategoryId: "",
  categoryName: "",
  descriptionCategoryId: "",
  typeId: "",
  templateId: "",
  productTitleZh: "",
  descriptionZh: "",
  compatibilityZh: "",
  sellingPointsZh: "",
  packageContentsZh: "",
  forbiddenFactsZh: "",
  factsConfirmed: false
});

const selectedTemplate = computed(() => templates.value.find((item) => String(item.id) === String(form.templateId)) || null);
const matchingTemplates = computed(() => {
  if (!form.ozonCategoryId) return [];
  return templates.value.filter((item) => {
    const editable = item.editable_payload || {};
    const templateCategory = String(item.ozon_category_id || editable.ozon_category_id || "");
    const descriptionId = String(item.description_category_id || editable.description_category_id || "");
    const typeId = String(item.type_id || editable.type_id || "");
    return templateCategory === String(form.ozonCategoryId)
      || (descriptionId === String(form.descriptionCategoryId) && typeId === String(form.typeId));
  });
});
const sellingPoints = computed(() => splitLines(form.sellingPointsZh));
const factsReady = computed(() => Boolean(
  storyboard.value.length && form.productTitleZh.trim() && form.descriptionZh.trim()
  && sellingPoints.value.length >= 2 && productImages.value.length
  && form.factsConfirmed
));
const missingItems = computed(() => [
  !storyboard.value.length ? "至少选择1张套图计划" : "",
  !form.productTitleZh.trim() ? "中文精确产品名称" : "",
  !form.descriptionZh.trim() ? "中文商品描述" : "",
  sellingPoints.value.length < 2 ? "至少2条核心卖点" : "",
  !productImages.value.length ? "产品图" : "",
  !form.factsConfirmed ? "商品事实确认" : ""
].filter(Boolean));
const storyboard = computed(() => shotPlan.value.filter((item) => item.selected && item.title.trim() && item.objective.trim()));
const listingChecks = computed(() => [
  { label: "主图", ready: Boolean(accepted.mainImage) },
  { label: "详情图", ready: accepted.detailImages.length > 0 },
  { label: "俄语标题", ready: Boolean(accepted.title.trim()) },
  { label: "标签", ready: accepted.tags.length > 0 },
  { label: "俄语描述", ready: Boolean(accepted.description.trim()) },
  { label: "三级类目", ready: Boolean(form.ozonCategoryId) },
  { label: "类目模板", ready: Boolean(form.templateId || form.ozonCategoryId), automatic: !form.templateId && Boolean(form.ozonCategoryId) }
]);
const listingReady = computed(() => listingChecks.value.every((item) => item.ready));
const userMessages = computed(() => messages.value.filter((item) => item.role === "user").map((item) => item.text));
const effectiveProductImage = computed(() => productImages.value[0] || styleImages.value[0] || null);
const generationReferenceImages = computed(() => productImages.value.length
  ? [...productImages.value, ...styleImages.value]
  : [...styleImages.value]);
const generationProductImageCount = computed(() => productImages.value.length || (styleImages.value.length ? 1 : 0));
const canGenerateImage = computed(() => Boolean(effectiveProductImage.value && (chatInput.value.trim() || userMessages.value.length || form.productTitleZh.trim())));
const mainCandidate = computed(() => generatedImages.value.find((item) => item.targetRole === "main") || null);
const detailCandidates = computed(() => generatedImages.value.filter((item) => item.targetRole === "details"));

onMounted(loadTemplates);

function openStandaloneWorkbench() {
  openAiEcommerceSuiteWindow({ source: "workbench" });
}

async function loadTemplates() {
  loading.templates = true;
  try {
    templates.value = await apiClient.get("/api/listing/templates", { noCache: true });
  } catch (error) {
    ElMessage.error(error.message || "类目模板加载失败");
  } finally {
    loading.templates = false;
  }
}

function splitLines(value = "") {
  return String(value || "").split(/[\n；;]+/).map((item) => item.trim()).filter(Boolean);
}

function invalidateFacts() {
  form.factsConfirmed = false;
  result.draftId = "";
}

function syncFactsFromConversation(text = "") {
  const source = String(text || "").trim();
  if (!source) return;
  const factualText = source
    .replace(/前\S{0,8}张是产品图[^。！；]*/g, "")
    .replace(/第\S{0,8}张是(?:风格)?参考图[^。！；]*/g, "")
    .replace(/类目是[：:]?[^。！；]*/g, "")
    .trim();
  const clauses = factualText.split(/[，,；;。\n]+/).map((item) => item.trim()).filter(Boolean);
  const namedProduct = factualText.match(/(?:这是|产品是)?(.{2,48}?(?:收纳盒|收纳袋|收纳箱))/)?.[1]?.trim();
  if (!form.productTitleZh.trim()) form.productTitleZh = namedProduct || clauses[0]?.replace(/^这是/, "").slice(0, 60) || "";
  if (!form.descriptionZh.trim()) form.descriptionZh = factualText || source;
  if (!form.compatibilityZh.trim()) {
    const compatibility = source.match(/(?:适用于?|for\s+)?([一-龥A-Za-z0-9 -]*(?:EX5|EM-i|EMI)[一-龥A-Za-z0-9 -]*)/i)?.[1]?.trim();
    if (compatibility) form.compatibilityZh = compatibility;
  }
  if (sellingPoints.value.length < 2) {
    form.sellingPointsZh = clauses.filter((item) => item !== clauses[0]).slice(0, 6).join("\n");
  }
  if (form.productTitleZh.trim() && form.descriptionZh.trim() && sellingPoints.value.length >= 2) {
    form.factsConfirmed = true;
  }
}

function selectCategory(category = {}) {
  form.ozonCategoryId = category.ozon_category_id || `${category.description_category_id}:${category.type_id}`;
  form.descriptionCategoryId = category.description_category_id || category.descriptionCategoryId || "";
  form.typeId = category.type_id || category.typeId || "";
  form.categoryName = category.path_zh || category.pathZh || category.name_zh || category.nameZh || category.label || "";
  form.templateId = "";
  result.draftId = "";
  queueMicrotask(() => {
    if (matchingTemplates.value.length === 1) form.templateId = String(matchingTemplates.value[0].id);
  });
}

function addShot() {
  shotPlan.value.push({ role: `custom-${Date.now()}`, title: "自定义图片", objective: "填写这张图片要向买家说明的内容", selected: true });
}

function removeShot(index) {
  shotPlan.value.splice(index, 1);
}

function moveShot(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= shotPlan.value.length) return;
  const [item] = shotPlan.value.splice(index, 1);
  shotPlan.value.splice(target, 0, item);
}

function resetShotPlan() {
  shotPlan.value = recommendedShots.map((item) => ({ ...item }));
}

async function uploadGroup(uploadFile, group) {
  const file = uploadFile?.raw || uploadFile;
  if (!file) return;
  const key = group === "product" ? "uploadProduct" : "uploadStyle";
  loading[key] = true;
  try {
    const uploaded = await uploadListingMedia(file, {
      source_module: "ai_ecommerce_suite_workbench",
      role: group === "product" ? "product_reference" : "style_reference"
    });
    const item = { name: file.name || uploaded.name, url: uploaded.publishUrl || uploaded.url || uploaded.previewUrl };
    if (group === "product") productImages.value.push(item);
    else styleImages.value.push(item);
    invalidateFacts();
  } catch (error) {
    ElMessage.error(error.message || "图片上传失败");
  } finally {
    loading[key] = false;
  }
}

function removeImage(group, index) {
  (group === "product" ? productImages : styleImages).value.splice(index, 1);
  invalidateFacts();
}

async function scrollChatToBottom() {
  await nextTick();
  if (chatCanvas.value) chatCanvas.value.scrollTop = chatCanvas.value.scrollHeight;
}

async function imageToVisionDataUrl(url, label = "图片") {
  const source = String(url || "").trim();
  if (!source) throw new Error(`${label}地址为空，请删除后重新上传`);

  let resolved;
  try {
    resolved = new URL(source, window.location.href);
  } catch {
    throw new Error(`${label}地址无效，请删除后重新上传`);
  }

  // Cross-origin marketplace/OSS images are often readable by the AI provider but
  // blocked by browser CORS. Sending the public URL avoids a needless browser fetch.
  if (["http:", "https:"].includes(resolved.protocol) && resolved.origin !== window.location.origin) {
    return resolved.href;
  }

  try {
    const response = await fetch(withImageToken(resolved.href));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch (error) {
    throw new Error(`${label}读取失败，请删除后重新上传（${error?.message || "未知错误"}）`);
  }
}

async function buildChatMessages() {
  const history = messages.value
    .filter((item) => item.text && !item.streaming)
    .map((item) => ({ role: item.role, content: item.text }));
  // Chat analysis only needs representative views. Sending every high-resolution
  // image can make compatible vision gateways return an empty completion.
  // Image generation still receives the complete product/reference collection.
  const attachments = [
    ...productImages.value.slice(0, 2).map((item) => ({ ...item, kind: "产品图" })),
    ...styleImages.value.slice(0, 1).map((item) => ({ ...item, kind: "风格参考图" }))
  ];
  if (attachments.length) {
    const content = [{ type: "text", text: `本轮附件：${attachments.map((item, index) => `${index + 1}.${item.kind}`).join("；")}。请结合图片和完整对话理解商品。` }];
    const encoded = await Promise.all(attachments.map((item, index) => imageToVisionDataUrl(item.url, `${item.kind}${index + 1}`)));
    encoded.forEach((url) => content.push({ type: "image_url", image_url: { url } }));
    history.push({ role: "user", content });
  }
  return [{
    role: "system",
    content: [
      "你是电商商品创作顾问，正在与用户进行连续的中文对话。",
      "你必须记住并综合全部历史消息，不要重复询问用户已经回答的信息。",
      "产品图用于确认商品外观与结构；风格参考图只用于理解构图、灯光、配色和排版，不得把参考图中的商品当成用户商品。",
      "先简洁确认你理解到的商品事实和生图方向，然后每轮最多追问1至2个真正影响结果的问题。",
      "不得编造材质、尺寸、数量、车型、认证或配件。看不清的图片信息要明确说需要用户确认。",
      "当商品身份、核心卖点和画面方向已足够时，明确告诉用户：信息已经足够，可以点击“生成文案和主图”。",
      "只输出自然中文对话，不要输出JSON。"
    ].join("\n")
  }, ...history];
}

function textOnlyChatMessages(chatMessages) {
  return chatMessages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .filter((item) => item?.type === "text")
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n");
    return { ...message, content: text || "用户已上传商品图和风格参考图，请结合已提供的文字事实继续对话。" };
  });
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || loading.chat) return false;
  messages.value.push({ role: "user", text });
  syncFactsFromConversation(text);
  chatInput.value = "";
  const reply = reactive({ role: "assistant", text: "正在读取对话和参考图片…", streaming: true });
  messages.value.push(reply);
  loading.chat = true;
  let requestStage = "准备图片与对话";
  await scrollChatToBottom();
  try {
    const chatMessages = await buildChatMessages();
    requestStage = "连接 AI 对话服务";
    const streamOptions = {
      onDelta(delta) {
        if (reply.text === "正在读取对话和参考图片…") reply.text = "";
        reply.text += delta;
        scrollChatToBottom();
      }
    };
    let completed;
    try {
      completed = await streamAiProviderResponse({ route: "vision", messages: chatMessages, temperature: 0.25, maxTokens: 900, timeoutMs: 180000 }, streamOptions);
    } catch (visionError) {
      const status = Number(visionError?.status || 0);
      const upstreamUnavailable = [0, 429, 500, 502, 503, 504].includes(status)
        || /upstream request failed|failed to fetch|timeout|network/i.test(String(visionError?.message || ""));
      if (!upstreamUnavailable || reply.text.trim()) throw visionError;
      requestStage = "视觉服务暂时不可用，已自动改用商品文字事实继续对话";
      completed = await streamAiProviderResponse({ route: "text", messages: textOnlyChatMessages(chatMessages), temperature: 0.25, maxTokens: 900, timeoutMs: 180000 }, streamOptions);
    }
    if (!reply.text.trim()) reply.text = completed?.content || "我已收到，请继续补充商品信息。";
    return true;
  } catch (error) {
    console.error("[ai-ecommerce-suite] chat failed", {
      stage: requestStage,
      name: error?.name || "Error",
      status: error?.status || 0,
      message: error?.message || String(error)
    });
    reply.text = `本次对话没有得到有效回复：${error?.message || "AI 服务暂时无响应"}。你的输入和图片都已保留，可以直接重试；生图仍可独立使用全部参考图。`;
    chatInput.value = text;
    ElMessage.error(error.message === "Failed to fetch" ? `${requestStage}失败：浏览器未收到 ERP 响应；已保留本次输入` : `${requestStage}失败：${error.message || "未知错误"}`);
    return false;
  } finally {
    reply.streaming = false;
    loading.chat = false;
    scrollChatToBottom();
  }
}

function productFacts() {
  return {
    product_title_zh: form.productTitleZh.trim(),
    description_zh: form.descriptionZh.trim(),
    compatibility_zh: splitLines(form.compatibilityZh),
    selling_points_zh: sellingPoints.value,
    package_contents_zh: splitLines(form.packageContentsZh),
    forbidden_facts_zh: splitLines(form.forbiddenFactsZh),
    confirmed_by_operator: form.factsConfirmed === true
  };
}

function generatedImageUrl(output = {}) {
  return output.generatedImages?.[0]?.url || output.croppedImages?.[0]?.url || output.images?.[0]?.url || output.url || "";
}

async function runWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return output;
}

async function generateImages(targetRole) {
  syncFactsFromConversation(chatInput.value || userMessages.value.join("\n"));
  if (!canGenerateImage.value) return ElMessage.warning("请先上传产品图，并在对话框说明希望生成的画面");
  loading[targetRole] = true;
  generatedImages.value = generatedImages.value.filter((item) => item.targetRole !== targetRole);
  const progress = reactive({
    role: "assistant",
    text: targetRole === "main"
      ? `已开始生成主图：将使用 ${productImages.value.length || 1} 张产品图和 ${styleImages.value.length} 张风格参考图，通常需要 1–3 分钟。`
      : `已开始生成详情图：将使用 ${productImages.value.length || 1} 张产品图和 ${styleImages.value.length} 张风格参考图。`,
    streaming: true
  });
  messages.value.push(progress);
  await scrollChatToBottom();
  try {
    result.referenceBoardUrl = effectiveProductImage.value?.url || "";
    if (!result.referenceBoardUrl) throw new Error("没有可用于生成的产品图片，请重新上传");
    const facts = productFacts();
    const copy = result;
    const imageHeadline = result.imageHeadline || result.title || accepted.title || "";
    const imageSellingPoints = Array.isArray(result.imageSellingPoints) ? result.imageSellingPoints.slice(0, 4) : [];
    const stageShots = targetRole === "main"
      ? [storyboard.value.find((shot) => shot.role === "main") || recommendedShots[0]]
      : storyboard.value.filter((shot) => shot.role !== "main");
    if (!stageShots.length) throw new Error("请先在套图计划中选择至少一张详情图");
    if (targetRole === "details") progress.text = `详情图任务已提交，共 ${stageShots.length} 张；完成一张就会更新一次进度。`;
    let completedCount = 0;
    const imagePromise = runWithConcurrency(stageShots, 3, async (shot, index) => {
      const detailText = Array.isArray(copy.detailImageTexts)
        ? copy.detailImageTexts.find((item) => item.role === shot.role) || copy.detailImageTexts[index]
        : null;
      const shotHeadline = shot.role === "main" ? imageHeadline : detailText?.title || imageHeadline;
      const shotPoints = shot.role === "main" ? imageSellingPoints : detailText?.points?.length ? detailText.points : imageSellingPoints.slice(0, 3);
      const output = await generateAiImages({
        sourceImageUrl: result.referenceBoardUrl,
        sourceImageUrls: generationReferenceImages.value.map((item) => item.url),
        productImageCount: generationProductImageCount.value,
        fallbackSourceImageUrl: effectiveProductImage.value?.url,
        ratio: "3:4",
        imageCount: 1,
        autoCrop: false,
        finalPrompt: [
          ECOMMERCE_IMAGE_SYSTEM_RULES,
          "Create one 3:4 premium Russian ecommerce image.",
          `MULTI-REFERENCE RULE: the first ${generationProductImageCount.value} panel(s) show the authoritative product from different angles. Combine their consistent shape and structure; never treat extra product angles as different products.`,
          styleImages.value.length
            ? "STYLE MODE: the remaining panels are optional style references only. Borrow background family, lighting, spacing, commercial hierarchy and typography mood, but never copy their product, brand, logo, text, vehicle, claims or accessories."
            : "STYLE MODE: no style reference was supplied. Independently choose a coherent premium ecommerce art direction appropriate for the confirmed product and shot objective; keep the suite visually consistent and obey every system-level rule above.",
          `SHOT: ${shot.title}. OBJECTIVE: ${shot.objective}.`,
          `OPERATOR-CONFIRMED FACTS: ${JSON.stringify(facts)}.`,
          `USER CONVERSATION INSTRUCTIONS: ${[...userMessages.value, chatInput.value.trim()].filter(Boolean).join("\n") || form.productTitleZh || "Create a clean ecommerce presentation of the uploaded product"}.`,
          shotHeadline ? `REQUIRED RUSSIAN IMAGE HEADLINE: ${shotHeadline}.` : "No verified Russian headline is available. Use a clean image without text instead of inventing text.",
          shotPoints.length ? `REQUIRED RUSSIAN SELLING POINTS: ${JSON.stringify(shotPoints)}.` : "No verified Russian selling points are available. Do not invent text callouts.",
          index === 0 ? "Main image must clearly identify the exact product and confirmed compatibility on mobile." : "This is a supporting detail image in one coherent suite.",
          "Remove all Chinese source captions. Never render Chinese, pseudo-text, random letters, watermarks or marketplace logos.",
          "Render the supplied Russian headline clearly near the top. Render 2-3 supplied selling points as short, readable supporting callouts with strong mobile hierarchy.",
          "Do not invent, paraphrase, misspell or concatenate the supplied Russian text. Keep generous whitespace and ensure text never covers the product."
        ].join("\n\n")
      }, { timeoutMs: 20 * 60 * 1000 });
      const url = generatedImageUrl(output);
      if (!url) throw new Error(`${shot.title}未返回图片`);
      completedCount += 1;
      progress.text = targetRole === "main"
        ? "主图已经生成，正在整理到右侧建议区…"
        : `详情图生成进度：${completedCount}/${stageShots.length}，已完成“${shot.title}”。`;
      scrollChatToBottom();
      return {
        ...shot,
        url,
        selected: true,
        targetRole,
        imageHeadline: shotHeadline,
        imageSellingPoints: shotPoints,
        imageHeadlineZh: shot.role === "main" ? copy.imageHeadlineZh : detailText?.titleZh || copy.imageHeadlineZh,
        imageSellingPointsZh: shot.role === "main" ? copy.imageSellingPointsZh : detailText?.pointsZh || copy.imageSellingPointsZh
      };
    });
    const images = await imagePromise;
    generatedImages.value = [...generatedImages.value.filter((item) => item.targetRole !== targetRole), ...images];
    progress.text = targetRole === "main"
      ? "主图建议已生成，请在右侧预览并点击“采纳为最终主图”。"
      : `${images.length} 张详情图建议已生成，请在右侧逐张采纳或全部采纳。`;
    ElMessage.success(targetRole === "main" ? "主图候选已生成，满意后请采用为主图" : "详情图候选已生成，请逐张采用到右侧");
  } catch (error) {
    progress.text = `${targetRole === "main" ? "主图" : "详情图"}生成失败：${error?.message || "AI 服务暂时无响应"}。已保留本次文字和全部图片，可直接重试。`;
    ElMessage.error(error.message === "Failed to fetch" ? "AI 连接中断，本次任务可直接重试" : error.message || "电商图生成失败");
  } finally {
    progress.streaming = false;
    loading[targetRole] = false;
    scrollChatToBottom();
  }
}

async function generateCopyCandidate() {
  syncFactsFromConversation(chatInput.value || userMessages.value.join("\n"));
  if (!form.productTitleZh.trim() || !form.descriptionZh.trim()) return ElMessage.warning("请先在对话中补充商品名称和用途，再生成俄语文案");
  loading.copy = true;
  try {
    const facts = productFacts();
    const copy = await generateAiCommerceCopy({
      productName: facts.product_title_zh,
      title: facts.product_title_zh,
      summary: facts.description_zh,
      sellingPoints: facts.selling_points_zh.join("；"),
      exactProductIdentity: JSON.stringify(facts),
      rules: ["Generate precise Russian title, search tags and description.", "Never invent product facts or output Chinese."],
      sourceContext: { operatorFacts: facts, conversation: userMessages.value, categoryTemplate: selectedTemplate.value },
      aiTimeoutMs: 180000
    }, { timeoutMs: 10 * 60 * 1000 });
    applyCopyResult(copy);
    ElMessage.success("俄语文案候选已生成，可采用到右侧");
  } catch (error) {
    ElMessage.error(error.message === "Failed to fetch" ? "AI 文案连接中断，请重试" : error.message || "俄语文案生成失败");
  } finally {
    loading.copy = false;
  }
}

function applyCopyResult(copy = {}) {
  result.titleOptions = Array.isArray(copy.titles) ? copy.titles : [copy.title].filter(Boolean);
  result.title = result.titleOptions[0] || "";
  result.tags = Array.isArray(copy.tags) ? copy.tags : [];
  result.description = copy.description || "";
  result.titleZh = copy.titleZh || "";
  result.tagsZh = Array.isArray(copy.tagsZh) ? copy.tagsZh : [];
  result.descriptionZh = copy.descriptionZh || "";
  result.imageHeadline = copy.imageHeadline || "";
  result.imageSellingPoints = Array.isArray(copy.imageSellingPoints) ? copy.imageSellingPoints : [];
  result.imageHeadlineZh = copy.imageHeadlineZh || "";
  result.imageSellingPointsZh = Array.isArray(copy.imageSellingPointsZh) ? copy.imageSellingPointsZh : [];
  result.detailImageTexts = Array.isArray(copy.detailImageTexts) ? copy.detailImageTexts : [];
}

function acceptImage(item) {
  if (item.targetRole === "main") {
    accepted.mainImage = item.url;
    generatedImages.value = generatedImages.value.filter((candidate) => candidate.targetRole !== "main");
    result.draftId = "";
    ElMessage.success("已采用为主图");
    return;
  }
  if (!accepted.detailImages.includes(item.url)) accepted.detailImages.push(item.url);
  generatedImages.value = generatedImages.value.filter((candidate) => candidate.url !== item.url);
  result.draftId = "";
  ElMessage.success("已采用到详情图");
}

function acceptAllDetails() {
  generatedImages.value.forEach((item) => {
    if (item.url !== accepted.mainImage && !accepted.detailImages.includes(item.url)) accepted.detailImages.push(item.url);
  });
  generatedImages.value = generatedImages.value.filter((item) => item.targetRole !== "details");
  result.draftId = "";
}

function acceptCopy(type) {
  if (type === "title") {
    accepted.title = result.title;
    accepted.titleZh = result.titleZh;
    result.title = "";
    result.titleZh = "";
    result.titleOptions = [];
  }
  if (type === "tags") {
    accepted.tags = [...result.tags];
    accepted.tagsZh = [...result.tagsZh];
    result.tags = [];
    result.tagsZh = [];
  }
  if (type === "description") {
    accepted.description = result.description;
    accepted.descriptionZh = result.descriptionZh;
    result.description = "";
    result.descriptionZh = "";
  }
  result.draftId = "";
  ElMessage.success("已采用到右侧商品成果");
}

function removeAcceptedDetail(index) {
  accepted.detailImages.splice(index, 1);
  result.draftId = "";
}

async function uploadAcceptedMedia(uploadFile, kind) {
  const file = uploadFile?.raw || uploadFile;
  if (!file) return;
  loading.uploadOutcome = true;
  try {
    const uploaded = await uploadListingMedia(file, {
      source_module: "ai_ecommerce_suite_workbench",
      role: kind === "main" ? "listing_main" : "listing_detail"
    });
    const url = uploaded.publishUrl || uploaded.url || uploaded.previewUrl;
    if (!url) throw new Error("图片上传后未返回可用地址");
    if (kind === "main") accepted.mainImage = url;
    else if (!accepted.detailImages.includes(url)) accepted.detailImages.push(url);
    result.draftId = "";
    ElMessage.success(kind === "main" ? "主图已上传" : "详情图已添加");
  } catch (error) {
    ElMessage.error(error.message || "成果图片上传失败");
  } finally {
    loading.uploadOutcome = false;
  }
}

function startAcceptedDetailDrag(index) {
  acceptedDetailDrag.from = index;
  acceptedDetailDrag.over = index;
}

function finishAcceptedDetailDrag() {
  acceptedDetailDrag.from = -1;
  acceptedDetailDrag.over = -1;
}

function reorderAcceptedDetail(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= accepted.detailImages.length || toIndex >= accepted.detailImages.length) {
    finishAcceptedDetailDrag();
    return;
  }
  const [url] = accepted.detailImages.splice(fromIndex, 1);
  accepted.detailImages.splice(toIndex, 0, url);
  result.draftId = "";
  finishAcceptedDetailDrag();
}

function moveImage(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= generatedImages.value.length) return;
  const [item] = generatedImages.value.splice(index, 1);
  generatedImages.value.splice(target, 0, item);
}

async function saveDraft() {
  const images = [accepted.mainImage, ...accepted.detailImages].filter(Boolean);
  if (!listingReady.value) return ElMessage.warning(`还需完成：${listingChecks.value.filter((item) => !item.ready).map((item) => item.label).join("、")}`);
  loading.save = true;
  try {
    await ensureCategoryTemplate(images);
    const template = await apiClient.get(`/api/listing/templates/${encodeURIComponent(form.templateId)}`, { noCache: true });
    const offer = await apiClient.post("/api/listing/generate-offer-id", { prefix: "SUITE", existingIds: [] });
    const offerId = offer.offerId || offer.offer_id;
    const editable = template.editable_payload || {};
    const synchronizeCopyAttributes = (attributes = []) => (Array.isArray(attributes) ? attributes : []).map((attribute) => {
      const attributeId = Number(attribute.attribute_id || attribute.attributeId || attribute.id || 0);
      const attributeName = String(attribute.name_zh || attribute.nameZh || attribute.name || "").toLowerCase();
      if (attributeId === 4191 || /(简介|description|аннотация|описание)/i.test(attributeName)) {
        return {
          ...attribute,
          value: accepted.description,
          label: accepted.description,
          display_value_zh: accepted.description,
          values: [{ value: accepted.description, label: accepted.description }],
          selected_values: [{ value: accepted.description, label: accepted.description }]
        };
      }
      if (attributeId === 23171 || /(产品标签|主题标签|关键词|ключевые слова|тег)/i.test(attributeName)) {
        return {
          ...attribute,
          value: accepted.tags,
          label: accepted.tags.join(" "),
          display_value_zh: accepted.tags.join(" "),
          values: accepted.tags.map((tag) => ({ value: tag, label: tag })),
          selected_values: accepted.tags.map((tag) => ({ value: tag, label: tag }))
        };
      }
      return attribute;
    });
    const synchronizedAttributes = synchronizeCopyAttributes(editable.attributes?.length ? editable.attributes : template.attributes);
    const synchronizedCategoryAttributes = synchronizeCopyAttributes(editable.category_attributes?.length ? editable.category_attributes : template.category_attributes);
    const synchronizeDynamicAttributes = (attributes = {}) => Object.fromEntries(Object.entries(attributes || {}).map(([key, attribute]) => {
      if (Number(key) === 4191) return [key, synchronizeCopyAttributes([{ ...attribute, attribute_id: 4191 }])[0]];
      if (Number(key) === 23171) return [key, synchronizeCopyAttributes([{ ...attribute, attribute_id: 23171 }])[0]];
      const synchronized = synchronizeCopyAttributes([attribute])[0] || attribute;
      return [key, synchronized];
    }));
    const imageObjects = images.map((url, index) => ({ url, role: index === 0 ? "main" : "detail", sort_order: index + 1 }));
    const templatePayload = {
      ...template,
      title: accepted.title,
      description: accepted.description,
      attributes: synchronizedAttributes,
      category_attributes: synchronizedCategoryAttributes,
      images: imageObjects,
      editable_payload: {
        ...editable,
        title: accepted.title,
        name: accepted.title,
        description: accepted.description,
        tags: accepted.tags,
        hashtags: accepted.tags,
        logistics: { ...(editable.logistics || {}), tags: accepted.tags },
        attributes: synchronizedAttributes,
        category_attributes: synchronizedCategoryAttributes,
        images: imageObjects,
        variants: (Array.isArray(editable.variants) && editable.variants.length ? editable.variants : [{}]).map((variant, index) => ({
          ...variant,
          title: accepted.title,
          name: accepted.title,
          description: accepted.description,
          tags: accepted.tags,
          hashtags: accepted.tags,
          main_tags: accepted.tags,
          dynamic_attributes: synchronizeDynamicAttributes(variant.dynamic_attributes),
          ...(index === 0 ? { primary_image: images[0] } : {}),
          images: imageObjects,
          images_manually_edited: true,
          image_edit_intent: "manual"
        }))
      }
    };
    const draft = await apiClient.post("/api/listing/drafts/ai-variant-lightweight", {
      template_id: Number(form.templateId),
      template_payload: templatePayload,
      clone_source_draft: false,
      development_type: "new",
      product_name: accepted.title,
      offer_id: offerId,
      internal_code: offerId,
      source_images: images,
      patch: { offer_id: offerId, title: accepted.title, description: accepted.description, tags: accepted.tags, images },
      manual_facts: { operator_product_facts: productFacts(), style_reference_urls: styleImages.value.map((item) => item.url), image_edit_intent: "manual" },
      ai_optimization: { source: "ai_ecommerce_suite_workbench", storyboard: storyboard.value, reference_board_url: result.referenceBoardUrl },
      changed_fields: ["offer_id", "title", "description", "tags", "images"]
    });
    result.draftId = draft.id || draft.draft_id || "";
    ElMessage.success(`已保存为上架草稿 ${result.draftId}`);
    return result.draftId;
  } catch (error) {
    ElMessage.error(error.message || "保存草稿失败");
  } finally {
    loading.save = false;
  }
}

async function ensureCategoryTemplate(images = [accepted.mainImage, ...accepted.detailImages].filter(Boolean)) {
  if (form.templateId) return selectedTemplate.value;
  if (!form.ozonCategoryId) throw new Error("请先选择 Ozon 三级类目");

  await loadTemplates();
  if (matchingTemplates.value.length) {
    form.templateId = String(matchingTemplates.value[0].id);
    return matchingTemplates.value[0];
  }

  const imageObjects = images.map((url, index) => ({ url, role: index === 0 ? "main" : "detail", sort_order: index + 1 }));
  const categoryName = form.categoryName || `Ozon类目 ${form.ozonCategoryId}`;
  const editablePayload = {
    ozon_category_id: form.ozonCategoryId,
    description_category_id: form.descriptionCategoryId || "",
    type_id: form.typeId || "",
    category_name: categoryName,
    title: accepted.title,
    name: accepted.title,
    description: accepted.description,
    tags: accepted.tags,
    hashtags: accepted.tags,
    images: imageObjects,
    variants: [{
      title: accepted.title,
      name: accepted.title,
      primary_image: images[0] || "",
      images: imageObjects,
      images_manually_edited: true,
      image_edit_intent: "manual"
    }]
  };
  const created = await apiClient.post("/api/listing/templates", {
    ozon_category_id: form.ozonCategoryId,
    description_category_id: form.descriptionCategoryId || "",
    type_id: form.typeId || "",
    category_name: categoryName,
    template_name: `${categoryName}-AI套图模板`,
    source_type: "ai_ecommerce_suite_workbench",
    title: accepted.title,
    description: accepted.description,
    attributes: [],
    required_attributes: [],
    ai_rules: [],
    image_rules: { ratio: "3:4", no_chinese: true },
    images: imageObjects,
    editable_payload: editablePayload
  });
  if (!created?.id) throw new Error("类目模板自动创建失败");
  templates.value = [created, ...templates.value.filter((item) => Number(item.id) !== Number(created.id))];
  form.templateId = String(created.id);
  ElMessage.success("该三级类目暂无模板，已自动创建并继续保存");
  return created;
}

async function syncOrCreateTemplate() {
  if (!form.ozonCategoryId) return ElMessage.warning("请先选择 Ozon 三级类目");
  loading.save = true;
  try {
    await ensureCategoryTemplate();
  } catch (error) {
    ElMessage.error(error.message || "类目模板同步失败");
  } finally {
    loading.save = false;
  }
}

async function enterListingEditor() {
  const draftId = result.draftId || await saveDraft();
  if (!draftId) return;
  await router.push({ name: "listing-automation", query: { draftId } });
}
</script>

<template>
  <div class="suite-page">
    <header class="suite-header"><div><h2>AI电商套图工作台</h2><p>左侧与AI共同创作，满意后采用到右侧；右侧全部完成即可进入上架编辑。</p></div><el-button type="primary" plain @click="openStandaloneWorkbench">在独立窗口打开</el-button></header>
    <div class="conversation-layout">
      <main class="creator-panel">
        <div class="panel-title"><div><h3>AI创作对话</h3><span>支持多张产品图；风格参考图可选。未上传参考图时，AI会在全局电商规则内自主设计统一风格。</span></div></div>
        <div ref="chatCanvas" class="messages chat-canvas"><div v-for="(item,index) in messages" :key="index" :class="['message', item.role, { streaming: item.streaming }]">{{ item.text }}<i v-if="item.streaming" class="stream-cursor" /></div><div v-if="messages.length===1" class="chat-hint"><b>从一句话开始</b><span>例如：这是吉利EX5中控屏后的收纳盒，请参考上传图片的黑蓝科技风，先生成一张俄语电商主图。</span></div></div>

        <el-collapse class="advanced-collapse"><el-collapse-item title="商品事实与套图计划（需要时再展开）" name="advanced"><div class="form-grid"><label><span>中文精确产品名称</span><el-input v-model="form.productTitleZh" @input="invalidateFacts" /></label><label><span>适配车型 / 对象</span><el-input v-model="form.compatibilityZh" @input="invalidateFacts" /></label><label class="wide"><span>中文商品描述</span><el-input v-model="form.descriptionZh" type="textarea" :rows="3" @input="invalidateFacts" /></label><label><span>核心卖点（每行一条）</span><el-input v-model="form.sellingPointsZh" type="textarea" :rows="3" @input="invalidateFacts" /></label><label><span>套装内容与数量</span><el-input v-model="form.packageContentsZh" type="textarea" :rows="3" @input="invalidateFacts" /></label><label class="wide"><span>禁止AI编写的内容</span><el-input v-model="form.forbiddenFactsZh" @input="invalidateFacts" /></label></div><el-checkbox v-model="form.factsConfirmed">以上商品事实真实准确，AI不得自行修改</el-checkbox><div class="advanced-plan"><div class="group-head"><b>详情套图建议</b><div><el-button size="small" @click="resetShotPlan">恢复</el-button><el-button size="small" @click="addShot">添加</el-button></div></div><div class="storyboard-editor"><div v-for="(shot,index) in shotPlan" :key="shot.role" class="storyboard-row"><el-checkbox v-model="shot.selected" /><span>{{ index+1 }}</span><el-input v-model="shot.title" /><el-input v-model="shot.objective" /><el-button text type="danger" @click="removeShot(index)">删除</el-button></div></div></div></el-collapse-item></el-collapse>

        <div class="composer"><div v-if="productImages.length||styleImages.length" class="attachment-strip"><div v-for="(item,index) in productImages" :key="`p-${item.url}`" class="attachment"><el-image :src="withImageToken(item.url)" fit="cover" /><span>产品图</span><button @click="removeImage('product',index)">×</button></div><div v-for="(item,index) in styleImages" :key="`s-${item.url}`" class="attachment" :class="{style: productImages.length || index>0}"><el-image :src="withImageToken(item.url)" fit="cover" /><span>{{ !productImages.length&&index===0 ? '自动作为产品图' : '参考图' }}</span><button @click="removeImage('style',index)">×</button></div></div><el-input v-model="chatInput" type="textarea" :rows="3" placeholder="像和 GPT 聊天一样，继续补充商品或画面要求……" @keyup.ctrl.enter="sendChat" /><div class="composer-actions"><div class="upload-actions"><el-upload :auto-upload="false" :show-file-list="false" multiple accept="image/*" :on-change="(file)=>uploadGroup(file,'product')"><el-button :icon="UploadFilled">上传产品图</el-button></el-upload><el-upload :auto-upload="false" :show-file-list="false" multiple accept="image/*" :on-change="(file)=>uploadGroup(file,'style')"><el-button :icon="Picture">上传参考图（可选）</el-button></el-upload><span v-if="!productImages.length&&styleImages.length" class="auto-product-tip">已自动将第1张作为产品图</span><span v-else-if="productImages.length&&!styleImages.length" class="auto-product-tip">未上传参考图：AI 将自主设计风格</span></div><div class="stage-actions"><el-button :loading="loading.chat" :disabled="loading.copy||loading.main||loading.details" @click="sendChat">发送</el-button><el-button :loading="loading.copy" :disabled="loading.chat" @click="generateCopyCandidate">生成文案</el-button><el-button type="primary" plain :icon="MagicStick" :loading="loading.main" :disabled="!canGenerateImage||loading.chat" @click="generateImages('main')">生成主图</el-button><el-button type="primary" :icon="MagicStick" :loading="loading.details" :disabled="!canGenerateImage||loading.chat" @click="generateImages('details')">生成详情图</el-button></div></div></div>
      </main>

      <aside class="outcome-panel">
        <div class="panel-title"><div><h3>商品成果与上架准备</h3><span>每项同时显示最终素材与最新建议；重新生成不会覆盖已采纳内容</span></div></div>
        <div class="facts-save-tip">“商品事实”只用于提高 AI 准确度，可在左侧展开校对，不再阻止保存。保存只检查最终素材、三级类目和模板。</div>
        <label><span>Ozon三级类目</span><OzonCategorySelect v-model="form.ozonCategoryId" :display-label="form.categoryName" :show-sync="false" placeholder="按一级 / 二级 / 三级选择" @select="selectCategory" /></label>
        <label><span>该类目模板</span><div class="template-picker"><el-select v-model="form.templateId" :disabled="!form.ozonCategoryId" placeholder="选择匹配模板"><el-option v-for="item in matchingTemplates" :key="item.id" :label="item.template_name || item.category_name" :value="String(item.id)" /></el-select><el-button :loading="loading.save" :disabled="!form.ozonCategoryId" @click="syncOrCreateTemplate">{{ matchingTemplates.length ? '刷新模板' : '同步/创建模板' }}</el-button></div><small v-if="form.ozonCategoryId&&!matchingTemplates.length" class="field-tip warning">当前类目暂无模板，保存时会自动创建，不会阻塞上架</small></label>
        <div class="readiness"><div v-for="item in listingChecks" :key="item.label"><span>{{ item.label }}</span><el-tag :type="item.ready?'success':'info'" size="small">{{ item.ready?'已完成':'待完成' }}</el-tag></div></div>
        <section class="outcome-section material-slot"><div class="outcome-heading"><div><h4>主图</h4><el-tag :type="accepted.mainImage?'success':'info'" size="small">{{ accepted.mainImage?'已采纳':'待完成' }}</el-tag></div><el-upload :auto-upload="false" :show-file-list="false" accept="image/*" :on-change="(file)=>uploadAcceptedMedia(file,'main')"><el-button size="small" :loading="loading.uploadOutcome" :icon="UploadFilled">手动上传/替换主图</el-button></el-upload></div><el-image v-if="accepted.mainImage" class="accepted-main" :src="withImageToken(accepted.mainImage)" fit="cover" preview-teleported /><el-empty v-else :image-size="42" description="尚未采纳主图" /><div v-if="mainCandidate" class="inline-suggestion"><div class="suggestion-head"><b>最新 AI 建议</b><el-tag type="warning" size="small">待采纳</el-tag></div><el-image class="accepted-main" :src="withImageToken(mainCandidate.url)" fit="cover" preview-teleported /><b>{{ mainCandidate.imageHeadline || mainCandidate.title }}</b><div class="image-points"><span v-for="point in mainCandidate.imageSellingPoints" :key="point">{{ point }}</span></div><el-button type="primary" plain @click="acceptImage(mainCandidate)">采纳为最终主图</el-button></div></section>
        <section class="outcome-section material-slot">
          <div class="outcome-heading"><div><h4>详情图（{{ accepted.detailImages.length }}）</h4><el-tag :type="accepted.detailImages.length?'success':'info'" size="small">{{ accepted.detailImages.length?'已采纳':'待完成' }}</el-tag></div><el-upload :auto-upload="false" :show-file-list="false" multiple accept="image/*" :on-change="(file)=>uploadAcceptedMedia(file,'detail')"><el-button size="small" :loading="loading.uploadOutcome" :icon="Picture">批量上传详情图</el-button></el-upload></div>
          <div v-if="accepted.detailImages.length" class="detail-sort-tip">拖拽图片即可调整上架顺序</div>
          <div class="accepted-details">
            <div
              v-for="(url,index) in accepted.detailImages"
              :key="url"
              class="accepted-detail-card"
              :class="{ dragging: acceptedDetailDrag.from===index, 'drag-over': acceptedDetailDrag.over===index&&acceptedDetailDrag.from!==index }"
              draggable="true"
              @dragstart="startAcceptedDetailDrag(index)"
              @dragover.prevent="acceptedDetailDrag.over=index"
              @drop="reorderAcceptedDetail(acceptedDetailDrag.from,index)"
              @dragend="finishAcceptedDetailDrag"
            >
              <el-image :src="withImageToken(url)" fit="cover" preview-teleported />
              <div class="detail-actions"><span>第 {{ index+1 }} 张</span><el-button text type="danger" @click="removeAcceptedDetail(index)">移除</el-button></div>
            </div>
          </div>
          <div v-if="detailCandidates.length" class="inline-suggestion"><div class="suggestion-head"><b>最新 AI 建议（{{ detailCandidates.length }}）</b><el-button size="small" @click="acceptAllDetails">全部采纳</el-button></div><div class="result-grid"><div v-for="item in detailCandidates" :key="item.url" class="result-image"><el-image :src="withImageToken(item.url)" fit="cover" preview-teleported /><b>{{ item.imageHeadline || item.title }}</b><div class="image-points"><span v-for="point in item.imageSellingPoints" :key="point">{{ point }}</span></div><el-button type="primary" plain @click="acceptImage(item)">采纳</el-button></div></div></div>
        </section>
        <section class="outcome-section text-outcome"><label><div class="field-status"><span>俄语标题</span><el-tag :type="accepted.title?'success':'info'" size="small">{{ accepted.title?'已采纳':'待完成' }}</el-tag></div><el-input v-model="accepted.title" type="textarea" :rows="2" /><small class="zh-translation">中文：{{ accepted.titleZh || '暂无翻译' }}</small><div v-if="result.title" class="inline-suggestion"><div class="suggestion-head"><b>最新 AI 建议</b><el-tag type="warning" size="small">待采纳</el-tag></div><el-input v-model="result.title" type="textarea" :rows="2" /><small class="zh-translation">中文：{{ result.titleZh || '暂无翻译' }}</small><el-button @click="acceptCopy('title')">采纳并替换标题</el-button></div></label><label><div class="field-status"><span>标签</span><el-tag :type="accepted.tags.length?'success':'info'" size="small">{{ accepted.tags.length?'已采纳':'待完成' }}</el-tag></div><el-input :model-value="accepted.tags.join(' ')" type="textarea" :rows="2" @input="accepted.tags=String($event).split(/\s+/).filter(Boolean)" /><small class="zh-translation">中文：{{ accepted.tagsZh.length ? accepted.tagsZh.join('、') : '暂无翻译' }}</small><div v-if="result.tags.length" class="inline-suggestion"><div class="suggestion-head"><b>最新 AI 建议</b><el-tag type="warning" size="small">待采纳</el-tag></div><el-input :model-value="result.tags.join(' ')" type="textarea" :rows="3" @input="result.tags=String($event).split(/\s+/).filter(Boolean)" /><small class="zh-translation">中文：{{ result.tagsZh.length ? result.tagsZh.join('、') : '暂无翻译' }}</small><el-button @click="acceptCopy('tags')">采纳并替换标签</el-button></div></label><label><div class="field-status"><span>俄语描述</span><el-tag :type="accepted.description?'success':'info'" size="small">{{ accepted.description?'已采纳':'待完成' }}</el-tag></div><el-input v-model="accepted.description" type="textarea" :rows="5" /><div class="zh-translation description">中文翻译：{{ accepted.descriptionZh || '暂无翻译' }}</div><div v-if="result.description" class="inline-suggestion"><div class="suggestion-head"><b>最新 AI 建议</b><el-tag type="warning" size="small">待采纳</el-tag></div><el-input v-model="result.description" type="textarea" :rows="5" /><div class="zh-translation description">中文翻译：{{ result.descriptionZh || '暂无翻译' }}</div><el-button @click="acceptCopy('description')">采纳并替换描述</el-button></div></label></section>
        <div class="listing-actions"><el-button :loading="loading.save" :disabled="!listingReady" @click="saveDraft">保存草稿</el-button><el-button type="primary" :loading="loading.save" :disabled="!listingReady" @click="enterListingEditor">保存并进入上架编辑</el-button><small v-if="!listingReady">还需：{{ listingChecks.filter(item=>!item.ready).map(item=>item.label).join('、') }}</small><small v-else-if="!form.templateId" class="field-tip">保存时将自动创建当前三级类目模板</small></div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.suite-page { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.suite-header, .group-head, .save-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.suite-header h2, .suite-card h3, .assistant-panel h3 { margin: 0; }
.suite-header p, .group-head span { margin: 4px 0 0; color: #697386; font-size: 12px; }
.conversation-layout { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(400px, .9fr); gap: 14px; align-items: start; }
.creator-panel, .outcome-panel { background: #fff; border: 1px solid #e5eaf3; border-radius: 14px; padding: 14px; display: grid; gap: 14px; min-width: 0; }
.creator-panel { grid-template-rows: auto minmax(520px,1fr) auto auto; min-height: calc(100vh - 150px); }
.outcome-panel { position: sticky; top: 10px; max-height: calc(100vh - 90px); overflow: auto; }
.panel-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid #edf0f5; padding-bottom: 12px; }
.panel-title h3, .creator-block h3, .outcome-section h4 { margin: 0; }
.panel-title span { display: block; margin-top: 4px; color: #697386; font-size: 12px; }
.facts-save-tip { padding: 8px 10px; border-radius: 8px; background: #f0f7ff; color: #3d6392; font-size: 12px; line-height: 1.5; }
.template-picker, .outcome-heading, .detail-actions { display: flex; align-items: center; gap: 8px; }
.template-picker .el-select { flex: 1; min-width: 0; }
.outcome-heading { justify-content: space-between; margin-bottom: 10px; }
.outcome-heading > div, .field-status, .suggestion-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.outcome-heading > div { justify-content: flex-start; }
.detail-actions { justify-content: center; gap: 2px; }
.candidate-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid #edf0f5; }
.candidate-title h4 { margin: 0; }
.candidate-title span { display: block; margin-top: 3px; color: #697386; font-size: 12px; }
.sidebar-candidates { border-color: #f3d19e; background: #fffdf8; }
.sidebar-candidates .copy-candidates { grid-template-columns: 1fr; }
.sidebar-candidates .result-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sidebar-candidates .result-image b { font-size: 12px; overflow-wrap: anywhere; }
.creator-block, .facts-collapse, .composer, .outcome-section { border: 1px solid #e5eaf3; border-radius: 12px; padding: 12px; }
.advanced-collapse { border: 0; }
.advanced-collapse :deep(.el-collapse-item__header) { height: 42px; border: 1px solid #edf0f5; border-radius: 10px; padding: 0 12px; color: #697386; }
.advanced-collapse :deep(.el-collapse-item__wrap) { border: 0; }
.advanced-collapse :deep(.el-collapse-item__content) { padding: 12px 2px 2px; }
.advanced-plan { margin-top: 18px; padding-top: 14px; border-top: 1px solid #edf0f5; }
.chat-canvas { max-height: none; min-height: 420px; padding: 30px max(24px,8%); align-content: start; background: #fff; }
.chat-canvas .message { max-width: 78%; padding: 12px 16px; line-height: 1.65; border-radius: 18px; }
.chat-canvas .message.assistant { justify-self: start; background: #f4f4f5; }
.chat-canvas .message.user { justify-self: end; background: #eef4ff; margin-left: 0; }
.stream-cursor { display: inline-block; width: 7px; height: 16px; margin-left: 4px; vertical-align: -2px; background: #409eff; animation: stream-blink .8s steps(1) infinite; }
@keyframes stream-blink { 50% { opacity: 0; } }
.chat-hint { align-self: center; justify-self: center; display: grid; gap: 8px; max-width: 520px; padding: 44px 28px; text-align: center; color: #697386; }
.chat-hint b { color: #202938; font-size: 18px; }
.image-grid.compact { grid-template-columns: repeat(auto-fill, minmax(100px, 132px)); }
.copy-candidates { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-top: 14px; }
.zh-translation { display: block; color: #5d6777; background: #f5f7fa; border-left: 3px solid #8bb9f5; border-radius: 6px; padding: 7px 9px; line-height: 1.55; white-space: normal; }
.zh-translation.description { max-height: 150px; overflow: auto; font-size: 12px; }
.image-points { display: grid; gap: 4px; }
.image-points > span { display: grid; gap: 2px; padding: 5px 7px; border-radius: 6px; background: #f6f8fb; color: #313947; white-space: normal; font-size: 12px; }
.image-points small { color: #7a8493; }
.composer { position: sticky; bottom: 0; z-index: 2; background: #fff; border-color: #d9dee8; border-radius: 18px; box-shadow: 0 10px 35px rgba(30,50,80,.12); }
.composer :deep(.el-textarea__inner) { border: 0; box-shadow: none; resize: none; padding: 10px 12px; font-size: 14px; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 8px; }
.upload-actions { display: flex; align-items: center; gap: 7px; color: #87909f; font-size: 12px; }
.auto-product-tip { color: #26834a; background: #edf9f1; border-radius: 999px; padding: 5px 9px; }
.attachment-strip { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 9px; }
.attachment { position: relative; flex: 0 0 76px; display: grid; gap: 3px; font-size: 11px; color: #697386; }
.attachment .el-image { width: 76px; height: 76px; border-radius: 10px; background: #f4f6f8; }
.attachment.style .el-image { outline: 2px solid #c9b8ff; outline-offset: -2px; }
.attachment button { position: absolute; right: -4px; top: -4px; width: 20px; height: 20px; border: 0; border-radius: 50%; background: #303642; color: #fff; cursor: pointer; }
.stage-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.readiness { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
.readiness > div { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-radius: 7px; background: #f6f8fb; font-size: 12px; }
.accepted-main { width: min(220px,100%); aspect-ratio: 3/4; border-radius: 8px; background: #f4f6f8; }
.accepted-details { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 7px; }
.accepted-details > div { display: grid; }
.accepted-details .el-image { width: 100%; aspect-ratio: 3/4; border-radius: 6px; }
.detail-sort-tip { color: #697386; font-size: 12px; }
.accepted-detail-card { position: relative; padding: 5px; border: 1px solid #e1e6ef; border-radius: 8px; background: #fff; cursor: grab; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, opacity .16s ease; }
.accepted-detail-card.dragging { opacity: .58; cursor: grabbing; transform: scale(.96); }
.accepted-detail-card.drag-over { border-color: #409eff; transform: translateY(-3px); box-shadow: 0 0 0 2px rgba(64,158,255,.16); }
.accepted-detail-card.drag-over::before { content: ""; position: absolute; inset: 6px auto 6px -4px; width: 4px; border-radius: 99px; background: #409eff; }
.accepted-detail-card .detail-actions { justify-content: space-between; padding: 2px 4px 0; color: #697386; font-size: 12px; }
.text-outcome { display: grid; gap: 10px; }
.material-slot { display: grid; gap: 10px; }
.inline-suggestion { display: grid; gap: 9px; margin-top: 10px; padding: 10px; border: 1px solid #f3d19e; border-radius: 9px; background: #fffaf0; }
.inline-suggestion .result-grid { margin-top: 0; }
.listing-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; position: sticky; bottom: -14px; padding: 12px 0 14px; background: #fff; }
.listing-actions small { grid-column: 1/-1; color: #b36b00; }
.suite-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
.suite-main { display: grid; gap: 14px; min-width: 0; }
.suite-card, .assistant-panel { background: #fff; border: 1px solid #e5eaf3; border-radius: 10px; padding: 14px; }
.form-grid, .copy-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin: 12px 0; }
label { display: grid; gap: 6px; font-size: 13px; }
label.wide { grid-column: 1 / -1; }
.image-groups { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
.image-group { min-width: 0; }
.image-grid, .result-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(128px,1fr)); gap: 10px; margin-top: 12px; }
.image-item, .result-image { display: grid; gap: 6px; min-width: 0; }
.image-item .el-image, .result-image .el-image { width: 100%; aspect-ratio: 3 / 4; border-radius: 8px; background: #f4f6f8; }
.image-item span, .result-image span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #697386; }
.field-tip { font-size: 12px; color: #697386; }
.field-tip.warning { color: #b36b00; }
.plan-rule { margin-top: 12px; }
.storyboard-editor { display: grid; gap: 8px; margin-top: 12px; }
.storyboard-row { display: grid; grid-template-columns: auto 24px minmax(140px,.45fr) minmax(260px,1fr) auto; gap: 8px; align-items: center; }
.shot-index { color: #697386; text-align: center; }
.plan-summary { margin-top: 10px; text-align: right; color: #697386; font-size: 13px; }
.assistant-panel { position: sticky; top: 10px; display: grid; gap: 12px; }
.missing { display: flex; flex-wrap: wrap; gap: 6px; }
.missing b { width: 100%; }
.missing span { background: #f3f6fa; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
.messages { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
.message { border-radius: 8px; padding: 9px 10px; font-size: 13px; white-space: pre-wrap; }
.message.assistant { background: #f3f6fa; }
.message.user { background: #e8f3ff; margin-left: 24px; }
.chat-send { width: 100%; }
@media (max-width: 1100px) { .conversation-layout { grid-template-columns: 1fr; } .outcome-panel { position: static; max-height: none; } }
@media (max-width: 760px) { .form-grid, .copy-grid, .image-groups, .copy-candidates { grid-template-columns: 1fr; } label.wide { grid-column: auto; } .storyboard-row { grid-template-columns: auto 24px 1fr; } .storyboard-row > :nth-child(4), .storyboard-row > :nth-child(5) { grid-column: 3; } .composer-actions { align-items: flex-end; } .upload-actions span { display: none; } .stage-actions { flex-wrap: wrap; } }
</style>

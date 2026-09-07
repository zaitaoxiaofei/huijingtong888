<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { CircleCheck, MagicStick, Refresh, SwitchButton } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const saving = ref(false);
const testingImageChannelId = ref("");
const checkingImageUsageChannelId = ref("");
const imageTestResult = ref(null);
const imageUsageResults = reactive({});
const configUpdatedAt = ref("");
const workspaceTab = ref("routing");
const providerDialogVisible = ref(false);
const providerPage = ref(1);
const providerPageSize = 10;
const capabilityTestingKey = ref("");
const capabilityResult = ref(null);

const form = reactive({
  provider: "deepseek",
  name: "DeepSeek",
  apiKey: "",
  clearApiKey: false,
  baseUrl: "https://api.deepseek.com",
  textModel: "deepseek-v4-flash",
  visionModel: "",
  imageModel: "",
  videoModel: "",
  apiMode: "chat_completions",
  enabled: false,
  hasApiKey: false,
  apiKeyHint: ""
});

const routes = reactive({
  text: { provider: "deepseek", model: "deepseek-v4-flash" },
  vision: { provider: "", model: "" },
  image: { provider: "", model: "" },
  video: { provider: "", model: "" }
});

const savedProviders = ref({});
const hiddenProviders = ref([]);
const imageProviderPool = reactive({
  enabled: false,
  mode: "speed",
  maxConcurrency: 20,
  channels: []
});

const presetOptions = [
  { label: "DeepSeek", value: "deepseek" },
  { label: "Kimi", value: "kimi" },
  { label: "豆包", value: "doubao" },
  { label: "OpenAI", value: "openai" },
  { label: "CCTQ-image2", value: "cctq-image2" },
  { label: "Change2Pro image2", value: "change2pro-image2" },
  { label: "自定义兼容接口", value: "custom" }
];

const routeCards = [
  { key: "text", title: "全局文本模型", desc: "文案、翻译、标题、卖点和普通对话请求" },
  { key: "vision", title: "全局视觉模型", desc: "识图、图片理解、多模态分析请求" },
  { key: "image", title: "全局生图模型", desc: "主图裂变、AI 生图和素材生成请求" },
  { key: "video", title: "全局视频模型", desc: "后续视频生成、剪辑和脚本类请求" }
];

const providerTips = {
  deepseek: {
    token: "在 DeepSeek 开放平台创建 API Key，填入 sk- 开头的密钥。",
    baseUrl: "https://api.deepseek.com",
    model: "常用文本模型：deepseek-v4-flash；推理模型按控制台当前模型名填写。"
  },
  kimi: {
    token: "在 Moonshot/Kimi 开放平台创建 API Key。",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "常用文本模型：moonshot-v1-8k、moonshot-v1-32k、moonshot-v1-128k。"
  },
  doubao: {
    token: "在火山方舟创建 API Key；模型名通常是你在方舟控制台拿到的 endpoint id。",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "把方舟控制台的推理接入点 ID 填到文本模型里。"
  },
  openai: {
    token: "在 OpenAI Platform 创建 API Key。",
    baseUrl: "https://api.openai.com/v1",
    model: "文本可用 gpt-4.1-mini；视觉可用 gpt-4.1-mini；生图可用 gpt-image-1。"
  },
  "cctq-image2": {
    token: "填写 CCTQ 中转站 Bearer Token，后端会加密保存。",
    baseUrl: "https://www.cctq.ai/v1",
    model: "图片模型填写 gpt-image-2；该配置主要用于主图裂变和 AI 图片生成。"
  },
  "change2pro-image2": {
    token: "填写 Change2Pro 提供的 image2 API Key，后端会加密保存。",
    baseUrl: "https://api.change2pro.com",
    model: "生图模型默认 gpt-image-2；接口协议选择 Images API，对应 /images/edits 和 /images/generations。"
  },
  custom: {
    token: "填写服务商提供的 Bearer Token 或 API Key。",
    baseUrl: "填写兼容 OpenAI Chat Completions 的根地址，不要带 /chat/completions。",
    model: "填写服务商文档里的模型名或 endpoint id。"
  }
};

const currentTip = computed(() => providerTips[form.provider] || providerTips.custom);
const savedApiKeyDisplay = computed(() => formatApiKeyHint(form.apiKeyHint));
const apiKeyPlaceholder = computed(() => (
  form.hasApiKey ? "留空则保持当前服务商已保存密钥不变" : "请输入 API Key，保存后只在后端加密存储"
));
const enabledProviderCount = computed(() => Object.values(savedProviders.value).filter((item) => item?.enabled).length);
const routeReadyCount = computed(() => routeCards.filter((item) => routeStatus(item.key).ready).length);
const selectedProviderLabel = computed(() => providerLabel(form.provider));
const imageChannelCount = computed(() => imageProviderPool.channels.filter((item) => item.enabled !== false).length);
const imageChannelCapacity = computed(() => imageProviderPool.channels
  .filter((item) => item.enabled !== false)
  .reduce((sum, item) => sum + normalizeUiConcurrency(item.maxConcurrency, 1), 0));
const imageEffectiveConcurrency = computed(() => Math.min(
  normalizeUiConcurrency(imageProviderPool.maxConcurrency, 1),
  Math.max(1, imageChannelCapacity.value || 1)
));
const providerOptions = computed(() => {
  const options = presetOptions.filter((option) => !hiddenProviders.value.includes(option.value)).map((option) => ({
    ...option,
    label: savedProviders.value?.[option.value]?.name || option.label
  }));
  for (const [key, item] of Object.entries(savedProviders.value || {})) {
    if (options.some((option) => option.value === key)) continue;
    options.push({ label: item?.name || key, value: key });
  }
  for (const channel of imageProviderPool.channels) {
    const provider = channel.provider || "";
    if (!provider || options.some((option) => option.value === provider)) continue;
    options.push({ label: providerDisplayName(provider, channel), value: provider });
  }
  return options;
});

const providerNavItems = computed(() => providerOptions.value.map((option) => {
  const saved = savedProviders.value?.[option.value] || providerProfileFromImageChannel(option.value) || {};
  const modelCount = [saved.textModel, saved.visionModel, saved.imageModel, saved.videoModel].filter(Boolean).length;
  return {
    ...option,
    enabled: Boolean(saved.enabled),
    hasApiKey: Boolean(saved.hasApiKey),
    modelCount,
    removable: true
  };
}));
const deletedPresetOptions = computed(() => presetOptions.filter((option) => hiddenProviders.value.includes(option.value)));
const pagedProviderNavItems = computed(() => {
  const start = (providerPage.value - 1) * providerPageSize;
  return providerNavItems.value.slice(start, start + providerPageSize);
});

watch(() => form.provider, (provider) => {
  if (loading.value) return;
  applyProviderToForm(provider);
});

onMounted(loadConfig);

async function loadConfig() {
  loading.value = true;
  try {
    const data = await apiClient.get("/api/ai-provider/config", { noCache: true });
    configUpdatedAt.value = data.updated_at || "";
    savedProviders.value = data.providers || {};
    hiddenProviders.value = data.hiddenProviders || [];
    Object.assign(routes, normalizeRoutes(data.routes || data.globalRoutes || {}, data));
    applyImageProviderPool(data.imageProviderPool || data.image_provider_pool || {});
    applyConfigToForm(data.provider || "deepseek", data);
  } catch (error) {
    ElMessage.error(error.message || "AI 配置加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveConfig(options = {}) {
  const includeImageProviderPool = options.includeImageProviderPool === true;
  saving.value = true;
  imageTestResult.value = null;
  try {
    const payload = {
      provider: form.provider,
      name: form.name,
      apiKey: form.apiKey,
      clearApiKey: form.clearApiKey,
      baseUrl: form.baseUrl,
      textModel: form.textModel,
      visionModel: form.visionModel,
      imageModel: form.imageModel,
      videoModel: form.videoModel,
      apiMode: form.apiMode,
      enabled: form.enabled,
      routes,
      updated_at: configUpdatedAt.value || ""
    };
    if (includeImageProviderPool) {
      payload.imageProviderPool = imageProviderPoolPayload();
    }
    const data = await apiClient.post("/api/ai-provider/config", payload);
    configUpdatedAt.value = data.updated_at || "";
    savedProviders.value = data.providers || {};
    hiddenProviders.value = data.hiddenProviders || [];
    Object.assign(routes, normalizeRoutes(data.routes || {}, data));
    applyImageProviderPool(data.imageProviderPool || {});
    applyConfigToForm(data.provider || form.provider, data);
    if (options.closeProviderDialog === true) providerDialogVisible.value = false;
    ElMessage.success("AI 配置已保存");
  } catch (error) {
    ElMessage.error(error.message || "AI 配置保存失败");
  } finally {
    saving.value = false;
  }
}

async function setEnabledAndSave(enabled) {
  form.enabled = Boolean(enabled);
  await saveConfig({ includeImageProviderPool: false });
}

async function testImagePoolChannel(channel) {
  testingImageChannelId.value = channel.id;
  imageTestResult.value = null;
  try {
    const data = await apiClient.post("/api/ai-provider/test-image-channel", {
      channelId: channel.id,
      apiKey: channel.apiKey,
      mode: "generate"
    });
    imageTestResult.value = { ...data, scope: "pool", channelId: channel.id };
    data.ok ? ElMessage.success(`${channel.name || "图片通道"} 测试成功`) : ElMessage.error(data.message || "图片通道测试失败");
  } catch (error) {
    imageTestResult.value = { ok: false, scope: "pool", channelId: channel.id, name: channel.name, message: error.message || "图片通道测试失败" };
    ElMessage.error(error.message || "图片通道测试失败");
  } finally {
    testingImageChannelId.value = "";
  }
}

async function loadImageChannelUsage(channel) {
  checkingImageUsageChannelId.value = channel.id;
  try {
    const data = await apiClient.post("/api/ai-provider/image-channel-usage", {
      channelId: channel.id,
      apiKey: channel.apiKey,
      usageApiKey: channel.usageApiKey
    });
    imageUsageResults[channel.id] = data;
    data.supported ? ElMessage.success("65535 余额与用量已更新") : ElMessage.warning(data.message || "当前通道不支持余额查询");
  } catch (error) {
    imageUsageResults[channel.id] = { ok: false, message: error.message || "65535 余额查询失败" };
    ElMessage.error(error.message || "65535 余额查询失败");
  } finally {
    checkingImageUsageChannelId.value = "";
  }
}

function formatUsageAmount(value, unit = "RMB") {
  if (value === null || value === undefined || value === "") return "—";
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(3)} ${unit || "RMB"}` : "—";
}

async function testCapability(type, scope = "provider") {
  const key = `${scope}:${type}`;
  capabilityTestingKey.value = key;
  capabilityResult.value = null;
  const route = routes[type] || {};
  const payload = scope === "route"
    ? { type, provider: route.provider, model: route.model }
    : {
        type,
        provider: form.provider,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        textModel: form.textModel,
        visionModel: form.visionModel,
        imageModel: form.imageModel,
        videoModel: form.videoModel,
        apiMode: form.apiMode
      };
  try {
    const data = await apiClient.post("/api/ai-provider/test-capability", payload);
    capabilityResult.value = { ...data, scope };
    if (data.ok) ElMessage.success(`${capabilityTypeLabel(type)}测试成功`);
    else ElMessage.warning(data.message || `${capabilityTypeLabel(type)}暂不可测试`);
  } catch (error) {
    capabilityResult.value = { ok: false, supported: true, type, scope, message: error.message || "测试失败" };
    ElMessage.error(error.message || `${capabilityTypeLabel(type)}测试失败`);
  } finally {
    capabilityTestingKey.value = "";
  }
}

function capabilityTypeLabel(type) {
  return { text: "文本模型", vision: "视觉模型", image: "生图模型", video: "视频模型" }[type] || "模型";
}

function providerModelFor(type) {
  return form[`${type}Model`] || "";
}

function applyConfigToForm(provider, data) {
  const providers = data.providers || savedProviders.value || {};
  savedProviders.value = providers;
  const selected = providers[provider] || providerProfileFromImageChannel(provider) || data || {};
  Object.assign(form, {
    provider,
    name: selected.name || providerLabel(provider),
    apiKey: "",
    clearApiKey: false,
    baseUrl: normalizeProviderBaseUrl(provider, selected.baseUrl || providerTips[provider]?.baseUrl || "", selected.name),
    textModel: selected.textModel || "",
    visionModel: selected.visionModel || "",
    imageModel: normalizeProviderImageModel(provider, selected.imageModel || "", selected.baseUrl, selected.name),
    videoModel: selected.videoModel || "",
    apiMode: normalizeProviderApiMode(provider, selected.apiMode || "chat_completions", selected.baseUrl, selected.name),
    enabled: Boolean(selected.enabled),
    hasApiKey: Boolean(selected.hasApiKey),
    apiKeyHint: selected.apiKeyHint || ""
  });
}

function applyProviderToForm(provider) {
  const saved = savedProviders.value[provider];
  if (saved) {
    applyConfigToForm(provider, { providers: savedProviders.value });
    return;
  }
  const channelProfile = providerProfileFromImageChannel(provider);
  if (channelProfile) {
    applyConfigToForm(provider, { providers: { ...savedProviders.value, [provider]: channelProfile } });
    return;
  }
  const tip = providerTips[provider] || providerTips.custom;
  const defaults = defaultModels(provider);
  Object.assign(form, {
    name: providerDisplayName(provider),
    apiKey: "",
    clearApiKey: false,
    baseUrl: isCustomProviderKey(provider) ? "" : tip.baseUrl,
    textModel: defaults.textModel,
    visionModel: defaults.visionModel,
    imageModel: defaults.imageModel,
    videoModel: defaults.videoModel,
    apiMode: saved?.apiMode || defaultApiMode(provider),
    enabled: false,
    hasApiKey: false,
    apiKeyHint: ""
  });
}

function createProviderProfile() {
  const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const name = `自定义服务商 ${Object.keys(savedProviders.value || {}).filter((key) => key.startsWith("custom_")).length + 1}`;
  savedProviders.value = {
    ...savedProviders.value,
    [id]: {
      provider: id,
      name,
      baseUrl: "",
      textModel: "",
      visionModel: "",
      imageModel: "",
      videoModel: "",
      apiMode: "chat_completions",
      enabled: false,
      hasApiKey: false,
      apiKeyHint: ""
    }
  };
  applyConfigToForm(id, { providers: savedProviders.value });
  providerDialogVisible.value = true;
}

function restorePresetProvider(provider) {
  hiddenProviders.value = hiddenProviders.value.filter((key) => key !== provider);
  applyProviderToForm(provider);
  providerDialogVisible.value = true;
}

function handleAddProvider(command) {
  if (command === "custom") createProviderProfile();
  else restorePresetProvider(command);
}

function editProviderProfile(provider) {
  applyProviderToForm(provider);
  providerDialogVisible.value = true;
}

async function deleteProviderProfile(item) {
  if (!item.removable) return;
  try {
    await ElMessageBox.confirm(
      `确定删除服务商“${item.label}”吗？已保存的密钥和模型配置将一并删除。`,
      "删除服务商",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
    const data = await apiClient.post("/api/ai-provider/delete", { provider: item.value });
    configUpdatedAt.value = data.updated_at || "";
    savedProviders.value = data.providers || {};
    hiddenProviders.value = data.hiddenProviders || [];
    Object.assign(routes, normalizeRoutes(data.routes || {}, data));
    applyImageProviderPool(data.imageProviderPool || {});
    applyConfigToForm(data.provider || "deepseek", data);
    const pageCount = Math.max(1, Math.ceil(providerNavItems.value.length / providerPageSize));
    providerPage.value = Math.min(providerPage.value, pageCount);
    ElMessage.success("服务商已删除");
  } catch (error) {
    const action = typeof error === "string" ? error : error?.message;
    if (action === "cancel" || action === "close") return;
    ElMessage.error(error.message || "删除服务商失败");
  }
}

function isCustomProviderKey(provider) {
  return String(provider || "") === "custom" || String(provider || "").startsWith("custom_");
}

function normalizeRoutes(value, fallback) {
  return {
    text: normalizeRoute(value.text, fallback, "text"),
    vision: normalizeRoute(value.vision, fallback, "vision"),
    image: normalizeRoute(value.image, fallback, "image"),
    video: normalizeRoute(value.video, fallback, "video")
  };
}

function normalizeRoute(route, fallback, type) {
  const provider = route?.provider || (type === "text" ? fallback?.provider : "");
  const model = route?.model || fallback?.[`${type}Model`] || "";
  return { provider, model };
}

function defaultModels(provider) {
  if (provider === "deepseek") return { textModel: "deepseek-v4-flash", visionModel: "", imageModel: "", videoModel: "" };
  if (provider === "kimi") return { textModel: "moonshot-v1-8k", visionModel: "", imageModel: "", videoModel: "" };
  if (provider === "openai") return { textModel: "gpt-4.1-mini", visionModel: "gpt-4.1-mini", imageModel: "gpt-image-1", videoModel: "" };
  if (provider === "cctq-image2") return { textModel: "", visionModel: "", imageModel: "gpt-image-2", videoModel: "" };
  if (provider === "change2pro-image2") return { textModel: "", visionModel: "", imageModel: "gpt-image-2", videoModel: "" };
  return { textModel: "", visionModel: "", imageModel: "", videoModel: "" };
}

function defaultApiMode(provider) {
  if (provider === "change2pro-image2") return "images";
  return "chat_completions";
}

function applyImageProviderPool(pool = {}) {
  imageProviderPool.enabled = Boolean(pool.enabled);
  imageProviderPool.mode = pool.mode || "speed";
  imageProviderPool.maxConcurrency = Number(pool.maxConcurrency || pool.max_concurrency || 20);
  imageProviderPool.channels.splice(
    0,
    imageProviderPool.channels.length,
    ...((Array.isArray(pool.channels) ? pool.channels : []).map(normalizeImagePoolChannel))
  );
}

function normalizeImageProviderPoolDisplay() {
  imageProviderPool.channels.forEach((channel) => {
    const provider = channel.provider || "custom";
    channel.baseUrl = normalizeProviderBaseUrl(provider, channel.baseUrl, channel.name);
    channel.imageModel = normalizeProviderImageModel(provider, channel.imageModel, channel.baseUrl, channel.name);
    channel.apiMode = normalizeProviderApiMode(provider, channel.apiMode, channel.baseUrl, channel.name);
  });
}

function normalizeUiConcurrency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function imageProviderPoolPayload() {
  normalizeImageProviderPoolDisplay();
  return {
    enabled: imageProviderPool.enabled,
    mode: imageProviderPool.mode,
    maxConcurrency: imageProviderPool.maxConcurrency,
    channels: imageProviderPool.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      clearApiKey: channel.clearApiKey,
      usageApiKey: channel.usageApiKey,
      clearUsageApiKey: channel.clearUsageApiKey,
      imageModel: channel.imageModel,
      apiMode: channel.apiMode,
      enabled: channel.enabled,
      weight: channel.weight,
      maxConcurrency: channel.maxConcurrency
    }))
  };
}

function addCurrentProviderAsImageChannel() {
  imageProviderPool.channels.push(normalizeImagePoolChannel({
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: `${form.name || providerLabel(form.provider)} 生图通道`,
    provider: form.provider,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    imageModel: form.imageModel,
    apiMode: form.apiMode,
    enabled: true,
    weight: 1,
    maxConcurrency: 20
  }));
  imageProviderPool.enabled = true;
  ElMessage.success(form.apiKey ? "已复制到图片通道池，保存后生效" : "已新增通道，请在通道里填写 API Key 后保存");
}

function removeImagePoolChannel(index) {
  imageProviderPool.channels.splice(index, 1);
}

function normalizeImagePoolChannel(channel = {}) {
  const provider = channel.provider || "cctq-image2";
  const defaults = defaultModels(provider);
  return {
    id: channel.id || `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: channel.name || "图片通道",
    provider,
    baseUrl: normalizeProviderBaseUrl(provider, channel.baseUrl || providerTips[provider]?.baseUrl || "", channel.name),
    apiKey: channel.apiKey || "",
    clearApiKey: false,
    hasApiKey: Boolean(channel.hasApiKey),
    apiKeyHint: channel.apiKeyHint || "",
    usageApiKey: "",
    clearUsageApiKey: false,
    hasUsageApiKey: Boolean(channel.hasUsageApiKey),
    usageApiKeyHint: channel.usageApiKeyHint || "",
    imageModel: normalizeProviderImageModel(provider, channel.imageModel || defaults.imageModel || "", channel.baseUrl, channel.name),
    apiMode: normalizeProviderApiMode(provider, channel.apiMode || defaultApiMode(provider), channel.baseUrl, channel.name),
    enabled: channel.enabled !== false,
    weight: Number(channel.weight || 1),
    maxConcurrency: Number(channel.maxConcurrency || channel.max_concurrency || 20)
  };
}

function applyImageChannelProvider(channel) {
  const provider = channel.provider || "custom";
  const defaults = defaultModels(provider);
  channel.name = channel.name || providerDisplayName(provider);
  channel.baseUrl = provider === "custom" ? "" : normalizeProviderBaseUrl(provider, providerTips[provider]?.baseUrl || channel.baseUrl, channel.name);
  channel.imageModel = normalizeProviderImageModel(provider, defaults.imageModel || channel.imageModel || "", channel.baseUrl, channel.name);
  channel.apiMode = normalizeProviderApiMode(provider, defaultApiMode(provider), channel.baseUrl, channel.name);
}

function normalizeProviderApiMode(provider, value, baseUrl = "", name = "") {
  if (isChange2ProImageProvider(provider, baseUrl, name)) return "images";
  return value || "chat_completions";
}

function normalizeProviderBaseUrl(provider, value, name = "") {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!isChange2ProImageProvider(provider, baseUrl, name)) return baseUrl;
  if (!baseUrl) return "https://api.change2pro.com";
  if (baseUrl.toLowerCase().endsWith("/v1")) return baseUrl.slice(0, -3);
  if (baseUrl.toLowerCase().endsWith("/responses")) return "https://api.change2pro.com";
  return baseUrl;
}

function normalizeProviderImageModel(provider, value, baseUrl = "", name = "") {
  const model = String(value || "").trim();
  if (!isChange2ProImageProvider(provider, baseUrl, name)) return model;
  if (!model || /^image2[_-]\d+$/i.test(model)) return "gpt-image-2";
  return model;
}

function isChange2ProImageProvider(provider, baseUrl = "", name = "") {
  const providerKey = String(provider || "").toLowerCase();
  const displayName = String(name || "").toLowerCase();
  return providerKey === "change2pro-image2"
    || ((providerKey.includes("change2pro") || displayName.includes("change2pro")) && /image[-_ ]?2/.test(`${providerKey} ${displayName}`));
}

function routeStatus(key) {
  const route = routes[key] || {};
  const provider = savedProviders.value[route.provider];
  return {
    ready: Boolean(route.provider && route.model && provider?.enabled && provider?.hasApiKey),
    provider,
    label: route.provider ? providerLabel(route.provider) : "未指定服务商"
  };
}

function providerLabel(value) {
  return providerDisplayName(value);
}

function providerDisplayName(value, channel = null) {
  const provider = String(value || "");
  const channelName = channel?.name || imageProviderPool.channels.find((item) => item.provider === provider)?.name || "";
  return savedProviders.value?.[provider]?.name
    || cleanChannelProviderName(channelName)
    || presetOptions.find((item) => item.value === provider)?.label
    || provider
    || "未选择";
}

function cleanChannelProviderName(value) {
  return String(value || "").replace(/\s*生图通道\s*$/u, "").trim();
}

function providerProfileFromImageChannel(provider) {
  const channel = imageProviderPool.channels.find((item) => item.provider === provider);
  if (!channel) return null;
  const name = cleanChannelProviderName(channel.name) || provider;
  return {
    provider,
    name,
    baseUrl: channel.baseUrl || "",
    textModel: "",
    visionModel: "",
    imageModel: channel.imageModel || "",
    videoModel: "",
    apiMode: channel.apiMode || defaultApiMode(provider),
    enabled: channel.enabled !== false,
    hasApiKey: Boolean(channel.hasApiKey),
    apiKeyHint: channel.apiKeyHint || ""
  };
}

function formatApiKeyHint(value) {
  const hint = String(value || "").trim();
  if (!hint) return "••••••••";
  const normalized = hint.replace(/\.{3,}/g, "••••••");
  if (normalized.includes("••••••")) return normalized;
  if (hint.length <= 8) return "••••••••";
  return `${hint.slice(0, 4)}••••••${hint.slice(-4)}`;
}
</script>

<template>
  <div v-loading="loading" class="ai-settings-workbench">
    <header class="workbench-topbar">
      <div>
        <h1>AI 配置工作台</h1>
        <p>左侧维护服务商账号，右侧指定系统在文本、视觉、生图、视频请求里分别使用哪个模型。</p>
      </div>
      <div class="topbar-actions">
        <div class="metric-chip">
          <span>{{ enabledProviderCount }}</span>
          <small>已启用服务商</small>
        </div>
        <div class="metric-chip">
          <span>{{ routeReadyCount }}/4</span>
          <small>全局模型就绪</small>
        </div>
        <div class="metric-chip">
          <span>{{ imageEffectiveConcurrency }}</span>
          <small>生效生图并发</small>
        </div>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadConfig">刷新</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="CircleCheck" :loading="saving" @click="saveConfig({ includeImageProviderPool: true })">保存配置</el-button>
      </div>
    </header>

    <section class="ai-config-board">
      <aside class="provider-panel workbench-card">
        <div class="panel-head">
          <div>
            <span>Provider</span>
            <h2>服务商配置</h2>
          </div>
          <el-tag :type="form.enabled ? 'success' : 'info'" effect="light">
            {{ form.enabled ? "已启用" : "未启用" }}
          </el-tag>
        </div>
        <el-alert
          type="info"
          :closable="false"
          title="这里是全局默认服务商；要新增多个生图账号，请添加到图片生成通道池。"
        />

        <div class="provider-switcher">
          <div class="provider-switcher-head">
            <strong>服务商账号</strong>
            <el-dropdown trigger="click" class="provider-add-menu" @command="handleAddProvider">
              <el-button class="erp-btn erp-btn-secondary" size="small">新增服务商</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="custom">新增自定义服务商</el-dropdown-item>
                  <el-dropdown-item v-for="item in deletedPresetOptions" :key="item.value" :command="item.value">
                    恢复 {{ item.label }} 预设
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <div
            v-for="item in pagedProviderNavItems"
            :key="item.value"
            class="provider-switch-item"
            :class="{ active: form.provider === item.value }"
          >
            <span class="provider-switch-status" :class="{ enabled: item.enabled }" />
            <button type="button" class="provider-switch-copy" @click="editProviderProfile(item.value)">
              <strong>{{ item.label }}</strong>
              <small>
                {{ item.hasApiKey ? "密钥已保存" : "未配置密钥" }} ·
                {{ item.modelCount ? `${item.modelCount} 个模型` : "未配置模型" }}
              </small>
            </button>
            <span class="provider-switch-actions">
              <el-button text type="primary" size="small" @click="editProviderProfile(item.value)">编辑</el-button>
              <el-button v-if="item.removable" text type="danger" size="small" @click="deleteProviderProfile(item)">删除</el-button>
              <el-tag v-else size="small" :type="item.enabled ? 'success' : 'info'">{{ item.enabled ? "启用" : "预设" }}</el-tag>
            </span>
          </div>
          <el-pagination
            v-if="providerNavItems.length > providerPageSize"
            v-model:current-page="providerPage"
            small
            background
            layout="prev, pager, next"
            :page-size="providerPageSize"
            :total="providerNavItems.length"
          />
        </div>

        <el-dialog v-model="providerDialogVisible" width="820px" class="provider-dialog" append-to-body align-center destroy-on-close>
          <template #header>
            <div class="provider-dialog-title">
              <div><span>Provider</span><h3>{{ form.name || selectedProviderLabel }}</h3></div>
              <el-tag :type="form.enabled ? 'success' : 'info'">{{ form.enabled ? "已启用" : "未启用" }}</el-tag>
            </div>
          </template>
          <el-form label-position="top" class="provider-form">
          <section class="provider-dialog-section">
            <div class="provider-dialog-section-head"><strong>基础接入</strong><span>账号、密钥和接口协议</span></div>
          <el-form-item label="服务商">
            <div class="provider-select-row">
              <el-select v-model="form.provider" class="full-control">
                <el-option v-for="item in providerOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item label="显示名称">
            <el-input v-model="form.name" placeholder="例如 DeepSeek / Kimi / OpenAI" />
          </el-form-item>

          <el-form-item class="span-2" label="API Key">
            <el-input v-model="form.apiKey" type="password" show-password :placeholder="apiKeyPlaceholder" />
            <div class="saved-key-row" :class="{ empty: !form.hasApiKey }">
              <span>{{ form.hasApiKey ? "密钥已保存" : "未保存密钥" }}</span>
              <code>{{ form.hasApiKey ? savedApiKeyDisplay : "保存后仅显示脱敏片段" }}</code>
            </div>
            <div class="field-tip">{{ currentTip.token }}</div>
          </el-form-item>

          <el-form-item v-if="form.hasApiKey" class="span-2 compact-danger-row" label="清空密钥">
            <el-checkbox v-model="form.clearApiKey">保存时删除 {{ selectedProviderLabel }} 已保存的 API Key</el-checkbox>
          </el-form-item>

          <el-form-item label="Base URL">
            <el-input v-model="form.baseUrl" />
            <div class="field-tip">{{ currentTip.baseUrl }}</div>
          </el-form-item>

          <el-form-item label="接口协议">
            <el-radio-group v-model="form.apiMode">
              <el-radio-button label="chat_completions">Chat Completions</el-radio-button>
              <el-radio-button label="images">Images API</el-radio-button>
              <el-radio-button label="responses">Responses API</el-radio-button>
              <el-radio-button label="tasks_65535">65535 Tasks API</el-radio-button>
            </el-radio-group>
            <div class="field-tip">图片服务商文档写 /v1/images 时请选择 Images API；文档写 wire_api = responses 时请选择 Responses API；新 65535 图片池请选择 65535 Tasks API。</div>
          </el-form-item>
          </section>

          <section class="provider-dialog-section">
            <div class="provider-dialog-section-head"><strong>模型能力</strong><span>只填写该服务商实际支持的模型</span></div>
            <div class="model-grid">
            <el-form-item label="文本模型">
              <el-input v-model="form.textModel" placeholder="例如 deepseek-v4-flash" />
            </el-form-item>
            <el-form-item label="视觉模型">
              <el-input v-model="form.visionModel" placeholder="可选，例如 gpt-4.1-mini" />
            </el-form-item>
            <el-form-item label="生图模型">
              <el-input v-model="form.imageModel" placeholder="可选，例如 gpt-image-1" />
            </el-form-item>
            <el-form-item label="视频模型">
              <el-input v-model="form.videoModel" placeholder="预留，服务商支持时填写" />
            </el-form-item>
            </div>
          </section>

          <section class="capability-test-panel">
            <div class="capability-test-head">
              <div><strong>模型能力测试</strong><span>分别验证真实请求，不再用一次连接代表全部模型</span></div>
              <small>生图测试可能产生费用</small>
            </div>
            <div class="capability-test-actions">
              <el-button
                v-for="item in routeCards"
                :key="item.key"
                class="erp-btn erp-btn-secondary"
                :loading="capabilityTestingKey === `provider:${item.key}`"
                :disabled="item.key !== 'video' && !providerModelFor(item.key)"
                @click="testCapability(item.key, 'provider')"
              >
                测试{{ item.key === "image" ? "生图" : item.key === "vision" ? "识图" : item.key === "video" ? "视频" : "文本" }}
              </el-button>
            </div>
            <el-alert
              v-if="capabilityResult?.scope === 'provider'"
              :type="capabilityResult.ok ? 'success' : capabilityResult.supported === false ? 'warning' : 'error'"
              :closable="false"
              show-icon
              :title="`${capabilityTypeLabel(capabilityResult.type)}${capabilityResult.ok ? '测试成功' : '测试未通过'}`"
              :description="[
                capabilityResult.provider ? `服务商：${capabilityResult.provider}` : '',
                capabilityResult.model ? `模型：${capabilityResult.model}` : '',
                capabilityResult.apiMode ? `协议：${capabilityResult.apiMode}` : '',
                Number.isFinite(capabilityResult.elapsedMs) ? `耗时：${capabilityResult.elapsedMs} ms` : '',
                capabilityResult.reply || capabilityResult.message || '',
                capabilityResult.bytes ? `图片大小：${capabilityResult.bytes} bytes` : ''
              ].filter(Boolean).join('；')"
            />
          </section>

          <div class="provider-state-card">
            <div>
              <span>启用状态</span>
              <strong>{{ form.enabled ? "系统可调用该服务商" : "仅保存配置，暂不调用" }}</strong>
            </div>
            <el-switch v-model="form.enabled" />
          </div>
          </el-form>
          <template #footer>
          <div class="panel-actions">
            <el-button class="erp-btn erp-btn-secondary" @click="addCurrentProviderAsImageChannel">添加到图片通道池</el-button>
            <el-button
              class="erp-btn erp-btn-secondary"
              v-if="!form.enabled"
              type="success"
              plain
              :icon="SwitchButton"
              :disabled="!form.hasApiKey && !form.apiKey"
              :loading="saving"
              @click="setEnabledAndSave(true)"
            >
              启用并保存
            </el-button>
            <el-button
              class="erp-btn erp-btn-secondary"
              v-else
              type="warning"
              plain
              :icon="SwitchButton"
              :loading="saving"
              @click="setEnabledAndSave(false)"
            >
              停用并保存
            </el-button>
            <el-button class="erp-btn erp-btn-primary" type="primary" :loading="saving" @click="saveConfig({ includeImageProviderPool: false, closeProviderDialog: true })">保存服务商</el-button>
          </div>
          </template>
        </el-dialog>
      </aside>

      <main class="route-panel">
        <nav class="workspace-tabs" aria-label="AI 配置区域">
          <button type="button" :class="{ active: workspaceTab === 'routing' }" @click="workspaceTab = 'routing'">
            <span>模型路由</span>
            <small>文本、视觉、生图、视频</small>
          </button>
          <button type="button" :class="{ active: workspaceTab === 'image-pool' }" @click="workspaceTab = 'image-pool'">
            <span>图片通道池</span>
            <small>{{ imageChannelCount }} 个启用通道 · 并发 {{ imageEffectiveConcurrency }}</small>
          </button>
        </nav>

        <section v-if="workspaceTab === 'routing'" class="workbench-card route-card">
          <div class="panel-head">
            <div>
              <span>Routing</span>
              <h2>全局模型路由</h2>
            </div>
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="MagicStick" :loading="saving" @click="saveConfig({ includeImageProviderPool: false })">保存路由</el-button>
          </div>

          <div class="route-grid">
            <article v-for="item in routeCards" :key="item.key" class="route-item" :class="{ ready: routeStatus(item.key).ready }">
              <div class="route-title">
                <div>
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.desc }}</span>
                </div>
                <el-tag :type="routeStatus(item.key).ready ? 'success' : 'warning'" effect="light">
                  {{ routeStatus(item.key).ready ? "可用" : "待完善" }}
                </el-tag>
              </div>

              <div class="route-controls">
                <el-select v-model="routes[item.key].provider" placeholder="选择服务商">
                  <el-option v-for="option in providerOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
                <el-input v-model="routes[item.key].model" placeholder="填写模型名 / endpoint id" />
              </div>

              <div class="route-foot">
                <span v-if="routeStatus(item.key).provider?.hasApiKey">
                  密钥：{{ formatApiKeyHint(routeStatus(item.key).provider.apiKeyHint) }}
                </span>
                <span v-else-if="routes[item.key].provider">
                  该服务商未保存密钥
                </span>
                <span v-else>
                  {{ item.desc }}
                </span>
                <em>{{ routeStatus(item.key).ready ? "系统调用已就绪" : "保存服务商密钥后可用" }}</em>
                <el-button
                  text
                  type="primary"
                  size="small"
                  :disabled="!routes[item.key].provider || !routes[item.key].model"
                  :loading="capabilityTestingKey === `route:${item.key}`"
                  @click="testCapability(item.key, 'route')"
                >测试</el-button>
              </div>
            </article>
          </div>
          <el-alert
            v-if="capabilityResult?.scope === 'route'"
            :type="capabilityResult.ok ? 'success' : capabilityResult.supported === false ? 'warning' : 'error'"
            :closable="false"
            show-icon
            :title="`${capabilityTypeLabel(capabilityResult.type)}路由${capabilityResult.ok ? '测试成功' : '测试未通过'}`"
            :description="[
              capabilityResult.provider ? `服务商：${capabilityResult.provider}` : '',
              capabilityResult.model ? `模型：${capabilityResult.model}` : '',
              Number.isFinite(capabilityResult.elapsedMs) ? `耗时：${capabilityResult.elapsedMs} ms` : '',
              capabilityResult.reply || capabilityResult.message || ''
            ].filter(Boolean).join('；')"
          />
        </section>

        <section v-else class="workbench-card image-pool-card">
          <div class="panel-head">
            <div>
              <span>Image Pool</span>
              <h2>图片生成通道池</h2>
            </div>
            <div class="pool-actions">
              <el-switch v-model="imageProviderPool.enabled" active-text="启用" inactive-text="停用" />
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="saving" @click="saveConfig({ includeImageProviderPool: true })">保存通道池</el-button>
            </div>
          </div>
          <el-alert
            type="success"
            :closable="false"
            title="这里才是新增多个生图 AI 渠道的位置；每个通道都可以填不同 API Key，批量生图会自动分发。"
          />

          <div class="pool-toolbar">
            <el-form-item label="分发模式">
              <el-select v-model="imageProviderPool.mode">
                <el-option label="速度优先" value="speed" />
                <el-option label="稳定优先" value="stable" />
                <el-option label="成本优先" value="cost" />
              </el-select>
            </el-form-item>
            <el-form-item label="总并发">
              <el-input-number v-model="imageProviderPool.maxConcurrency" :min="1" controls-position="right" />
            </el-form-item>
          </div>
          <div class="pool-stats">
            <span>启用通道 {{ imageChannelCount }} 个</span>
            <span>通道容量合计 {{ imageChannelCapacity }}</span>
            <strong>实际生效并发 {{ imageEffectiveConcurrency }}</strong>
          </div>

          <div v-if="imageProviderPool.channels.length" class="image-channel-list">
            <article v-for="(channel, index) in imageProviderPool.channels" :key="channel.id" class="image-channel-item">
              <div class="channel-head">
                <el-input v-model="channel.name" placeholder="通道名称" />
                <el-switch v-model="channel.enabled" />
                <el-button text type="primary" :loading="testingImageChannelId === channel.id" @click="testImagePoolChannel(channel)">测试生图</el-button>
                <el-button v-if="channel.apiMode === 'tasks_65535'" text type="primary" :loading="checkingImageUsageChannelId === channel.id" @click="loadImageChannelUsage(channel)">余额/用量</el-button>
                <el-button v-if="channel.apiMode === 'tasks_65535'" text type="success" tag="a" href="https://my.65535.space/" target="_blank" rel="noopener noreferrer">前往充值</el-button>
                <el-button text type="danger" @click="removeImagePoolChannel(index)">删除</el-button>
              </div>
              <div class="channel-grid">
                <el-form-item label="服务商">
                  <el-select v-model="channel.provider" @change="applyImageChannelProvider(channel)">
                    <el-option
                      v-for="option in providerOptions"
                      :key="option.value"
                      :label="providerDisplayName(option.value, channel.provider === option.value ? channel : null)"
                      :value="option.value"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="Base URL">
                  <el-input v-model="channel.baseUrl" />
                </el-form-item>
                <el-form-item label="图片模型">
                  <el-input v-model="channel.imageModel" placeholder="例如 gpt-image-2" />
                </el-form-item>
                <el-form-item label="接口协议">
                  <el-select v-model="channel.apiMode">
                    <el-option label="Chat Completions" value="chat_completions" />
                    <el-option label="Images API" value="images" />
                    <el-option label="Responses API" value="responses" />
                    <el-option label="65535 Tasks API" value="tasks_65535" />
                  </el-select>
                </el-form-item>
                <el-form-item label="API Key">
                  <el-input v-model="channel.apiKey" type="password" show-password :placeholder="channel.hasApiKey ? '留空保持已保存密钥' : '填写该通道 API Key'" />
                  <div class="saved-key-row" :class="{ empty: !channel.hasApiKey }">
                    <span>{{ channel.hasApiKey ? "密钥已保存" : "未保存密钥" }}</span>
                    <code>{{ channel.hasApiKey ? formatApiKeyHint(channel.apiKeyHint) : "保存后脱敏显示" }}</code>
                  </div>
                  <el-checkbox v-if="channel.hasApiKey" v-model="channel.clearApiKey">保存时清空该通道密钥</el-checkbox>
                </el-form-item>
                <el-form-item v-if="channel.apiMode === 'tasks_65535'" label="余额查询 Key">
                  <el-input v-model="channel.usageApiKey" type="password" show-password :placeholder="channel.hasUsageApiKey ? '留空保持已保存的查询 Key' : '可选：填写非任务专用分组 Key'" />
                  <div class="saved-key-row" :class="{ empty: !channel.hasUsageApiKey }">
                    <span>{{ channel.hasUsageApiKey ? "查询 Key 已保存" : "未单独配置时复用生图 Key" }}</span>
                    <code v-if="channel.hasUsageApiKey">{{ formatApiKeyHint(channel.usageApiKeyHint) }}</code>
                  </div>
                  <el-checkbox v-if="channel.hasUsageApiKey" v-model="channel.clearUsageApiKey">保存时清空余额查询 Key</el-checkbox>
                </el-form-item>
                <el-form-item label="权重 / 单通道并发">
                  <div class="channel-number-row">
                    <el-input-number v-model="channel.weight" :min="1" :max="20" controls-position="right" />
                    <el-input-number v-model="channel.maxConcurrency" :min="1" controls-position="right" />
                  </div>
                </el-form-item>
              </div>
              <div v-if="imageUsageResults[channel.id]" class="channel-usage" :class="{ danger: imageUsageResults[channel.id].balance !== null && imageUsageResults[channel.id].balance <= 0, warning: imageUsageResults[channel.id].balance > 0 && imageUsageResults[channel.id].balance <= 1 }">
                <template v-if="imageUsageResults[channel.id].ok && imageUsageResults[channel.id].supported">
                  <strong>余额 {{ formatUsageAmount(imageUsageResults[channel.id].balance, imageUsageResults[channel.id].unit) }}</strong>
                  <span>今日消费 {{ formatUsageAmount(imageUsageResults[channel.id].todayCost, imageUsageResults[channel.id].unit) }}</span>
                  <span>今日请求 {{ imageUsageResults[channel.id].todayRequests ?? '—' }}</span>
                  <span>累计消费 {{ formatUsageAmount(imageUsageResults[channel.id].totalCost, imageUsageResults[channel.id].unit) }}</span>
                  <em v-if="imageUsageResults[channel.id].balance !== null && imageUsageResults[channel.id].balance <= 0">余额不足，可能导致生图失败</em>
                  <em v-else-if="imageUsageResults[channel.id].balance > 0 && imageUsageResults[channel.id].balance <= 1">余额偏低，建议尽快充值</em>
                </template>
                <span v-else>{{ imageUsageResults[channel.id].message }}</span>
              </div>
            </article>
          </div>
          <el-empty v-else description="还没有图片通道，新增后可让批量生图自动分发" />
        </section>

        <section class="workbench-card help-card">
          <div class="panel-head compact">
            <div>
              <span>Guide</span>
              <h2>接入规则</h2>
            </div>
          </div>
          <div class="help-grid">
            <p><span>API Key</span><strong>按服务商独立保存，切换服务商时只显示当前服务商的密钥状态。</strong></p>
            <p><span>Base URL</span><strong>填写 OpenAI 兼容根地址，不要带具体 endpoint。</strong></p>
            <p><span>全局路由</span><strong>系统按请求类型取模型：文本、视觉、生图、视频互不影响。</strong></p>
          </div>
          <el-alert
            v-if="imageTestResult"
            :type="imageTestResult.ok ? 'success' : 'error'"
            :closable="false"
            show-icon
            :title="`${imageTestResult.ok ? '生图通道可用' : '生图通道不可用'}：${imageTestResult.name || imageTestResult.provider || '当前通道'} / ${imageTestResult.imageModel || ''}`"
            :description="[
              imageTestResult.endpoint ? `请求地址：${imageTestResult.endpoint}` : '',
              imageTestResult.baseUrl ? `Base URL：${imageTestResult.baseUrl}` : '',
              imageTestResult.apiMode ? `协议：${imageTestResult.apiMode}` : '',
              imageTestResult.message ? `服务商返回：${imageTestResult.message}` : '',
              imageTestResult.bytes ? `返回图片大小：${imageTestResult.bytes} bytes` : ''
            ].filter(Boolean).join('；')"
          />
        </section>
      </main>
    </section>
  </div>
</template>

<style scoped>
.ai-settings-workbench {
  min-height: calc(100vh - 96px);
  padding: 16px 18px 24px;
  background:
    radial-gradient(circle at 12% 0%, rgba(64, 158, 255, 0.10), transparent 34%),
    linear-gradient(180deg, #f6f9ff 0%, #eef3f9 100%);
  color: #101828;
}

.workbench-topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: -16px -18px 14px;
  padding: 14px 18px 12px;
  background: rgba(246, 249, 255, 0.92);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.workbench-topbar h1 {
  margin: 0;
  font-size: 25px;
}

.workbench-topbar p {
  margin: 6px 0 0;
  color: #667085;
}

.topbar-actions,
.panel-actions,
.route-controls,
.route-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.metric-chip {
  display: grid;
  gap: 2px;
  min-width: 112px;
  padding: 7px 10px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #fff;
}

.metric-chip span {
  color: #0f172a;
  font-size: 16px;
  font-weight: 800;
}

.metric-chip small {
  color: #64748b;
  font-size: 12px;
}

.ai-config-board {
  display: grid;
  grid-template-columns: minmax(360px, 42%) minmax(0, 58%);
  gap: 16px;
  align-items: start;
  min-height: 640px;
}

.workbench-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 0;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.07);
}

.provider-panel {
  position: sticky;
  top: 84px;
  align-self: start;
  grid-template-rows: auto auto minmax(0, 1fr);
  height: 640px;
  overflow: hidden;
}

.route-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 14px;
  min-width: 0;
  height: 640px;
}

.route-card,
.image-pool-card { min-height: 0; overflow: auto; }

.provider-switcher {
  display: grid;
  grid-template-rows: 32px repeat(10, 36px) minmax(0, 1fr) 30px;
  gap: 4px;
  height: 100%;
  min-height: 0;
  padding: 10px;
  border: 1px solid #e4eaf3;
  border-radius: 14px;
  background: #f8fafc;
}

.provider-switcher-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 4px;
}

.provider-switcher-head strong { font-size: 13px; }
.provider-switcher-head span { color: #8492a6; font-size: 12px; }

.provider-switch-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: inherit;
  text-align: left;
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}

.provider-switch-item:hover { border-color: #cddafd; background: #fff; }
.provider-switch-item.active { border-color: #9fb6ff; background: #fff; box-shadow: 0 6px 18px rgba(79, 104, 230, 0.10); }
.provider-switch-status { width: 8px; height: 8px; border-radius: 50%; background: #c0c8d4; }
.provider-switch-status.enabled { background: #36b37e; box-shadow: 0 0 0 4px rgba(54, 179, 126, 0.12); }
.provider-switch-copy { display: grid; gap: 2px; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.provider-switch-copy strong,
.provider-switch-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-switch-copy strong { font-size: 12px; line-height: 1.15; }
.provider-switch-copy small { color: #7a8798; font-size: 10px; line-height: 1.15; }
.provider-switch-actions { display: flex; align-items: center; justify-content: flex-end; }
.provider-switch-actions :deep(.el-button) { height: 24px; padding: 2px 5px; }
.provider-switcher :deep(.el-pagination) { justify-content: center; height: 30px; padding: 0; }
.provider-switcher > :deep(.el-pagination) { grid-row: 13; align-self: center; }
.provider-add-menu :deep(.el-button) { height: 26px; padding: 4px 10px; }

.provider-dialog-title { display: flex; align-items: center; justify-content: space-between; padding-right: 28px; }
.provider-dialog-title span { color: #5570e8; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.provider-dialog-title h3 { margin: 2px 0 0; font-size: 20px; }
.provider-dialog :deep(.el-dialog__header) { padding: 18px 22px 14px; border-bottom: 1px solid #e8edf5; }
.provider-dialog :deep(.el-dialog__body) { max-height: calc(100vh - 220px); overflow-y: auto; padding: 16px 22px; background: #f6f8fc; }
.provider-dialog :deep(.el-dialog__footer) { padding: 12px 22px 16px; border-top: 1px solid #e8edf5; background: #fff; }
.provider-dialog :deep(.el-dialog__footer .panel-actions) { justify-content: flex-end; }

.provider-dialog-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; padding: 14px; border: 1px solid #e1e7f0; border-radius: 14px; background: #fff; }
.provider-dialog-section-head { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.provider-dialog-section-head strong { font-size: 14px; }
.provider-dialog-section-head span { color: #7a8798; font-size: 11px; }
.provider-dialog-section .saved-key-row,
.provider-dialog-section .field-tip { grid-column: 1 / -1; }
.provider-dialog-section .model-grid { grid-column: 1 / -1; width: 100%; }
.provider-dialog-section .span-2 { grid-column: 1 / -1; }
.provider-dialog-section .compact-danger-row { margin-top: -8px; }

.capability-test-panel { display: grid; gap: 10px; padding: 12px; border: 1px solid #dbe5ef; border-radius: 13px; background: #f8fbff; }
.capability-test-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.capability-test-head > div { display: grid; gap: 3px; }
.capability-test-head strong { font-size: 13px; }
.capability-test-head span,
.capability-test-head small { color: #7a8798; font-size: 11px; }
.capability-test-head small { color: #d97706; }
.capability-test-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }

.workspace-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 6px;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.workspace-tabs button {
  display: grid;
  gap: 3px;
  padding: 11px 14px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: #64748b;
  text-align: left;
  cursor: pointer;
}

.workspace-tabs button.active { background: #eef2ff; color: #3448c5; box-shadow: inset 0 0 0 1px #cbd5ff; }
.workspace-tabs span { font-size: 14px; font-weight: 800; }
.workspace-tabs small { color: #8492a6; font-size: 11px; }

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panel-head.compact {
  margin-bottom: -4px;
}

.panel-head span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
}

.panel-head h2 {
  margin: 3px 0 0;
  color: #0f172a;
  font-size: 20px;
}

.provider-form {
  display: grid;
  gap: 12px;
}

.full-control {
  width: 100%;
}

.provider-select-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.provider-select-row .el-button {
  flex: 0 0 auto;
}

.saved-key-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: 100%;
  margin-top: 8px;
  padding: 5px 8px;
  border-radius: 8px;
  background: #eefaf2;
  color: #15803d;
  font-size: 12px;
}

.saved-key-row.empty {
  background: #f8fbff;
  color: #64748b;
}

.saved-key-row code {
  overflow: hidden;
  color: #334155;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-tip {
  margin-top: 6px;
  color: #667085;
  font-size: 12px;
  line-height: 1.5;
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 12px;
}

.provider-state-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 2px 0 6px;
  padding: 11px 12px;
  border: 1px solid #dbe5ef;
  border-radius: 12px;
  background: #f8fbff;
}

.provider-state-card div {
  display: grid;
  gap: 4px;
}

.provider-state-card span,
.route-foot,
.help-grid span {
  color: #667085;
  font-size: 12px;
}

.provider-state-card strong {
  color: #0f172a;
  font-size: 13px;
}

.panel-actions {
  justify-content: flex-end;
  padding-top: 2px;
}

.route-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.route-item {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 13px;
  border: 1px solid #dbe5ef;
  border-radius: 14px;
  background: #f8fbff;
}

.route-item.ready {
  border-color: #b7e4c4;
  background: #f7fcf8;
}

.route-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.route-title div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.route-title strong {
  color: #101828;
  font-size: 15px;
}

.route-title span {
  color: #667085;
  font-size: 12px;
  line-height: 1.45;
}

.route-controls {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) minmax(160px, 1.3fr);
}

.route-foot {
  justify-content: space-between;
  min-width: 0;
  min-height: 24px;
}

.route-foot em {
  color: #344054;
  font-style: normal;
}

.route-foot span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.help-card {
  align-content: start;
  min-height: 190px;
}

.pool-actions,
.pool-toolbar,
.channel-head,
.channel-number-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pool-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.pool-toolbar {
  align-items: flex-end;
  padding: 10px 12px 0;
  border: 1px solid #dbe5ef;
  border-radius: 12px;
  background: #f8fbff;
}

.pool-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 12px 4px;
  color: #667085;
  font-size: 12px;
}

.pool-stats strong {
  color: #344054;
}

.image-channel-list {
  display: grid;
  gap: 12px;
}

.image-channel-item {
  display: grid;
  gap: 12px;
  padding: 13px;
  border: 1px solid #dbe5ef;
  border-radius: 14px;
  background: #ffffff;
}

.channel-head {
  justify-content: space-between;
}

.channel-head .el-input {
  max-width: 260px;
}

.channel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 12px;
}

.channel-usage {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 12px;
  border-radius: 10px;
  color: #344054;
  background: #f0f9ff;
  font-size: 13px;
}

.channel-usage.warning { background: #fffaeb; }
.channel-usage.danger { background: #fef3f2; }
.channel-usage em { color: #b42318; font-style: normal; font-weight: 600; }

.channel-number-row {
  width: 100%;
}

.help-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.help-grid p {
  display: grid;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 10px;
  border-radius: 12px;
  background: #f8fbff;
}

.help-grid strong {
  color: #344054;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

:deep(.el-form-item) {
  margin-bottom: 14px;
}

:deep(.el-form-item__label) {
  color: #344054;
  font-weight: 600;
}

@media (max-width: 1280px) {
  .ai-config-board,
  .route-grid,
  .help-grid {
    grid-template-columns: 1fr;
  }

  .provider-panel {
    position: static;
  }
}

@media (max-width: 760px) {
  .workbench-topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .model-grid,
  .route-controls {
    grid-template-columns: 1fr;
  }

  .panel-actions,
  .topbar-actions {
    justify-content: flex-start;
  }
}
</style>

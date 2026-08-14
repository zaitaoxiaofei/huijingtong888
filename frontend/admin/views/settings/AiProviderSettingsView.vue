<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { CircleCheck, Connection, MagicStick, Refresh, SwitchButton } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const testingImageChannelId = ref("");
const testResult = ref(null);
const imageTestResult = ref(null);
const configUpdatedAt = ref("");

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
  const options = presetOptions.map((option) => ({
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
  testResult.value = null;
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
    Object.assign(routes, normalizeRoutes(data.routes || {}, data));
    applyImageProviderPool(data.imageProviderPool || {});
    applyConfigToForm(data.provider || form.provider, data);
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

async function testConnection() {
  testing.value = true;
  testResult.value = null;
  try {
    const data = await apiClient.post("/api/ai-provider/test", {
      provider: form.provider,
      apiKey: form.apiKey,
      baseUrl: form.baseUrl,
      textModel: form.textModel,
      visionModel: form.visionModel,
      imageModel: form.imageModel,
      videoModel: form.videoModel,
      apiMode: form.apiMode
    });
    testResult.value = data;
    ElMessage.success("AI 连接测试成功");
  } catch (error) {
    ElMessage.error(error.message || "AI 连接测试失败");
  } finally {
    testing.value = false;
  }
}

async function testCurrentImageProvider() {
  testingImageChannelId.value = "__current__";
  imageTestResult.value = null;
  try {
    const data = await apiClient.post("/api/ai-provider/test-image-channel", {
      provider: form.provider,
      name: form.name,
      apiKey: form.apiKey,
      baseUrl: form.baseUrl,
      imageModel: form.imageModel,
      apiMode: form.apiMode,
      mode: "generate"
    });
    imageTestResult.value = { ...data, scope: "current" };
    data.ok ? ElMessage.success("生图通道测试成功") : ElMessage.error(data.message || "生图通道测试失败");
  } catch (error) {
    imageTestResult.value = { ok: false, scope: "current", message: error.message || "生图通道测试失败" };
    ElMessage.error(error.message || "生图通道测试失败");
  } finally {
    testingImageChannelId.value = "";
  }
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
      imageModel: channel.imageModel,
      apiMode: channel.apiMode,
      enabled: channel.enabled,
      weight: channel.weight,
      maxConcurrency: channel.maxConcurrency
    }))
  };
}

function addImagePoolChannel() {
  addImagePoolChannelByProvider("cctq-image2");
}

function addImagePoolChannelByProvider(provider = "cctq-image2") {
  const defaults = defaultModels(provider);
  imageProviderPool.channels.push(normalizeImagePoolChannel({
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: `${providerLabel(provider)} ${imageProviderPool.channels.length + 1}`,
    provider,
    baseUrl: providerTips[provider]?.baseUrl || "",
    imageModel: defaults.imageModel || "",
    enabled: true,
    weight: 1,
    maxConcurrency: 20
  }));
  imageProviderPool.enabled = true;
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

        <el-form label-position="top" class="provider-form">
          <el-form-item label="服务商">
            <div class="provider-select-row">
              <el-select v-model="form.provider" class="full-control">
                <el-option v-for="item in providerOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <el-button class="erp-btn erp-btn-secondary" @click="createProviderProfile">新增自定义</el-button>
            </div>
          </el-form-item>

          <el-form-item label="显示名称">
            <el-input v-model="form.name" placeholder="例如 DeepSeek / Kimi / OpenAI" />
          </el-form-item>

          <el-form-item label="API Key">
            <el-input v-model="form.apiKey" type="password" show-password :placeholder="apiKeyPlaceholder" />
            <div class="saved-key-row" :class="{ empty: !form.hasApiKey }">
              <span>{{ form.hasApiKey ? "密钥已保存" : "未保存密钥" }}</span>
              <code>{{ form.hasApiKey ? savedApiKeyDisplay : "保存后仅显示脱敏片段" }}</code>
            </div>
            <div class="field-tip">{{ currentTip.token }}</div>
          </el-form-item>

          <el-form-item v-if="form.hasApiKey" label="清空密钥">
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
            </el-radio-group>
            <div class="field-tip">图片服务商文档写 /v1/images 时请选择 Images API；文档写 wire_api = responses 时请选择 Responses API。</div>
          </el-form-item>

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

          <div class="provider-state-card">
            <div>
              <span>启用状态</span>
              <strong>{{ form.enabled ? "系统可调用该服务商" : "仅保存配置，暂不调用" }}</strong>
            </div>
            <el-switch v-model="form.enabled" />
          </div>

          <div class="panel-actions">
            <el-button class="erp-btn erp-btn-secondary" :icon="Connection" :loading="testing" @click="testConnection">测试连接</el-button>
            <el-button class="erp-btn erp-btn-secondary" :loading="testingImageChannelId === '__current__'" @click="testCurrentImageProvider">测试生图</el-button>
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
          </div>
        </el-form>
      </aside>

      <main class="route-panel">
        <section class="workbench-card route-card">
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
              </div>
            </article>
          </div>
        </section>

        <section class="workbench-card image-pool-card">
          <div class="panel-head">
            <div>
              <span>Image Pool</span>
              <h2>图片生成通道池</h2>
            </div>
            <div class="pool-actions">
              <el-switch v-model="imageProviderPool.enabled" active-text="启用" inactive-text="停用" />
              <el-button class="erp-btn erp-btn-secondary" @click="addImagePoolChannelByProvider('cctq-image2')">新增 CCTQ</el-button>
              <el-button class="erp-btn erp-btn-secondary" @click="addImagePoolChannelByProvider('change2pro-image2')">新增 Change2Pro</el-button>
              <el-button class="erp-btn erp-btn-secondary" @click="addCurrentProviderAsImageChannel">复制左侧配置</el-button>
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
                <el-form-item label="权重 / 单通道并发">
                  <div class="channel-number-row">
                    <el-input-number v-model="channel.weight" :min="1" :max="20" controls-position="right" />
                    <el-input-number v-model="channel.maxConcurrency" :min="1" controls-position="right" />
                  </div>
                </el-form-item>
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
            v-if="testResult"
            type="success"
            :closable="false"
            show-icon
            :title="`连接成功：${testResult.provider} / ${testResult.model}`"
            :description="testResult.reply"
          />
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
  min-height: 100%;
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
  align-items: stretch;
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
}

.route-panel {
  display: grid;
  grid-template-rows: auto auto minmax(190px, 1fr);
  gap: 14px;
  min-width: 0;
  min-height: 100%;
}

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
  gap: 2px;
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

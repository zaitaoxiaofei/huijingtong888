<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { CircleCheck, Connection, MagicStick, Refresh, SwitchButton } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);

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

const presetOptions = [
  { label: "DeepSeek", value: "deepseek" },
  { label: "Kimi", value: "kimi" },
  { label: "豆包", value: "doubao" },
  { label: "OpenAI", value: "openai" },
  { label: "CCTQ-image2", value: "cctq-image2" },
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

watch(() => form.provider, (provider) => {
  if (loading.value) return;
  applyProviderToForm(provider);
});

onMounted(loadConfig);

async function loadConfig() {
  loading.value = true;
  try {
    const data = await apiClient.get("/api/ai-provider/config", { noCache: true });
    savedProviders.value = data.providers || {};
    Object.assign(routes, normalizeRoutes(data.routes || data.globalRoutes || {}, data));
    applyConfigToForm(data.provider || "deepseek", data);
  } catch (error) {
    ElMessage.error(error.message || "AI 配置加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  testResult.value = null;
  try {
    const data = await apiClient.post("/api/ai-provider/config", {
      provider: form.provider,
      name: form.name,
      apiKey: form.apiKey,
      clearApiKey: form.clearApiKey,
      baseUrl: form.baseUrl,
      textModel: form.textModel,
      visionModel: form.visionModel,
      imageModel: form.imageModel,
      videoModel: form.videoModel,
      enabled: form.enabled,
      routes
    });
    savedProviders.value = data.providers || {};
    Object.assign(routes, normalizeRoutes(data.routes || {}, data));
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
  await saveConfig();
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
      videoModel: form.videoModel
    });
    testResult.value = data;
    ElMessage.success("AI 连接测试成功");
  } catch (error) {
    ElMessage.error(error.message || "AI 连接测试失败");
  } finally {
    testing.value = false;
  }
}

function applyConfigToForm(provider, data) {
  const providers = data.providers || savedProviders.value || {};
  savedProviders.value = providers;
  const selected = providers[provider] || data || {};
  Object.assign(form, {
    provider,
    name: selected.name || providerLabel(provider),
    apiKey: "",
    clearApiKey: false,
    baseUrl: selected.baseUrl || providerTips[provider]?.baseUrl || "",
    textModel: selected.textModel || "",
    visionModel: selected.visionModel || "",
    imageModel: selected.imageModel || "",
    videoModel: selected.videoModel || "",
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
  const tip = providerTips[provider] || providerTips.custom;
  const defaults = defaultModels(provider);
  Object.assign(form, {
    name: providerLabel(provider),
    apiKey: "",
    clearApiKey: false,
    baseUrl: provider === "custom" ? "" : tip.baseUrl,
    textModel: defaults.textModel,
    visionModel: defaults.visionModel,
    imageModel: defaults.imageModel,
    videoModel: defaults.videoModel,
    enabled: false,
    hasApiKey: false,
    apiKeyHint: ""
  });
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
  return { textModel: "", visionModel: "", imageModel: "", videoModel: "" };
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
  return presetOptions.find((item) => item.value === value)?.label || value || "未选择";
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
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadConfig">刷新</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="CircleCheck" :loading="saving" @click="saveConfig">保存配置</el-button>
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

        <el-form label-position="top" class="provider-form">
          <el-form-item label="服务商">
            <el-select v-model="form.provider" class="full-control">
              <el-option v-for="item in presetOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
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
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="MagicStick" :loading="saving" @click="saveConfig">保存路由</el-button>
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
                  <el-option v-for="option in presetOptions" :key="option.value" :label="option.label" :value="option.value" />
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
  grid-template-rows: auto minmax(190px, 1fr);
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

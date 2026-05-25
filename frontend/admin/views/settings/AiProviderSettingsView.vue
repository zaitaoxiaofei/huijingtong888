<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
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
  imageModel: "",
  enabled: false,
  hasApiKey: false,
  apiKeyHint: ""
});

const presetOptions = [
  { label: "DeepSeek", value: "deepseek" },
  { label: "Kimi", value: "kimi" },
  { label: "豆包", value: "doubao" },
  { label: "OpenAI", value: "openai" },
  { label: "自定义兼容接口", value: "custom" }
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
    model: "常用文本模型：gpt-4.1-mini；图片模型可填 gpt-image-1。"
  },
  custom: {
    token: "填写服务商提供的 Bearer Token 或 API Key。",
    baseUrl: "填写兼容 OpenAI Chat Completions 的根地址，不要带 /chat/completions。",
    model: "填写服务商文档里的模型名或 endpoint id。"
  }
};

const currentTip = computed(() => providerTips[form.provider] || providerTips.custom);
const apiKeyPlaceholder = computed(() => (
  form.hasApiKey
    ? `已保存：${form.apiKeyHint || "******"}，留空表示不修改`
    : "请输入 API Key，保存后只在后端加密存储"
));

watch(() => form.provider, (provider) => {
  if (loading.value) return;
  const tip = providerTips[provider] || providerTips.custom;
  if (provider !== "custom") {
    form.name = presetOptions.find((item) => item.value === provider)?.label || form.name;
    form.baseUrl = tip.baseUrl;
    if (provider === "deepseek") form.textModel = "deepseek-v4-flash";
    if (provider === "kimi") form.textModel = "moonshot-v1-8k";
    if (provider === "doubao") form.textModel = "";
    if (provider === "openai") {
      form.textModel = "gpt-4.1-mini";
      form.imageModel = "gpt-image-1";
    }
  }
});

onMounted(() => {
  loadConfig();
});

async function loadConfig() {
  loading.value = true;
  try {
    const data = await apiClient.get("/api/ai-provider/config", { noCache: true });
    Object.assign(form, {
      provider: data.provider || "deepseek",
      name: data.name || "DeepSeek",
      apiKey: "",
      clearApiKey: false,
      baseUrl: data.baseUrl || "https://api.deepseek.com",
      textModel: data.textModel || "deepseek-v4-flash",
      imageModel: data.imageModel || "",
      enabled: Boolean(data.enabled),
      hasApiKey: Boolean(data.hasApiKey),
      apiKeyHint: data.apiKeyHint || ""
    });
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
      imageModel: form.imageModel,
      enabled: form.enabled
    });
    Object.assign(form, {
      provider: data.provider || form.provider,
      name: data.name || form.name,
      baseUrl: data.baseUrl || form.baseUrl,
      textModel: data.textModel || form.textModel,
      imageModel: data.imageModel || "",
      enabled: Boolean(data.enabled),
      apiKey: "",
      clearApiKey: false,
      hasApiKey: Boolean(data.hasApiKey),
      apiKeyHint: data.apiKeyHint || ""
    });
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
      textModel: form.textModel
    });
    testResult.value = data;
    ElMessage.success("AI 连接测试成功");
  } catch (error) {
    ElMessage.error(error.message || "AI 连接测试失败");
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div v-loading="loading" class="ai-settings-page">
    <section class="settings-card">
      <div class="settings-heading">
        <div>
          <h1>AI 配置</h1>
          <p>这里保存统一的 AI 服务商配置，后续选品、文案、翻译、图片工具都可以通过后台接口复用。</p>
        </div>
        <div class="status-tags">
          <el-tag :type="form.hasApiKey ? 'success' : 'warning'" effect="light">
            {{ form.hasApiKey ? "密钥已保存" : "未保存密钥" }}
          </el-tag>
          <el-tag :type="form.enabled ? 'success' : 'info'" effect="light">
            {{ form.enabled ? "已启用" : "未启用" }}
          </el-tag>
        </div>
      </div>

      <el-alert
        class="saved-config-alert"
        :type="form.hasApiKey ? (form.enabled ? 'success' : 'warning') : 'info'"
        :closable="false"
        show-icon
        :title="form.hasApiKey ? `已保存 ${form.name || form.provider} 配置，API Key：${form.apiKeyHint || '******'}` : '当前还没有保存 API Key'"
        :description="form.hasApiKey && !form.enabled ? '密钥已经保存在后端，但启用开关还没打开；后续工具不会默认调用这个 AI，直到你开启并保存。' : '保存后页面不会显示密钥明文，只会显示掩码。'"
      />

      <el-form label-position="left" label-width="120px" class="ai-form">
        <el-form-item label="服务商">
          <el-select v-model="form.provider" style="width: 260px">
            <el-option v-for="item in presetOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="form.name" placeholder="例如 DeepSeek / Kimi / 豆包" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password :placeholder="apiKeyPlaceholder" />
          <div class="field-tip">{{ currentTip.token }}</div>
        </el-form-item>
        <el-form-item v-if="form.hasApiKey" label="清空密钥">
          <el-checkbox v-model="form.clearApiKey">保存时删除已保存的 API Key</el-checkbox>
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input v-model="form.baseUrl" />
          <div class="field-tip">{{ currentTip.baseUrl }}</div>
        </el-form-item>
        <el-form-item label="文本模型">
          <el-input v-model="form.textModel" placeholder="例如 deepseek-v4-flash" />
          <div class="field-tip">{{ currentTip.model }}</div>
        </el-form-item>
        <el-form-item label="图片模型">
          <el-input v-model="form.imageModel" placeholder="可选；服务商支持图片生成时再填写" />
        </el-form-item>
        <el-form-item label="启用状态">
          <div class="enabled-row">
            <el-switch v-model="form.enabled" />
            <el-tag :type="form.enabled ? 'success' : 'info'" effect="light">
              {{ form.enabled ? "保存后启用" : "保存后停用" }}
            </el-tag>
            <el-button
              v-if="!form.enabled"
              type="success"
              plain
              :disabled="!form.hasApiKey && !form.apiKey"
              :loading="saving"
              @click="setEnabledAndSave(true)"
            >
              启用并保存
            </el-button>
            <el-button
              v-else
              type="warning"
              plain
              :loading="saving"
              @click="setEnabledAndSave(false)"
            >
              停用并保存
            </el-button>
          </div>
        </el-form-item>
        <div class="form-actions">
          <el-button @click="loadConfig">刷新</el-button>
          <el-button :loading="testing" @click="testConnection">测试连接</el-button>
          <el-button type="primary" :loading="saving" @click="saveConfig">保存配置</el-button>
        </div>
      </el-form>
    </section>

    <section class="settings-card help-card">
      <h2>接入时你需要提供什么</h2>
      <div class="help-grid">
        <div>
          <strong>API Key</strong>
          <span>你购买 token 后，在服务商控制台创建的密钥。保存后后台加密存储，页面不会回显明文。</span>
        </div>
        <div>
          <strong>Base URL</strong>
          <span>OpenAI 兼容接口根地址。例如 DeepSeek 是 https://api.deepseek.com，Kimi 是 https://api.moonshot.ai/v1。</span>
        </div>
        <div>
          <strong>模型名</strong>
          <span>文本模型填具体模型名；豆包通常要填火山方舟控制台里的 endpoint id。</span>
        </div>
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
  </div>
</template>

<style scoped>
.ai-settings-page { display: flex; flex-direction: column; gap: 16px; }
.settings-card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 18px; }
.settings-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.settings-heading h1 { margin: 0 0 8px; font-size: 22px; }
.settings-heading p { margin: 0; color: var(--erp-text-secondary); line-height: 1.6; }
.status-tags { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.saved-config-alert { margin-bottom: 18px; }
.ai-form { max-width: 820px; }
.field-tip { margin-top: 6px; color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
.enabled-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.form-actions { display: flex; justify-content: flex-end; gap: 10px; padding-left: 120px; }
.help-card { display: flex; flex-direction: column; gap: 16px; }
.help-card h2 { margin: 0; font-size: 18px; }
.help-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.help-grid div { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 12px; background: var(--erp-surface-alt); }
.help-grid strong, .help-grid span { display: block; }
.help-grid strong { margin-bottom: 6px; }
.help-grid span { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.6; }
@media (max-width: 900px) {
  .settings-heading { flex-direction: column; }
  .status-tags { justify-content: flex-start; }
  .form-actions { padding-left: 0; flex-wrap: wrap; }
  .help-grid { grid-template-columns: 1fr; }
}
</style>

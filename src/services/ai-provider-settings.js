import crypto from "node:crypto";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const SETTING_KEY = "ai.provider";
const DEFAULT_PROVIDER_CONFIG = {
  provider: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  apiKeyEncrypted: "",
  apiKeyHint: "",
  textModel: "deepseek-v4-flash",
  imageModel: "",
  enabled: false
};

const PROVIDER_PRESETS = {
  deepseek: {
    provider: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    textModel: "deepseek-v4-flash",
    imageModel: ""
  },
  kimi: {
    provider: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    textModel: "moonshot-v1-8k",
    imageModel: ""
  },
  doubao: {
    provider: "doubao",
    name: "豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    textModel: "",
    imageModel: ""
  },
  openai: {
    provider: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    textModel: "gpt-4.1-mini",
    imageModel: "gpt-image-1"
  },
  custom: {
    provider: "custom",
    name: "自定义兼容接口",
    baseUrl: "",
    textModel: "",
    imageModel: ""
  }
};

export function aiProviderPresets() {
  return PROVIDER_PRESETS;
}

export async function aiProviderConfig() {
  await ensureSettingsTables();
  return sanitizeConfig(await readStoredConfig());
}

export async function updateAiProviderConfig(body = {}, personId = null) {
  await ensureSettingsTables();
  const previous = await readStoredConfig();
  const provider = normalizeProvider(body.provider || previous.provider);
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const apiKey = String(body.apiKey || "").trim();
  const clearApiKey = body.clearApiKey === true;
  const next = {
    ...DEFAULT_PROVIDER_CONFIG,
    ...previous,
    ...preset,
    provider,
    name: cleanText(body.name ?? previous.name ?? preset.name),
    baseUrl: normalizeBaseUrl(body.baseUrl ?? previous.baseUrl ?? preset.baseUrl),
    textModel: cleanText(body.textModel ?? previous.textModel ?? preset.textModel),
    imageModel: cleanText(body.imageModel ?? previous.imageModel ?? preset.imageModel),
    enabled: Boolean(body.enabled)
  };

  if (!next.baseUrl) throw new Error("AI Base URL 不能为空");
  if (!next.textModel) throw new Error("AI 文本模型不能为空");

  if (apiKey) {
    next.apiKeyEncrypted = encryptSecret(apiKey);
    next.apiKeyHint = maskSecret(apiKey);
  } else if (clearApiKey) {
    next.apiKeyEncrypted = "";
    next.apiKeyHint = "";
  }

  if (next.enabled && !next.apiKeyEncrypted) {
    throw statusError("Please save an AI API Key before enabling this provider", 400);
  }

  await writeStoredConfig(next, previous, personId);
  return sanitizeConfig(next);
}

export async function testAiProviderConfig(payload = {}) {
  const configToTest = await resolveRuntimeConfig(payload, { requireEnabled: false });
  const result = await callOpenAiCompatibleChat(configToTest, {
    messages: [
      { role: "system", content: "You are a connection test endpoint. Reply with a very short OK message in Chinese." },
      { role: "user", content: "请回复：AI 配置连接成功" }
    ],
    temperature: 0
  });
  return {
    ok: true,
    provider: configToTest.provider,
    model: configToTest.textModel,
    reply: result.content,
    usage: result.usage || null
  };
}

export async function chatWithAiProvider(payload = {}) {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true });
  const messages = normalizeMessages(payload.messages, payload.prompt);
  if (!messages.length) throw new Error("AI 调用内容不能为空");
  const result = await callOpenAiCompatibleChat(runtimeConfig, {
    messages,
    temperature: finiteNumber(payload.temperature, 0.2),
    maxTokens: finiteNumber(payload.maxTokens ?? payload.max_tokens, null)
  });
  return {
    provider: runtimeConfig.provider,
    model: runtimeConfig.textModel,
    content: result.content,
    usage: result.usage || null,
    raw: payload.includeRaw ? result.raw : undefined
  };
}

async function resolveRuntimeConfig(override = {}, options = {}) {
  const stored = await readStoredConfig();
  const apiKey = String(override.apiKey || "").trim() || decryptSecret(stored.apiKeyEncrypted);
  const requireEnabled = options.requireEnabled !== false;
  if (!requireEnabled && apiKey && !override.apiKey) override.apiKey = apiKey;
  const runtimeConfig = {
    ...stored,
    provider: normalizeProvider(override.provider || stored.provider),
    baseUrl: normalizeBaseUrl(override.baseUrl || stored.baseUrl),
    textModel: cleanText(override.textModel || stored.textModel),
    apiKey
  };
  if (!runtimeConfig.enabled && !override.apiKey) throw statusError("AI 服务尚未启用", 400);
  if (!runtimeConfig.baseUrl) throw statusError("AI Base URL 不能为空", 400);
  if (!runtimeConfig.textModel) throw statusError("AI 文本模型不能为空", 400);
  if (!runtimeConfig.apiKey) throw statusError("AI API Key 不能为空", 400);
  return runtimeConfig;
}

async function callOpenAiCompatibleChat(runtimeConfig, options = {}) {
  const endpoint = `${runtimeConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: runtimeConfig.textModel,
    messages: options.messages,
    temperature: options.temperature
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.apiKey}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw statusError(data?.error?.message || data?.message || `AI 接口请求失败：${response.status}`, response.status);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw statusError("AI 接口没有返回文本内容", 502);
    return { content, usage: data.usage, raw: data };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError("AI 接口请求超时", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readStoredConfig() {
  await ensureSettingsTables();
  const row = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [SETTING_KEY]).then((rows) => rows[0]);
  if (!row?.value_json) return { ...DEFAULT_PROVIDER_CONFIG };
  try {
    return { ...DEFAULT_PROVIDER_CONFIG, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_PROVIDER_CONFIG };
  }
}

async function writeStoredConfig(next, previous, personId = null) {
  await mysqlExecute(`
    INSERT INTO system_settings (\`key\`, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      value_json = VALUES(value_json),
      updated_at = CURRENT_TIMESTAMP
  `, [SETTING_KEY, JSON.stringify(next)]);
  await mysqlExecute(`
    INSERT INTO system_setting_changes (setting_key, old_value_json, new_value_json, updated_by_person_id)
    VALUES (?, ?, ?, ?)
  `, [
    SETTING_KEY,
    JSON.stringify(sanitizeConfig(previous)),
    JSON.stringify(sanitizeConfig(next)),
    personId ? Number(personId) : null
  ]);
}

function sanitizeConfig(value = {}) {
  return {
    provider: value.provider || DEFAULT_PROVIDER_CONFIG.provider,
    name: value.name || PROVIDER_PRESETS[value.provider]?.name || "",
    baseUrl: value.baseUrl || "",
    textModel: value.textModel || "",
    imageModel: value.imageModel || "",
    enabled: Boolean(value.enabled),
    hasApiKey: Boolean(value.apiKeyEncrypted),
    apiKeyHint: value.apiKeyHint || "",
    presets: PROVIDER_PRESETS
  };
}

function normalizeMessages(messages, prompt) {
  if (Array.isArray(messages)) {
    return messages
      .map((message) => ({
        role: ["system", "user", "assistant"].includes(message?.role) ? message.role : "user",
        content: cleanText(message?.content)
      }))
      .filter((message) => message.content);
  }
  const text = cleanText(prompt);
  return text ? [{ role: "user", content: text }] : [];
}

async function ensureSettingsTables() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS system_settings (
      \`key\` VARCHAR(191) PRIMARY KEY,
      value_json LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS system_setting_changes (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      setting_key VARCHAR(191) NOT NULL,
      old_value_json LONGTEXT NULL,
      new_value_json LONGTEXT NOT NULL,
      updated_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  const [version, iv, tag, encrypted] = text.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function encryptionKey() {
  const seed = process.env.AI_CONFIG_SECRET || config.siteAccessPassword || "ozon-erp-local-ai-config";
  return crypto.createHash("sha256").update(seed).digest();
}

function maskSecret(secret) {
  const text = String(secret || "");
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function normalizeProvider(value) {
  const provider = cleanText(value || "custom").toLowerCase();
  return PROVIDER_PRESETS[provider] ? provider : "custom";
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 2000);
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

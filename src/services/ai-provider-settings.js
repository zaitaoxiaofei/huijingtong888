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
  visionModel: "",
  imageModel: "",
  videoModel: "",
  enabled: false
};

const ROUTE_TYPES = ["text", "vision", "image", "video"];

const PROVIDER_PRESETS = {
  deepseek: {
    provider: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    textModel: "deepseek-v4-flash",
    visionModel: "",
    imageModel: ""
  },
  kimi: {
    provider: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    textModel: "moonshot-v1-8k",
    visionModel: "",
    imageModel: ""
  },
  doubao: {
    provider: "doubao",
    name: "豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    textModel: "",
    visionModel: "",
    imageModel: ""
  },
  openai: {
    provider: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    textModel: "gpt-4.1-mini",
    visionModel: "gpt-4.1-mini",
    imageModel: "gpt-image-1"
  },
  "cctq-image2": {
    provider: "cctq-image2",
    name: "CCTQ-image2",
    baseUrl: "https://www.cctq.ai/v1",
    textModel: "",
    visionModel: "",
    imageModel: "gpt-image-2"
  },
  custom: {
    provider: "custom",
    name: "自定义兼容接口",
    baseUrl: "",
    textModel: "",
    visionModel: "",
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
  const previousProvider = previous.providers[provider] || {};
  const apiKey = String(body.apiKey || "").trim();
  const clearApiKey = body.clearApiKey === true;
  const nextProvider = {
    ...DEFAULT_PROVIDER_CONFIG,
    ...previousProvider,
    ...preset,
    provider,
    name: cleanText(body.name ?? previousProvider.name ?? preset.name),
    baseUrl: normalizeBaseUrl(body.baseUrl ?? previousProvider.baseUrl ?? preset.baseUrl),
    textModel: cleanText(body.textModel ?? previousProvider.textModel ?? preset.textModel),
    visionModel: cleanText(body.visionModel ?? previousProvider.visionModel ?? preset.visionModel),
    imageModel: cleanText(body.imageModel ?? previousProvider.imageModel ?? preset.imageModel),
    videoModel: cleanText(body.videoModel ?? previousProvider.videoModel ?? preset.videoModel),
    enabled: Boolean(body.enabled)
  };

  if (!nextProvider.baseUrl) throw new Error("AI Base URL 不能为空");
  if (!hasAnyModel(nextProvider)) throw new Error("请至少填写一个 AI 模型");

  if (apiKey) {
    nextProvider.apiKeyEncrypted = encryptSecret(apiKey);
    nextProvider.apiKeyHint = maskSecret(apiKey);
  } else if (clearApiKey) {
    nextProvider.apiKeyEncrypted = "";
    nextProvider.apiKeyHint = "";
  }

  if (nextProvider.enabled && !nextProvider.apiKeyEncrypted) {
    throw statusError("Please save an AI API Key before enabling this provider", 400);
  }

  const next = {
    ...previous,
    provider,
    providers: {
      ...previous.providers,
      [provider]: nextProvider
    },
    routes: normalizeRoutes(body.routes || previous.routes, provider, nextProvider)
  };

  await writeStoredConfig(next, previous, personId);
  return sanitizeConfig(next);
}

export async function testAiProviderConfig(payload = {}) {
  const configToTest = await resolveRuntimeConfig(payload, { requireEnabled: false });
  if (configToTest.provider === "cctq-image2") {
    return testOpenAiCompatibleModels(configToTest);
  }
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
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "text" });
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

export async function generateSelectionSellingPoints(payload = {}) {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "text" });
  const context = buildSelectionSellingPointContext(payload);
  if (!context.hasUsefulInfo) {
    throw statusError("????????????????????????????", 400);
  }

  try {
    const result = await Promise.race([
      callOpenAiCompatibleChat(runtimeConfig, {
        messages: [
          {
            role: "system",
            content: [
              "?? Ozon ?????????",
              "????????????????????????",
              "??????????????????? Markdown??????",
              "????????????????????????????????????????????",
              "??????????"
            ].join("\n")
          },
          {
            role: "user",
            content: context.prompt
          }
        ],
        temperature: 0.2,
        maxTokens: 220,
        timeoutMs: 8_000
      }),
      new Promise((resolve) => setTimeout(() => resolve({ provider: runtimeConfig.provider, model: runtimeConfig.textModel, content: fallbackSelectionSellingPoints(payload), usage: null, fallback: true }), 8000))
    ]);

    const sellingPoints = normalizeGeneratedSellingPoints(result.content);
    const useFallback = Boolean(result.fallback) || !isUsableSelectionSellingPoints(sellingPoints);
    return {
      provider: result.provider,
      model: result.model,
      selling_points: useFallback ? fallbackSelectionSellingPoints(payload) : sellingPoints,
      usage: result.usage || null,
      fallback: useFallback
    };
  } catch (error) {
    console.error("Selection selling points AI fallback", error);
    return {
      provider: runtimeConfig.provider,
      model: runtimeConfig.textModel,
      selling_points: fallbackSelectionSellingPoints(payload),
      usage: null,
      fallback: true
    };
  }
}

export async function aiImageRuntimeConfig() {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "image", fallbackRoute: "text" });
  const imageModel = cleanText(runtimeConfig.imageModel || runtimeConfig.textModel);
  if (!imageModel) throw statusError("AI image model cannot be empty", 400);
  return {
    provider: runtimeConfig.provider,
    name: runtimeConfig.name,
    baseUrl: normalizeImageRuntimeBaseUrl(runtimeConfig),
    apiKey: runtimeConfig.apiKey,
    imageModel
  };
}

function normalizeImageRuntimeBaseUrl(runtimeConfig = {}) {
  const raw = normalizeBaseUrl(runtimeConfig.baseUrl);
  if (runtimeConfig.provider !== "cctq-image2" || !raw) return raw;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if ((host === "www.cctq.ai" || host === "cctq.ai" || host === "code.b886.top" || host === "api-cf.b886.top") && url.pathname === "/") {
      return `${url.origin}/v1`;
    }
    return raw;
  } catch {
    return raw;
  }
}

async function resolveRuntimeConfig(override = {}, options = {}) {
  const stored = await readStoredConfig();
  const routeType = ROUTE_TYPES.includes(options.route) ? options.route : "text";
  const selectedRoute = stored.routes[routeType] || {};
  const fallbackRoute = options.fallbackRoute ? stored.routes[options.fallbackRoute] : null;
  const providerKey = normalizeProvider(override.provider || selectedRoute.provider || fallbackRoute?.provider || stored.provider);
  const providerConfig = stored.providers[providerKey] || {};
  const modelFromRoute = selectedRoute.provider === providerKey ? selectedRoute.model : "";
  const fallbackModelFromRoute = fallbackRoute?.provider === providerKey ? fallbackRoute.model : "";
  const apiKey = String(override.apiKey || "").trim() || decryptSecret(providerConfig.apiKeyEncrypted);
  const requireEnabled = options.requireEnabled !== false;
  if (!requireEnabled && apiKey && !override.apiKey) override.apiKey = apiKey;
  const routeModel = cleanText(override.textModel || override.model || override.imageModel || modelFromRoute || fallbackModelFromRoute);
  const hasStoredEncryptedKey = Boolean(String(providerConfig.apiKeyEncrypted || "").trim());
  const runtimeConfig = {
    ...providerConfig,
    provider: providerKey,
    baseUrl: normalizeBaseUrl(override.baseUrl || providerConfig.baseUrl),
    textModel: routeModel || cleanText(providerConfig.textModel),
    visionModel: cleanText(override.visionModel || providerConfig.visionModel),
    imageModel: cleanText(override.imageModel || (routeType === "image" ? modelFromRoute : "") || providerConfig.imageModel),
    videoModel: cleanText(override.videoModel || providerConfig.videoModel),
    apiKey
  };
  if (!runtimeConfig.enabled && requireEnabled && !override.apiKey) throw statusError("AI 服务尚未启用", 400);
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
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      throw statusError(data?.error?.message || data?.message || `AI ???????${response.status}`, response.status);
    }
    const content = extractAiTextContent(data);
    if (!content) throw statusError("AI ??????????", 502);
    return { content, usage: data.usage, raw: data };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError("AI ??????", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractAiTextContent(data = {}) {
  const choice = data?.choices?.[0] || data?.data?.[0] || null;
  const message = choice?.message || choice?.delta || data?.message || null;
  const directContent = normalizeAiContentValue(message?.content);
  if (directContent) return directContent;

  const outputText = normalizeAiContentValue(choice?.text || data?.text || data?.output_text || data?.response);
  if (outputText) return outputText;

  const reasoningText = normalizeAiContentValue(message?.reasoning_content || choice?.reasoning_content || data?.reasoning_content);
  if (reasoningText) return reasoningText;

  return "";
}

function normalizeAiContentValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function testOpenAiCompatibleModels(runtimeConfig) {
  const endpoint = `${runtimeConfig.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${runtimeConfig.apiKey}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw statusError(data?.error?.message || data?.message || `AI provider request failed: ${response.status}`, response.status);
    }
    const models = Array.isArray(data?.data) ? data.data.map((item) => item.id).filter(Boolean) : [];
    const model = runtimeConfig.imageModel || runtimeConfig.textModel;
    return {
      ok: true,
      provider: runtimeConfig.provider,
      model,
      reply: models.includes(model) ? "CCTQ-image2 连接成功" : `连接成功，可用模型：${models.join(", ") || "未知"}`,
      usage: null
    };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError("AI provider request timed out", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readStoredConfig() {
  await ensureSettingsTables();
  const row = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ? LIMIT 1", [SETTING_KEY]).then((rows) => rows[0]);
  if (!row?.value_json) return defaultSettings();
  try {
    return normalizeStoredSettings(JSON.parse(row.value_json));
  } catch {
    return defaultSettings();
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
  const settings = normalizeStoredSettings(value);
  const selected = settings.providers[settings.provider] || {};
  return {
    provider: settings.provider,
    name: selected.name || PROVIDER_PRESETS[settings.provider]?.name || "",
    baseUrl: selected.baseUrl || "",
    textModel: selected.textModel || "",
    visionModel: selected.visionModel || "",
    imageModel: selected.imageModel || "",
    videoModel: selected.videoModel || "",
    enabled: Boolean(selected.enabled),
    hasApiKey: Boolean(selected.apiKeyEncrypted),
    apiKeyHint: selected.apiKeyHint || "",
    providers: Object.fromEntries(Object.entries(settings.providers).map(([key, item]) => [key, sanitizeProvider(item)])),
    routes: settings.routes,
    presets: PROVIDER_PRESETS
  };
}

function defaultSettings() {
  const provider = DEFAULT_PROVIDER_CONFIG.provider;
  const providers = Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([key, preset]) => [
    key,
    normalizeProviderConfig({ ...preset, provider: key, enabled: false })
  ]));
  providers[provider] = normalizeProviderConfig({ ...providers[provider], ...DEFAULT_PROVIDER_CONFIG });
  return {
    provider,
    providers,
    routes: normalizeRoutes({}, provider, providers[provider])
  };
}

function normalizeStoredSettings(value = {}) {
  if (value.providers && typeof value.providers === "object") {
    const provider = normalizeProvider(value.provider || DEFAULT_PROVIDER_CONFIG.provider);
    const providers = { ...defaultSettings().providers };
    for (const [key, providerValue] of Object.entries(value.providers)) {
      const normalizedKey = normalizeProvider(key);
      providers[normalizedKey] = normalizeProviderConfig({ ...providerValue, provider: normalizedKey });
    }
    return {
      provider,
      providers,
      routes: normalizeRoutes(value.routes || value.globalRoutes || {}, provider, providers[provider])
    };
  }

  const provider = normalizeProvider(value.provider || DEFAULT_PROVIDER_CONFIG.provider);
  const defaults = defaultSettings();
  const legacyProvider = normalizeProviderConfig({
    ...PROVIDER_PRESETS[provider],
    ...value,
    provider
  });
  return {
    provider,
    providers: {
      ...defaults.providers,
      [provider]: legacyProvider
    },
    routes: normalizeRoutes({
      text: { provider, model: value.textModel },
      image: { provider, model: value.imageModel }
    }, provider, legacyProvider)
  };
}

function normalizeProviderConfig(value = {}) {
  const provider = normalizeProvider(value.provider || DEFAULT_PROVIDER_CONFIG.provider);
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  return {
    ...DEFAULT_PROVIDER_CONFIG,
    ...preset,
    ...value,
    provider,
    name: cleanText(value.name ?? preset.name),
    baseUrl: normalizeBaseUrl(value.baseUrl ?? preset.baseUrl),
    apiKeyEncrypted: String(value.apiKeyEncrypted || ""),
    apiKeyHint: String(value.apiKeyHint || ""),
    textModel: cleanText(value.textModel ?? preset.textModel),
    visionModel: cleanText(value.visionModel ?? preset.visionModel),
    imageModel: cleanText(value.imageModel ?? preset.imageModel),
    videoModel: cleanText(value.videoModel ?? preset.videoModel),
    enabled: Boolean(value.enabled)
  };
}

function sanitizeProvider(value = {}) {
  const normalized = normalizeProviderConfig(value);
  return {
    provider: normalized.provider,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    textModel: normalized.textModel,
    visionModel: normalized.visionModel,
    imageModel: normalized.imageModel,
    videoModel: normalized.videoModel,
    enabled: Boolean(normalized.enabled),
    hasApiKey: Boolean(normalized.apiKeyEncrypted),
    apiKeyHint: normalized.apiKeyHint
  };
}

function normalizeRoutes(value = {}, provider = DEFAULT_PROVIDER_CONFIG.provider, providerConfig = {}) {
  const textModel = cleanText(providerConfig.textModel || PROVIDER_PRESETS[provider]?.textModel);
  const imageModel = cleanText(providerConfig.imageModel || PROVIDER_PRESETS[provider]?.imageModel);
  const normalized = {};
  for (const type of ROUTE_TYPES) {
    const route = value[type] || {};
    const routeProvider = normalizeRouteProvider(route.provider || (type === "text" && textModel ? provider : ""));
    normalized[type] = {
      provider: routeProvider,
      model: cleanText(route.model || (type === "text" ? textModel : type === "image" ? imageModel : ""))
    };
  }
  return normalized;
}

function hasAnyModel(value = {}) {
  return Boolean(cleanText(value.textModel) || cleanText(value.visionModel) || cleanText(value.imageModel) || cleanText(value.videoModel));
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
  const cipher = crypto.createCipheriv("aes-256-gcm", primaryEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  const [version, iv, tag, encrypted] = text.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) return "";
  for (const key of candidateEncryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      continue;
    }
  }
  return "";
}

function primaryEncryptionKey() {
  return encryptionKeyFromSeed(process.env.AI_CONFIG_SECRET || config.siteAccessPassword || "ozon-erp-local-ai-config");
}

function candidateEncryptionKeys() {
  const seeds = [
    process.env.AI_CONFIG_SECRET,
    config.siteAccessPassword,
    process.env.SITE_ACCESS_PASSWORD,
    "ozon-erp-local-ai-config",
    "ozon-erp-ai-config",
    "erp.hjt888.xyz",
    process.env.APP_BASE_URL,
    process.env.LISTING_MEDIA_PUBLIC_BASE_URL
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return Array.from(new Set(seeds)).map(encryptionKeyFromSeed);
}

function encryptionKeyFromSeed(seed) {
  return crypto.createHash("sha256").update(String(seed || "")).digest();
}

function maskSecret(secret) {
  const text = String(secret || "");
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function normalizeProvider(value) {
  const provider = cleanText(value || "custom").toLowerCase();
  return PROVIDER_PRESETS[provider] ? provider : "custom";
}

function normalizeRouteProvider(value) {
  const provider = cleanText(value).toLowerCase();
  if (!provider) return "";
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

function buildSelectionSellingPointContext(payload = {}) {
  const fields = [
    ["????", payload.name],
    ["Ozon ??", payload.ozon_category_name || payload.categoryName],
    ["????", payload.vehicle_model || payload.vehicleModel],
    ["??", payload.material],
    ["??", Array.isArray(payload.color) ? payload.color.join("?") : payload.color],
    ["??????", payload.existing_selling_points || payload.selling_points || payload.sellingPoints],
    ["?????", payload.supplier_note || payload.supplierNote],
    ["????", payload.source_platform || payload.sourcePlatform]
  ]
    .map(([label, value]) => [label, cleanText(value)])
    .filter(([, value]) => value);

  return {
    hasUsefulInfo: fields.length > 0,
    prompt: [
      "??????????????",
      "??????????????????????????????????????????????????????????",
      "????????????????????????????????????",
      "",
      ...fields.map(([label, value]) => label + '?' + value)
    ].join("\n")
  };
}

function isUsableSelectionSellingPoints(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (text.length < 24) return false;
  const lower = text.toLowerCase();
  if (lower.startsWith("? ?????????")) return false;
  if (lower.includes("?? ???? ????????")) return false;
  if (lower.includes("?????") || lower.includes("??????")) return false;
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  return chineseChars >= 12;
}

function fallbackSelectionSellingPoints(payload = {}) {
  const name = cleanText(payload.name || payload.productName || "????");
  const category = cleanText(payload.ozon_category_name || payload.categoryName || "");
  const vehicleModel = cleanText(payload.vehicle_model || payload.vehicleModel || payload.vehicle_brand || payload.vehicleBrand || "");
  const material = cleanText(payload.material || "");
  const color = cleanText(Array.isArray(payload.color) ? payload.color.join("?") : payload.color || "");
  const existing = cleanText(payload.existing_selling_points || payload.selling_points || payload.sellingPoints || "");
  const sourcePlatform = cleanText(payload.source_platform || payload.sourcePlatform || "");
  const parts = [
    name,
    vehicleModel ? ('??' + vehicleModel + '??????') : '???????????????',
    material ? ('??' + material + '???????????') : '??????????????',
    color ? (color + '????????????') : '?????????????',
    category ? ('???' + category + '?????????') : '????????????',
    sourcePlatform ? ('????' + sourcePlatform + '?????????????') : '????????????'
  ].filter(Boolean);
  if (existing) parts.unshift(existing);
  return parts.join('?') + '?';
}

function normalizeGeneratedSellingPoints(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/^\s*[-*\d.、)）]+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1200);
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

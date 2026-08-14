import crypto from "node:crypto";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { testOpenAiImageProvider } from "../server/services/openai/imageGenerationService.js";

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
  apiMode: "chat_completions",
  enabled: false
};

const ROUTE_TYPES = ["text", "vision", "image", "video"];
const IMAGE_POOL_MODES = new Set(["speed", "stable", "cost"]);

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
  "change2pro-image2": {
    provider: "change2pro-image2",
    name: "Change2Pro image2",
    baseUrl: "https://api.change2pro.com",
    textModel: "",
    visionModel: "",
    imageModel: "gpt-image-2",
    apiMode: "images"
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
  const expectedUpdatedAt = body.updated_at || body.updatedAt || "";
  if (expectedUpdatedAt && previous.updated_at && !sameSecond(expectedUpdatedAt, previous.updated_at)) {
    throw statusError("AI 配置已被其他用户保存，请刷新后再继续编辑", 409);
  }
  const provider = normalizeProvider(body.provider || previous.provider);
  const preset = providerPreset(provider);
  const previousProvider = previous.providers[provider] || {};
  const apiKey = String(body.apiKey || "").trim();
  const clearApiKey = body.clearApiKey === true;
  const nextProvider = {
    ...DEFAULT_PROVIDER_CONFIG,
    ...previousProvider,
    ...preset,
    provider,
    name: cleanText(body.name ?? previousProvider.name ?? preset.name),
    baseUrl: normalizeImageProviderBaseUrl(provider, body.baseUrl ?? previousProvider.baseUrl ?? preset.baseUrl, previousProvider.name ?? preset.name),
    textModel: cleanText(body.textModel ?? previousProvider.textModel ?? preset.textModel),
    visionModel: cleanText(body.visionModel ?? previousProvider.visionModel ?? preset.visionModel),
    imageModel: normalizeImageProviderModel(provider, body.imageModel ?? previousProvider.imageModel ?? preset.imageModel, body.baseUrl ?? previousProvider.baseUrl ?? preset.baseUrl, previousProvider.name ?? preset.name),
    videoModel: cleanText(body.videoModel ?? previousProvider.videoModel ?? preset.videoModel),
    apiMode: normalizeProviderApiMode(provider, body.apiMode ?? body.wireApi ?? previousProvider.apiMode ?? preset.apiMode, body.baseUrl ?? previousProvider.baseUrl ?? preset.baseUrl, previousProvider.name ?? preset.name),
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
    routes: normalizeRoutes(body.routes || previous.routes, provider, nextProvider),
    imageProviderPool: normalizeImageProviderPoolForSave(body.imageProviderPool ?? body.image_provider_pool ?? previous.imageProviderPool, previous.imageProviderPool)
  };

  await writeStoredConfig(next, previous, personId);
  return sanitizeConfig(next);
}

export async function testAiProviderConfig(payload = {}) {
  const configToTest = await resolveRuntimeConfig(payload, { requireEnabled: false, allowImageOnly: true });
  if (configToTest.provider === "cctq-image2") {
    return testOpenAiCompatibleModels(configToTest);
  }
  if (!configToTest.textModel) {
    return {
      ok: true,
      provider: configToTest.provider,
      model: configToTest.imageModel,
      reply: "图片专用配置已通过本地校验：Base URL、密钥和生图模型已填写；未发起扣费生图请求，实际出图能力请在生成任务中验证。",
      usage: null
    };
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

export async function testAiImageProviderChannel(payload = {}) {
  const stored = await readStoredConfig();
  const pool = normalizeImageProviderPool(stored.imageProviderPool);
  const channelId = cleanText(payload.channelId || payload.channel_id);
  const channel = channelId ? pool.channels.find((item) => item.id === channelId) : null;
  let runtimeConfig;
  if (channel) {
    const apiKey = cleanText(payload.apiKey) || decryptSecret(channel.apiKeyEncrypted);
    runtimeConfig = imageChannelRuntimeConfig(channel, apiKey);
  } else {
    const provider = normalizeProvider(payload.provider || stored.provider || DEFAULT_PROVIDER_CONFIG.provider);
    const preset = providerPreset(provider);
    const providerConfig = stored.providers[provider] || {};
    const apiKey = cleanText(payload.apiKey) || decryptSecret(providerConfig.apiKeyEncrypted);
    runtimeConfig = {
      provider,
      name: cleanText(payload.name || providerConfig.name || preset.name),
      baseUrl: normalizeImageRuntimeBaseUrl({
        provider,
        baseUrl: normalizeImageProviderBaseUrl(provider, payload.baseUrl ?? providerConfig.baseUrl ?? preset.baseUrl, payload.name || providerConfig.name || preset.name)
      }),
      apiKey,
      imageModel: normalizeImageProviderModel(provider, payload.imageModel ?? providerConfig.imageModel ?? preset.imageModel, payload.baseUrl ?? providerConfig.baseUrl ?? preset.baseUrl, payload.name || providerConfig.name || preset.name),
      apiMode: normalizeProviderApiMode(provider, payload.apiMode ?? providerConfig.apiMode ?? preset.apiMode, payload.baseUrl ?? providerConfig.baseUrl ?? preset.baseUrl, payload.name || providerConfig.name || preset.name)
    };
  }

  if (!runtimeConfig.baseUrl) throw statusError("图片通道 Base URL 不能为空", 400);
  if (!runtimeConfig.imageModel) throw statusError("图片模型不能为空", 400);
  if (!runtimeConfig.apiKey) throw statusError("图片通道 API Key 不能为空", 400);

  const mode = cleanText(payload.mode) === "edit" ? "edit" : "generate";
  const result = await testOpenAiImageProvider({ runtimeConfig, mode });
  return {
    ...result,
    provider: runtimeConfig.provider,
    name: runtimeConfig.channelName || runtimeConfig.name,
    baseUrl: runtimeConfig.baseUrl,
    imageModel: runtimeConfig.imageModel,
    apiMode: runtimeConfig.apiMode
  };
}

export async function chatWithAiProvider(payload = {}) {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "text" });
  const messages = normalizeMessages(payload.messages, payload.prompt);
  if (!messages.length) throw new Error("AI 调用内容不能为空");
  const result = await callOpenAiCompatibleChat(runtimeConfig, {
    messages,
    temperature: finiteNumber(payload.temperature, 0.2),
    maxTokens: finiteNumber(payload.maxTokens ?? payload.max_tokens, null),
    timeoutMs: finiteNumber(payload.timeoutMs ?? payload.timeout_ms, 60_000)
  });
  return {
    provider: runtimeConfig.provider,
    model: runtimeConfig.textModel,
    content: result.content,
    usage: result.usage || null,
    raw: payload.includeRaw ? result.raw : undefined
  };
}

export async function streamAiProviderResponse(payload = {}, handlers = {}) {
  const route = payload.route === "vision" ? "vision" : "text";
  const runtimeConfig = await resolveRuntimeConfig({}, {
    requireEnabled: true,
    route,
    fallbackRoute: route === "vision" ? "text" : undefined
  });
  const messages = route === "vision" ? normalizeVisionMessages(payload.messages) : normalizeMessages(payload.messages, payload.prompt);
  if (!messages.length) throw new Error("AI 调用内容不能为空");
  return streamOpenAiCompatibleChat(runtimeConfig, {
    messages,
    temperature: finiteNumber(payload.temperature, route === "vision" ? 0.1 : 0.2),
    maxTokens: finiteNumber(payload.maxTokens ?? payload.max_tokens, null),
    timeoutMs: finiteNumber(payload.timeoutMs ?? payload.timeout_ms, 60_000)
  }, handlers);
}

export async function visionWithAiProvider(payload = {}) {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "vision", fallbackRoute: "text" });
  const messages = normalizeVisionMessages(payload.messages);
  if (!messages.length) throw new Error("AI vision content cannot be empty");
  const callOptions = {
    messages,
    temperature: finiteNumber(payload.temperature, 0.1),
    maxTokens: finiteNumber(payload.maxTokens ?? payload.max_tokens, null),
    timeoutMs: finiteNumber(payload.timeoutMs ?? payload.timeout_ms, 60_000)
  };
  let result;
  try {
    result = await callOpenAiCompatibleChat(runtimeConfig, callOptions);
  } catch (error) {
    const firstStatus = Number(error?.status || 0);
    if (firstStatus !== 429 && ![500, 502, 503, 504].includes(firstStatus)) {
      throw visionProviderError(error, runtimeConfig);
    }
    await delay(1500);
    try {
      result = await callOpenAiCompatibleChat(runtimeConfig, callOptions);
    } catch (retryError) {
      if (Number(retryError?.status || 0) === 429) {
        throw statusError(`视觉识别模型限流：${runtimeConfig.name || runtimeConfig.provider} / ${runtimeConfig.textModel}。请稍后重试，或在 AI 设置里给“全局视觉模型”单独配置额度更稳定的多模态模型。`, 429);
      }
      throw visionProviderError(retryError, runtimeConfig);
    }
  }
  return {
    provider: runtimeConfig.provider,
    model: runtimeConfig.textModel,
    content: result.content,
    usage: result.usage || null,
    raw: payload.includeRaw ? result.raw : undefined
  };
}

function visionProviderError(error, runtimeConfig = {}) {
  const provider = runtimeConfig.name || runtimeConfig.provider || "未知服务商";
  const model = runtimeConfig.textModel || runtimeConfig.visionModel || "未配置模型";
  return statusError(`视觉识别服务失败：${provider} / ${model}；${error?.message || "上游未返回错误详情"}`, Number(error?.status || 0) || 502);
}

export async function generateSelectionSellingPoints(payload = {}) {
  const runtimeConfig = await resolveRuntimeConfig({}, { requireEnabled: true, route: "text" });
  const context = buildSelectionSellingPointContext(payload);
  if (!context.hasUsefulInfo) {
    throw statusError("缺少可用于生成卖点的商品信息", 400);
  }

  try {
    const result = await Promise.race([
      callOpenAiCompatibleChat(runtimeConfig, {
        messages: [
          {
            role: "system",
            content: [
              "你是 Ozon 汽车用品上架文案助手。",
              "请只输出俄语产品卖点，不要输出中文。",
              "写成一段自然、可直接用于产品卖点/简介的文案，不要使用 Markdown 列表。",
              "如果输入里有乱码、连续问号或无意义符号，请忽略它们，只保留可理解的商品事实。",
              "不要编造未提供的车型、材质、颜色、数量。"
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
    imageModel,
    apiMode: runtimeConfig.apiMode
  };
}

export async function aiImageRuntimePoolConfig() {
  const stored = await readStoredConfig();
  const pool = normalizeImageProviderPool(stored.imageProviderPool);
  if (!pool.enabled) return [await aiImageRuntimeConfig()];
  const candidates = [];
  for (const channel of pool.channels) {
    if (!channel.enabled) continue;
    const apiKey = decryptSecret(channel.apiKeyEncrypted);
    const imageModel = cleanText(channel.imageModel);
    const baseUrl = normalizeImageRuntimeBaseUrl(channel);
    if (!apiKey || !imageModel || !baseUrl) continue;
    candidates.push({
      provider: channel.provider,
      name: channel.name,
      baseUrl,
      apiKey,
      imageModel,
      apiMode: channel.apiMode,
      channelId: channel.id,
      channelName: channel.name,
      weight: channel.weight,
      maxConcurrency: channel.maxConcurrency,
      poolMaxConcurrency: pool.maxConcurrency,
      dispatchMode: pool.mode
    });
  }
  return candidates.length ? candidates : [await aiImageRuntimeConfig()];
}

function imageChannelRuntimeConfig(channel, apiKey) {
  return {
    provider: channel.provider,
    name: channel.name,
    baseUrl: normalizeImageRuntimeBaseUrl(channel),
    apiKey,
    imageModel: cleanText(channel.imageModel),
    apiMode: channel.apiMode,
    channelId: channel.id,
    channelName: channel.name,
    weight: channel.weight,
    maxConcurrency: channel.maxConcurrency
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
  const hasOverrideTextModel = Object.prototype.hasOwnProperty.call(override, "textModel")
    || Object.prototype.hasOwnProperty.call(override, "model");
  const routeModel = cleanText(hasOverrideTextModel
    ? (override.textModel || override.model)
    : (modelFromRoute || fallbackModelFromRoute));
  const hasStoredEncryptedKey = Boolean(String(providerConfig.apiKeyEncrypted || "").trim());
  const runtimeConfig = {
    ...providerConfig,
    provider: providerKey,
    baseUrl: normalizeImageProviderBaseUrl(providerKey, override.baseUrl || providerConfig.baseUrl, providerConfig.name),
    textModel: routeModel || (hasOverrideTextModel ? "" : cleanText(providerConfig.textModel)),
    visionModel: cleanText(override.visionModel || providerConfig.visionModel),
    imageModel: normalizeImageProviderModel(providerKey, override.imageModel || (routeType === "image" ? modelFromRoute : "") || providerConfig.imageModel, override.baseUrl || providerConfig.baseUrl, providerConfig.name),
    videoModel: cleanText(override.videoModel || providerConfig.videoModel),
    apiMode: normalizeProviderApiMode(providerKey, override.apiMode ?? override.wireApi ?? providerConfig.apiMode, override.baseUrl || providerConfig.baseUrl, providerConfig.name),
    apiKey
  };
  if (!runtimeConfig.enabled && requireEnabled && !override.apiKey) throw statusError("AI 服务尚未启用", 400);
  if (!runtimeConfig.baseUrl) throw statusError("AI Base URL 不能为空", 400);
  if (!runtimeConfig.textModel && !(options.allowImageOnly && runtimeConfig.imageModel)) throw statusError("AI 文本模型不能为空", 400);
  if (!runtimeConfig.apiKey) throw statusError("AI API Key 不能为空", 400);
  return runtimeConfig;
}

async function callOpenAiCompatibleChat(runtimeConfig, options = {}) {
  if (runtimeConfig.apiMode === "responses") {
    return callOpenAiResponses(runtimeConfig, options);
  }
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
      throw statusError(data?.error?.message || data?.message || `AI 请求失败：${response.status}`, response.status);
    }
    const content = extractAiTextContent(data);
    if (!content) throw statusError("AI 没有返回可用内容", 502);
    return { content, usage: data.usage, raw: data };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError("AI 请求超时", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function streamOpenAiCompatibleChat(runtimeConfig, options = {}, handlers = {}) {
  const responsesMode = runtimeConfig.apiMode === "responses";
  const endpoint = responsesMode
    ? responsesEndpoint(runtimeConfig.baseUrl)
    : `${runtimeConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = responsesMode
    ? { model: runtimeConfig.textModel, input: messagesToResponsesInput(options.messages), stream: true }
    : { model: runtimeConfig.textModel, messages: options.messages, temperature: options.temperature, stream: true };
  if (responsesMode && options.temperature !== undefined && options.temperature !== null) body.temperature = options.temperature;
  if (responsesMode && options.maxTokens) body.max_output_tokens = options.maxTokens;
  if (!responsesMode && options.maxTokens) body.max_tokens = options.maxTokens;

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  handlers.signal?.addEventListener?.("abort", abort, { once: true });
  const startedAt = Date.now();
  let firstTokenMs = null;
  let content = "";
  let usage = null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeConfig.apiKey}` },
      body: JSON.stringify(body)
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw statusError(data?.error?.message || data?.message || `AI 流式请求失败：${response.status}`, response.status || 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        usage ||= event.usage || null;
        const delta = extractStreamDelta(event, responsesMode);
        if (!delta) continue;
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        content += delta;
        handlers.onDelta?.(delta);
      }
      if (done) break;
    }
    if (pending.trim()) {
      const data = pending.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") {
        try {
          const event = JSON.parse(data);
          usage ||= event.usage || null;
          const delta = extractStreamDelta(event, responsesMode);
          if (delta) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
            content += delta;
            handlers.onDelta?.(delta);
          }
        } catch {}
      }
    }
    if (!content) throw statusError("AI 没有返回可用内容", 502);
    return { provider: runtimeConfig.provider, model: runtimeConfig.textModel, content, usage, firstTokenMs, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError(handlers.signal?.aborted ? "AI 流式请求已取消" : "AI 流式请求超时", handlers.signal?.aborted ? 499 : 504);
    throw error;
  } finally {
    clearTimeout(timeout);
    handlers.signal?.removeEventListener?.("abort", abort);
  }
}

function extractStreamDelta(event = {}, responsesMode = false) {
  if (responsesMode) {
    if (event.type === "response.output_text.delta") return String(event.delta || "");
    return "";
  }
  return String(event?.choices?.[0]?.delta?.content || "");
}

async function callOpenAiResponses(runtimeConfig, options = {}) {
  const endpoint = responsesEndpoint(runtimeConfig.baseUrl);
  const body = {
    model: runtimeConfig.textModel,
    input: messagesToResponsesInput(options.messages)
  };
  if (options.temperature !== undefined && options.temperature !== null) body.temperature = options.temperature;
  if (options.maxTokens) body.max_output_tokens = options.maxTokens;

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
      throw statusError(data?.error?.message || data?.message || `AI responses request failed: ${response.status}`, response.status);
    }
    const content = extractAiTextContent(data);
    if (!content) throw statusError("AI 没有返回可用内容", 502);
    return { content, usage: data.usage, raw: data };
  } catch (error) {
    if (error?.name === "AbortError") throw statusError("AI 请求超时", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function responsesEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base.toLowerCase().endsWith("/responses") ? base : `${base}/responses`;
}

function messagesToResponsesInput(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: ["system", "user", "assistant"].includes(message?.role) ? message.role : "user",
      content: messageContentToResponsesContent(message?.content)
    }))
    .filter((message) => message.content.length);
}

function messageContentToResponsesContent(content) {
  if (typeof content === "string") {
    const text = cleanText(content);
    return text ? [{ type: "input_text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      if (typeof item === "string") return { type: "input_text", text: cleanText(item) };
      if (item?.type === "text") return { type: "input_text", text: cleanText(item.text || item.content) };
      if (item?.type === "image_url") {
        const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
        return imageUrl ? { type: "input_image", image_url: String(imageUrl) } : null;
      }
      return null;
    })
    .filter((item) => item && (item.text || item.image_url));
}

function extractAiTextContent(data = {}) {
  const choice = data?.choices?.[0] || data?.data?.[0] || null;
  const message = choice?.message || choice?.delta || data?.message || null;
  const directContent = normalizeAiContentValue(message?.content);
  if (directContent) return directContent;

  const outputText = normalizeAiContentValue(choice?.text || data?.text || data?.output_text || data?.response);
  if (outputText) return outputText;

  const nestedOutputText = normalizeAiContentValue((Array.isArray(data?.output) ? data.output : []).flatMap((item) => item?.content || []));
  if (nestedOutputText) return nestedOutputText;

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
  const row = await mysqlQuery("SELECT value_json, updated_at FROM system_settings WHERE `key` = ? LIMIT 1", [SETTING_KEY]).then((rows) => rows[0]);
  if (!row?.value_json) return defaultSettings();
  try {
    return { ...normalizeStoredSettings(JSON.parse(row.value_json)), updated_at: row.updated_at || "" };
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
    updated_at: value.updated_at || "",
    provider: settings.provider,
    name: selected.name || providerPreset(settings.provider).name || "",
    baseUrl: selected.baseUrl || "",
    textModel: selected.textModel || "",
    visionModel: selected.visionModel || "",
    imageModel: selected.imageModel || "",
    videoModel: selected.videoModel || "",
    apiMode: selected.apiMode || "chat_completions",
    enabled: Boolean(selected.enabled),
    hasApiKey: Boolean(selected.apiKeyEncrypted),
    apiKeyHint: selected.apiKeyHint || "",
    providers: Object.fromEntries(Object.entries(settings.providers).map(([key, item]) => [key, sanitizeProvider(item)])),
    routes: settings.routes,
    imageProviderPool: sanitizeImageProviderPool(settings.imageProviderPool),
    presets: PROVIDER_PRESETS
  };
}

function sameSecond(left, right) {
  const leftDate = normalizeSecond(left);
  const rightDate = normalizeSecond(right);
  return Boolean(leftDate && rightDate && leftDate === rightDate);
}

function normalizeSecond(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  return String(value).replace("T", " ").replace("Z", "").slice(0, 19);
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
    routes: normalizeRoutes({}, provider, providers[provider]),
    imageProviderPool: normalizeImageProviderPool()
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
      routes: normalizeRoutes(value.routes || value.globalRoutes || {}, provider, providers[provider]),
      imageProviderPool: normalizeImageProviderPool(value.imageProviderPool || value.image_provider_pool)
    };
  }

  const provider = normalizeProvider(value.provider || DEFAULT_PROVIDER_CONFIG.provider);
  const defaults = defaultSettings();
  const legacyProvider = normalizeProviderConfig({
    ...providerPreset(provider),
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
    }, provider, legacyProvider),
    imageProviderPool: normalizeImageProviderPool(value.imageProviderPool || value.image_provider_pool)
  };
}

function normalizeProviderConfig(value = {}) {
  const provider = normalizeProvider(value.provider || DEFAULT_PROVIDER_CONFIG.provider);
  const preset = providerPreset(provider);
  return {
    ...DEFAULT_PROVIDER_CONFIG,
    ...preset,
    ...value,
    provider,
    name: cleanText(value.name ?? preset.name),
    baseUrl: normalizeImageProviderBaseUrl(provider, value.baseUrl ?? preset.baseUrl, value.name ?? preset.name),
    apiKeyEncrypted: String(value.apiKeyEncrypted || ""),
    apiKeyHint: String(value.apiKeyHint || ""),
    textModel: cleanText(value.textModel ?? preset.textModel),
    visionModel: cleanText(value.visionModel ?? preset.visionModel),
    imageModel: normalizeImageProviderModel(provider, value.imageModel ?? preset.imageModel, value.baseUrl ?? preset.baseUrl, value.name ?? preset.name),
    videoModel: cleanText(value.videoModel ?? preset.videoModel),
    apiMode: normalizeProviderApiMode(provider, value.apiMode ?? value.wireApi ?? preset.apiMode, value.baseUrl ?? preset.baseUrl, value.name ?? preset.name),
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
    apiMode: normalized.apiMode,
    enabled: Boolean(normalized.enabled),
    hasApiKey: Boolean(normalized.apiKeyEncrypted),
    apiKeyHint: normalized.apiKeyHint
  };
}

function normalizeImageProviderPoolForSave(value = {}, previous = {}) {
  const previousChannels = new Map(normalizeImageProviderPool(previous).channels.map((channel) => [channel.id, channel]));
  const pool = normalizeImageProviderPool(value);
  return {
    ...pool,
    channels: pool.channels.map((channel) => {
      const previousChannel = previousChannels.get(channel.id) || {};
      const apiKey = cleanText(channel.apiKey);
      const clearApiKey = channel.clearApiKey === true;
      const next = {
        ...channel,
        apiKeyEncrypted: previousChannel.apiKeyEncrypted || channel.apiKeyEncrypted || "",
        apiKeyHint: previousChannel.apiKeyHint || channel.apiKeyHint || ""
      };
      delete next.apiKey;
      delete next.clearApiKey;
      if (apiKey) {
        next.apiKeyEncrypted = encryptSecret(apiKey);
        next.apiKeyHint = maskSecret(apiKey);
      } else if (clearApiKey) {
        next.apiKeyEncrypted = "";
        next.apiKeyHint = "";
      }
      return next;
    })
  };
}

function normalizeImageProviderPool(value = {}) {
  const channels = Array.isArray(value?.channels)
    ? value.channels.map(normalizeImageProviderChannel).filter(Boolean)
    : [];
  const mode = IMAGE_POOL_MODES.has(String(value?.mode || "").trim()) ? String(value.mode).trim() : "speed";
  return {
    enabled: Boolean(value?.enabled),
    mode,
    maxConcurrency: positiveInteger(value?.maxConcurrency ?? value?.max_concurrency, 20),
    channels: channels.slice(0, 12)
  };
}

function normalizeImageProviderChannel(value = {}) {
  if (!value || typeof value !== "object") return null;
  const provider = normalizeProvider(value.provider || "custom");
  const preset = providerPreset(provider);
  const id = cleanText(value.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || crypto.randomUUID();
  return {
    id,
    name: cleanText(value.name || preset.name || provider).slice(0, 80),
    provider,
    baseUrl: normalizeImageProviderBaseUrl(provider, value.baseUrl ?? value.base_url ?? preset.baseUrl, value.name ?? preset.name),
    apiKeyEncrypted: String(value.apiKeyEncrypted || ""),
    apiKeyHint: String(value.apiKeyHint || ""),
    apiKey: String(value.apiKey || ""),
    clearApiKey: value.clearApiKey === true,
    imageModel: normalizeImageProviderModel(provider, value.imageModel ?? value.image_model ?? preset.imageModel, value.baseUrl ?? value.base_url ?? preset.baseUrl, value.name ?? preset.name),
    apiMode: normalizeProviderApiMode(provider, value.apiMode ?? value.api_mode ?? value.wireApi ?? preset.apiMode, value.baseUrl ?? value.base_url ?? preset.baseUrl, value.name ?? preset.name),
    enabled: value.enabled !== false,
    weight: clampNumber(value.weight, 1, 20, 1),
    maxConcurrency: positiveInteger(value.maxConcurrency ?? value.max_concurrency, 20)
  };
}

function sanitizeImageProviderPool(value = {}) {
  const pool = normalizeImageProviderPool(value);
  return {
    enabled: pool.enabled,
    mode: pool.mode,
    maxConcurrency: pool.maxConcurrency,
    channels: pool.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      imageModel: channel.imageModel,
      apiMode: channel.apiMode,
      enabled: channel.enabled,
      weight: channel.weight,
      maxConcurrency: channel.maxConcurrency,
      hasApiKey: Boolean(channel.apiKeyEncrypted),
      apiKeyHint: channel.apiKeyHint
    }))
  };
}

function normalizeRoutes(value = {}, provider = DEFAULT_PROVIDER_CONFIG.provider, providerConfig = {}) {
  const textModel = cleanText(providerConfig.textModel || providerPreset(provider).textModel);
  const imageModel = cleanText(providerConfig.imageModel || providerPreset(provider).imageModel);
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

function normalizeVisionMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      const role = ["system", "user", "assistant"].includes(message?.role) ? message.role : "user";
      const content = normalizeVisionContent(message?.content);
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}

function normalizeVisionContent(content) {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  const normalized = content
    .map((item) => {
      if (typeof item === "string") return { type: "text", text: cleanText(item) };
      const type = String(item?.type || "").trim();
      if (type === "text") return { type, text: cleanText(item.text || item.content) };
      if (type === "image_url") {
        const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
        if (!url) return null;
        return { type, image_url: { url: String(url) } };
      }
      return null;
    })
    .filter(Boolean);
  return normalized.length ? normalized : "";
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
  if (PROVIDER_PRESETS[provider]) return provider;
  return isCustomProviderKey(provider) ? provider : "custom";
}

function normalizeRouteProvider(value) {
  const provider = cleanText(value).toLowerCase();
  if (!provider) return "";
  if (PROVIDER_PRESETS[provider]) return provider;
  return isCustomProviderKey(provider) ? provider : "custom";
}

function providerPreset(provider) {
  return PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
}

function isCustomProviderKey(provider) {
  return /^custom_[a-z0-9][a-z0-9_-]{2,80}$/.test(String(provider || ""));
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeApiMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (mode === "responses" || mode === "response") return "responses";
  if (mode === "images" || mode === "image") return "images";
  return "chat_completions";
}

function normalizeProviderApiMode(provider, value, baseUrl = "", name = "") {
  const mode = normalizeApiMode(value);
  if (isChange2ProImageProvider(provider, baseUrl, name)) return "images";
  return mode;
}

function normalizeImageProviderBaseUrl(provider, value, name = "") {
  const baseUrl = normalizeBaseUrl(value);
  if (!isChange2ProImageProvider(provider, baseUrl, name)) return baseUrl;
  if (!baseUrl) return "https://api.change2pro.com";
  const lower = baseUrl.toLowerCase();
  if (lower.endsWith("/v1")) return baseUrl.slice(0, -3);
  if (lower.endsWith("/responses")) return "https://api.change2pro.com";
  return baseUrl;
}

function normalizeImageProviderModel(provider, value, baseUrl = "", name = "") {
  const model = cleanText(value);
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

function cleanText(value) {
  return String(value || "").trim().slice(0, 2000);
}

function cleanAiCommerceText(value) {
  return cleanText(value)
    .replace(/[\uFFFD\u952F\u9416\u920B\u93C3]/g, " ")
    .replace(/\?{2,}/g, " ")
    .replace(/[?？]{1,}\s*(?=[\u4e00-\u9fffA-Za-zА-Яа-я0-9])/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function buildSelectionSellingPointContext(payload = {}) {
  const fields = [
    ["商品名称", payload.name],
    ["Ozon 类目", payload.ozon_category_name || payload.categoryName],
    ["适配车型", payload.vehicle_model || payload.vehicleModel],
    ["材质", payload.material],
    ["颜色", Array.isArray(payload.color) ? payload.color.join(", ") : payload.color],
    ["已有卖点", payload.existing_selling_points || payload.selling_points || payload.sellingPoints],
    ["供应商备注", payload.supplier_note || payload.supplierNote],
    ["来源平台", payload.source_platform || payload.sourcePlatform]
  ]
    .map(([label, value]) => [label, cleanAiCommerceText(value)])
    .filter(([, value]) => value);

  return {
    hasUsefulInfo: fields.length > 0,
    prompt: [
      "请根据下面信息生成俄语产品卖点。",
      "要求：突出适配车型、材质、用途、防刮耐磨、安装方便等确定信息；输入中没有的信息不要补。",
      "输出：1 段俄语，60-100 个俄语词左右，适合 Ozon 商品上架。",
      "",
      ...fields.map(([label, value]) => `${label}: ${value}`)
    ].join("\n")
  };
}

function isUsableSelectionSellingPoints(value) {
  const text = cleanAiCommerceText(value);
  if (!text) return false;
  if (text.length < 24) return false;
  if (hasBrokenCommerceText(text)) return false;
  const lower = text.toLowerCase();
  if (lower.includes("i'm sorry") || lower.includes("не могу") || lower.includes("cannot")) return false;
  const cyrillicChars = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cyrillicChars >= 20 && chineseChars < 8;
}

function fallbackSelectionSellingPoints(payload = {}) {
  const name = cleanAiCommerceText(payload.name || payload.productName || "");
  const category = cleanAiCommerceText(payload.ozon_category_name || payload.categoryName || "");
  const sourceText = [name, category, payload.supplier_note, payload.existing_selling_points, payload.selling_points].map(cleanAiCommerceText).join(" ");
  const vehicleModel = cleanAiCommerceText(payload.vehicle_model || payload.vehicleModel || payload.vehicle_brand || payload.vehicleBrand || extractVehicleModel(sourceText));
  const material = translateMaterial(cleanAiCommerceText(payload.material || sourceText));
  const color = translateColor(cleanAiCommerceText(Array.isArray(payload.color) ? payload.color.join(", ") : payload.color || sourceText));
  const existing = stripChineseText(cleanAiCommerceText(payload.existing_selling_points || payload.selling_points || payload.sellingPoints || ""));

  const title = vehicleModel ? "Комплект защитных накладок" : "Автомобильный защитный аксессуар";
  const vehicleText = vehicleModel ? ` для ${vehicleModel}` : "";
  const materialText = material ? ` Материал: ${material}.` : "";
  const colorText = color ? ` Цвет: ${color}.` : "";
  const categoryText = category && !/[\u4e00-\u9fff]/.test(category) ? ` Подходит для категории: ${category}.` : "";
  const existingText = existing ? ` ${existing}` : "";

  return normalizeGeneratedSellingPoints(
    `${title}${vehicleText}. ${materialText}${colorText}${categoryText} Аксессуар помогает защитить поверхность автомобиля от царапин, потертостей и следов ежедневной эксплуатации. Установка простая и не требует сложной подготовки. Изделие аккуратно дополняет внешний вид автомобиля и подходит для повседневного использования.${existingText}`
  );
}

function extractVehicleModel(value) {
  const text = cleanAiCommerceText(value);
  const match = text.match(/\b(TENET\s*[A-Z0-9-]+|Chery\s*[A-Z0-9-]+|Nissan\s*[A-Z0-9-]+|Toyota\s*[A-Z0-9-]+|Haval\s*[A-Z0-9-]+)\b/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function translateMaterial(value) {
  const text = cleanAiCommerceText(value).toLowerCase();
  if (!text) return "";
  if (/人造革|人造皮革|искусственн/.test(text)) return "искусственная кожа";
  if (/碳纤|карбон/.test(text)) return "карбоновая фактура";
  if (/皮革|кож/.test(text)) return "кожа";
  if (/пластик/.test(text)) return "пластик";
  const stripped = stripChineseText(text);
  return /[А-Яа-яЁё]/.test(stripped) ? stripped : "";
}

function translateColor(value) {
  const text = cleanAiCommerceText(value).toLowerCase();
  if (!text) return "";
  if (/黑色|черн/.test(text)) return "черный";
  if (/白色|бел/.test(text)) return "белый";
  if (/粉|роз/.test(text)) return "розовый";
  if (/сер/.test(text)) return "серый";
  const stripped = stripChineseText(text);
  return /[А-Яа-яЁё]/.test(stripped) ? stripped : "";
}

function stripChineseText(value) {
  return cleanAiCommerceText(value)
    .replace(/[\u4e00-\u9fff]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeGeneratedSellingPoints(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/[\uFFFD\u952F\u9416\u920B\u93C3]/g, " ")
    .replace(/\?{2,}/g, " ")
    .replace(/^\s*[-*\d.、)）]+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 1200);
}

function hasBrokenCommerceText(value) {
  const text = String(value || "");
  if (!text) return false;
  if (/[\uFFFD\u952F\u9416\u920B\u93C3]/.test(text)) return true;
  if (/\?{3,}/.test(text)) return true;
  const questionMarks = (text.match(/\?/g) || []).length;
  return questionMarks >= 6 && questionMarks / Math.max(text.length, 1) > 0.04;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

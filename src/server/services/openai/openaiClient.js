import OpenAI from "openai";

export const OPENAI_TIMEOUT_MS = 120_000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "OPENAI_API_KEY_NOT_CONFIGURED",
  timeout: OPENAI_TIMEOUT_MS
});

export function isOpenAiConfigured() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

export function getOpenAiConfigStatus() {
  return {
    configured: isOpenAiConfigured(),
    textModel: process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
    imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"
  };
}

export function assertOpenAiConfigured() {
  if (isOpenAiConfigured()) return;
  const error = new Error("OpenAI API Key 未配置");
  error.status = 503;
  throw error;
}

export default client;

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { currentAiTenantSession } from "./ai-tenant-context.js";
import { aiCreditOperationKey, aiCreditRuntime } from "./ai-credit-runtime.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status, statusCode: status });
const IMAGE_INPUTS = ["finalPrompt", "prompt", "ratio", "autoCrop", "cropMode", "sourceImageUrl", "sourceImageUrls",
  "referenceImageUrl", "sourceImage", "fallbackSourceImageUrl", "fallbackReferenceImageUrl", "productImageCount",
  "title", "productName", "product_name", "variantTarget", "variant_target", "categoryName", "category_name",
  "description", "summary", "material", "color", "row", "product", "source"];

export function aiImageCreditProviderIdentity(runtime) {
  // Include the upstream account without storing any credential in the wallet.
  // A rotated key/channel/model cannot poll an old receipt under a new account.
  return `image:${hash(JSON.stringify([runtime.provider, runtime.baseUrl, runtime.channelId || "", runtime.apiKey, runtime.imageModel, runtime.apiMode || ""]))}`;
}

function imageInput(payload) {
  return Object.fromEntries(IMAGE_INPUTS.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
}

export async function validateAiCreditImageResult(result, task, getFile) {
  if (result?.taskId !== task.id || !Array.isArray(result.generatedImages) || result.generatedImages.length !== 1) {
    throw fail("AI 未返回完整图片，积分暂时保留等待核对", "AI_CREDIT_IMAGE_INVALID", 502);
  }
  for (const [scope, images] of [["generated", result.generatedImages], ["cropped", result.croppedImages || []]]) {
    for (const image of images) {
      if (image.url !== `/api/ai/file/${task.id}/${scope}/${encodeURIComponent(image.filename)}`) throw fail("AI 图片不属于原生成任务", "AI_CREDIT_IMAGE_INVALID", 502);
      const file = await getFile(task.id, scope, image.filename);
      if (!file.size || file.size > 30 * 1024 * 1024) throw fail("AI 图片大小无效", "AI_CREDIT_IMAGE_INVALID", 502);
      const bytes = await fs.readFile(file.filePath);
      const sha256 = hash(bytes);
      if (image.contentSha256 && image.contentSha256 !== sha256) throw fail("已保存的 AI 图片内容发生变化，请联系平台核查原任务", "AI_CREDIT_RESULT_INVALID", 409);
      const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
      const metadata = await decoder.metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format)) throw fail("AI 图片格式无效", "AI_CREDIT_IMAGE_INVALID", 502);
      await decoder.stats(); // Decode pixels: a URL/header alone is not a usable result.
      const fd = await fs.open(file.filePath, "r+");
      try { await fd.sync(); } finally { await fd.close(); }
      image.contentSha256 = sha256;
    }
  }
  return result;
}

export function createAiCreditImageAdapter({ runtime, run, getFile, recoveryPayload, notifyProviderJob = null }) {
  async function generate(payload, { task, onReceipt }, receipt = null) {
    try {
      const result = await run({ ...payload, imageCount: 1, taskId: task.id, imageRuntimeConfig: runtime,
        providerJob: receipt ? { jobId: receipt } : null,
        onProviderJob: async job => {
          if (onReceipt) await onReceipt(String(job.jobId)); // Commit receipt before external progress or any polling.
          await notifyProviderJob?.(job, 0);
        } });
      return await validateAiCreditImageResult(result, task, getFile);
    } catch (error) {
      // Only an explicit terminal job response is evidence of a failed request.
      // Timeout, HTTP 5xx, missing receipt, bad media or revoked access stay held.
      if (error?.code === "provider_job_terminal_failed") error.definiteFailure = true;
      throw error;
    }
  }
  return {
    name: aiImageCreditProviderIdentity(runtime), model: runtime.imageModel, priceKey: "image.generate",
    verifySavedResult: (result, { task }) => validateAiCreditImageResult(result, task, getFile),
    submit: (payload, context) => generate(payload, context),
    async query(receipt, context) {
      try { return { status: "succeeded", result: await generate(recoveryPayload, context, receipt) }; }
      catch (error) {
        if (error?.code === "provider_job_terminal_failed") return { status: "failed" };
        if (["provider_pending", "provider_job_terminal_unavailable"].includes(error?.code)) return { status: "pending" };
        throw error;
      }
    }
  };
}

// The existing workflow remains the image implementation; this adds its durable
// billing boundary without changing its response shape or accepting client keys.
export async function tryGenerateCreditedImage(payload, { run, getFile, resolveRuntimes, validateInput, runtime = aiCreditRuntime } = {}) {
  const session = currentAiTenantSession();
  if ((await runtime.mode(session)).mode !== "credits") return { handled: false };
  const count = Number(payload.imageCount ?? payload.count ?? 1);
  if (count !== 1) throw fail("积分图片当前仅支持单张生成，请逐张创建任务；批量能力尚未开通", "AI_CREDIT_CAPABILITY_DISABLED");
  const idempotencyKey = aiCreditOperationKey(payload);
  const configs = await resolveRuntimes();
  const requested = payload.imageRuntimeConfig || payload.runtimeConfig;
  const binding = await runtime.existingProvider?.(session, idempotencyKey);
  const original = binding && configs.find(item => aiImageCreditProviderIdentity(item) === binding.provider && item.imageModel === binding.model);
  const selected = original || (requested?.channelId ? configs.find(item => item.channelId === requested.channelId) : configs[0]);
  if (!selected) throw fail("原图片通道已停用，请联系平台管理员核查原任务", "AI_CREDIT_CHANNEL_UNAVAILABLE");
  // Input syntax and private reference ownership can fail before any supplier
  // attempt. Recovery must not require an old reference to remain available.
  if (!binding) await validateInput?.(payload);
  const input = imageInput(payload);
  const adapter = createAiCreditImageAdapter({ runtime: selected, run, getFile, recoveryPayload: input, notifyProviderJob: payload.onProviderJob });
  // Recovery uses the exact same canonical request, never a browser-supplied
  // providerJob/status URL. The executor verifies the original provider binding.
  const executed = await runtime.execute(session, { kind: "image", capability: "image", idempotencyKey, payload: input, provider: adapter });
  return { handled: true, result: await validateAiCreditImageResult(executed.result, { id: executed.task.id }, getFile) };
}

import fs from "node:fs/promises";
import path from "node:path";
import client, { assertOpenAiConfigured, getOpenAiConfigStatus } from "./openaiClient.js";
import { clampImageCount } from "./promptService.js";

export const ROOT_DIR = process.cwd();
export const GENERATED_ROOT = path.resolve(ROOT_DIR, process.env.AI_IMAGE_OUTPUT_DIR || "uploads/ai-generated");

const SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  // gpt-image-1 accepts closest supported portrait size through the Images API.
  "4:5": "1024x1536"
};

export async function generateOpenAiImages({ taskId, finalPrompt, ratio = "3:4", imageCount = 1 }) {
  assertOpenAiConfigured();
  const safeTaskId = validateTaskId(taskId);
  const count = clampImageCount(imageCount);
  const taskDir = resolveGeneratedTaskDir(safeTaskId);
  await fs.mkdir(taskDir, { recursive: true });

  const generatedImages = [];
  for (let index = 1; index <= count; index += 1) {
    const filename = `generated_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(taskDir, filename);
    const image = await client.images.generate({
      model: getOpenAiConfigStatus().imageModel,
      prompt: [String(finalPrompt || "").trim(), `Image ${index} of ${count}.`].filter(Boolean).join("\n"),
      n: 1,
      size: SIZE_BY_RATIO[ratio] || SIZE_BY_RATIO["3:4"]
    });
    const b64 = image.data?.[0]?.b64_json;
    if (!b64) {
      const error = new Error("OpenAI did not return base64 image data");
      error.status = 502;
      throw error;
    }
    await fs.writeFile(filePath, Buffer.from(b64, "base64"));
    generatedImages.push(createImageRecord(safeTaskId, "generated", filename, filePath));
  }

  return generatedImages;
}

export function createImageRecord(taskId, scope, filename, filePath) {
  return {
    filename,
    url: fileUrl(taskId, scope, filename),
    path: path.relative(ROOT_DIR, filePath).replace(/\\/g, "/")
  };
}

export function resolveGeneratedTaskDir(taskId) {
  return path.resolve(GENERATED_ROOT, validateTaskId(taskId));
}

export function resolveGeneratedImagePath(taskId, filename) {
  const root = resolveGeneratedTaskDir(taskId);
  const filePath = path.resolve(root, String(filename || "").replace(/\\/g, "/"));
  if (!filePath.startsWith(root)) {
    const error = new Error("Illegal generated image path");
    error.status = 400;
    throw error;
  }
  return filePath;
}

export function fileUrl(taskId, scope, filename) {
  return `/api/ai/file/${encodeURIComponent(taskId)}/${scope}/${String(filename).split("/").map(encodeURIComponent).join("/")}`;
}

export function validateTaskId(taskId) {
  const safeTaskId = String(taskId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(safeTaskId)) {
    const error = new Error("Invalid taskId");
    error.status = 400;
    throw error;
  }
  return safeTaskId;
}

import {
  cropImage,
  downloadAiZip,
  generateImage,
  optimizePrompt,
  sendAiTaskImage
} from "../../controllers/tools/aiImageGeneratorController.js";

export function createAiImageGeneratorRoutes({ readJson }) {
  return {
    "POST /api/tools/ai-image-generator/generate": (req) => generateImage(req, readJson),
    "POST /api/tools/ai-image-generator/crop": (req) => cropImage(req, readJson),
    "POST /api/tools/ai-image-generator/optimize-prompt": (req) => optimizePrompt(req, readJson)
  };
}

export async function handleAiImageGeneratorRestRoute({ req, res, parts, json, notFound, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "tools" || parts[2] !== "ai-image-generator") return false;

  try {
    if (req.method === "GET" && parts[3] === "file" && parts[4] && parts[5] && parts[6]) {
      return sendAiTaskImage({
        res,
        writeHead,
        taskId: decodeURIComponent(parts[4]),
        scope: decodeURIComponent(parts[5]),
        filename: parts.slice(6).map(decodeURIComponent).join("/")
      });
    }

    if (req.method === "GET" && parts[3] === "download-zip" && parts[4]) {
      return downloadAiZip({
        res,
        writeHead,
        taskId: decodeURIComponent(parts[4])
      });
    }
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }

  return notFound(res);
}

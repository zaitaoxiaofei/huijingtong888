import {
  downloadAiZip,
  generateCommerceCopyAction,
  generateImagesAction,
  generateWorkflowAction,
  optimizePromptAction,
  sendAiTaskImage,
  status,
  testCopyGenerationAction
} from "../controllers/aiImageController.js";

export function createAiImageRoutes({ readJson }) {
  return {
    "GET /api/ai/status": () => status(),
    "POST /api/ai/optimize-prompt": (req) => optimizePromptAction(req, readJson),
    "POST /api/ai/generate-commerce-copy": (req) => generateCommerceCopyAction(req, readJson),
    "POST /api/ai/copy-generation-test": (req) => testCopyGenerationAction(req, readJson),
    "POST /api/ai/generate-images": (req) => generateImagesAction(req, readJson),
    "POST /api/ai/generate-workflow": (req) => generateWorkflowAction(req, readJson)
  };
}

export async function handleAiImageRestRoute({ req, res, parts, json, notFound, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "ai") return false;

  try {
    if (req.method === "GET" && parts[2] === "file" && parts[3] && parts[4] && parts[5]) {
      return sendAiTaskImage({
        res,
        writeHead,
        taskId: decodeURIComponent(parts[3]),
        scope: decodeURIComponent(parts[4]),
        filename: parts.slice(5).map(decodeURIComponent).join("/")
      });
    }

    if (req.method === "GET" && parts[2] === "file" && parts[3] && parts[4]) {
      return sendAiTaskImage({
        res,
        writeHead,
        taskId: decodeURIComponent(parts[3]),
        scope: "generated",
        filename: parts.slice(4).map(decodeURIComponent).join("/")
      });
    }

    if (req.method === "GET" && parts[2] === "download-zip" && parts[3]) {
      return downloadAiZip({
        res,
        writeHead,
        taskId: decodeURIComponent(parts[3])
      });
    }
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }

  return false;
}

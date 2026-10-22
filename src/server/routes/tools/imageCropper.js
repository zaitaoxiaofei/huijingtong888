import {
  convertRatioImage,
  detectImage,
  downloadCrop,
  downloadEnhancedCrop,
  downloadEnhancedZip,
  downloadRatioCrop,
  downloadRatioZip,
  downloadWatermarkedCrop,
  downloadWatermarkedZip,
  downloadZip,
  enhanceImage,
  sendShopWatermark,
  sendTaskImage,
  uploadImage,
  uploadShopWatermark,
  watermarkImage
} from "../../controllers/tools/imageCropperController.js";

export function createImageCropperRoutes({ readJson }) {
  return {
    "POST /api/tools/image-cropper/upload": (req) => uploadImage(req),
    "POST /api/tools/image-cropper/detect": (req) => detectImage(req, readJson),
    "POST /api/tools/image-cropper/enhance": (req) => enhanceImage(req, readJson),
    "POST /api/tools/image-cropper/ratio-3x4": (req) => convertRatioImage(req, readJson),
    "POST /api/tools/image-cropper/watermark": (req) => watermarkImage(req, readJson)
  };
}

export async function handleImageCropperRestRoute({ req, res, parts, json, notFound, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "tools" || parts[2] !== "image-cropper") return false;

  try {
    if (req.method === "POST" && parts[3] === "shop-watermark" && parts[4]) {
      return json(res, await uploadShopWatermark(req, decodeURIComponent(parts[4])));
    }

    if (req.method === "GET") {
      if (parts[3] === "shop-watermark" && parts[4] && parts[5] === "file") {
        return sendShopWatermark({
          session: req._session,
          res,
          writeHead,
          shopId: decodeURIComponent(parts[4])
        });
      }

      if (parts[3] === "file" && parts[4] && parts[5]) {
        return sendTaskImage({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          filename: parts.slice(5).map(decodeURIComponent).join("/")
        });
      }

      if (parts[3] === "download" && parts[4] && parts[5]) {
        return downloadCrop({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          filename: parts.slice(5).map(decodeURIComponent).join("/")
        });
      }

      if (parts[3] === "download-enhanced" && parts[4] && parts[5]) {
        return downloadEnhancedCrop({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          filename: parts.slice(5).map(decodeURIComponent).join("/")
        });
      }

      if (parts[3] === "download-ratio-3x4" && parts[4] && parts[5]) {
        return downloadRatioCrop({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          filename: parts.slice(5).map(decodeURIComponent).join("/")
        });
      }

      if (parts[3] === "download-watermarked" && parts[4] && parts[5]) {
        return downloadWatermarkedCrop({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          filename: parts.slice(5).map(decodeURIComponent).join("/")
        });
      }

      if (parts[3] === "download-zip" && parts[4]) {
        return downloadZip({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          batch: parts[5] ? decodeURIComponent(parts[5]) : ""
        });
      }

      if (parts[3] === "download-enhanced-zip" && parts[4]) {
        return downloadEnhancedZip({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          batch: parts[5] ? decodeURIComponent(parts[5]) : ""
        });
      }

      if (parts[3] === "download-ratio-3x4-zip" && parts[4]) {
        return downloadRatioZip({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          batch: parts[5] ? decodeURIComponent(parts[5]) : ""
        });
      }

      if (parts[3] === "download-watermarked-zip" && parts[4]) {
        return downloadWatermarkedZip({
          session: req._session,
          res,
          writeHead,
          taskId: decodeURIComponent(parts[4]),
          batch: parts[5] ? decodeURIComponent(parts[5]) : ""
        });
      }

      return notFound(res);
    }
  } catch (error) {
    return json(res, { error: error.message }, error.status || 500);
  }

  return false;
}

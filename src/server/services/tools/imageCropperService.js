import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { mysqlExecute, mysqlQuery } from "../../../mysql-pool.js";
import { invalidateMasterDataCache } from "../../../services/mysql-cutover.js";

const ROOT_DIR = process.cwd();
const TEMP_ROOT = path.resolve(ROOT_DIR, "uploads", "temp", "image-cropper");
const PYTHON_SCRIPT = path.resolve(ROOT_DIR, "src", "server", "python", "image_cropper.py");
const PYTHON_ENHANCER_SCRIPT = path.resolve(ROOT_DIR, "src", "server", "python", "image_enhancer.py");
const PYTHON_RATIO_CANVAS_SCRIPT = path.resolve(ROOT_DIR, "src", "server", "python", "image_ratio_canvas.py");
const PYTHON_WATERMARK_SCRIPT = path.resolve(ROOT_DIR, "src", "server", "python", "image_watermarker.py");
const SHOP_WATERMARK_ROOT = path.resolve(ROOT_DIR, "uploads", "shop-watermarks");
const SHOP_WATERMARK_ROOTS = Array.from(new Set([
  SHOP_WATERMARK_ROOT,
  path.resolve(ROOT_DIR, "..", "..", "uploads", "shop-watermarks")
]));
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const imageCropperPaths = {
  tempRoot: TEMP_ROOT
};

export async function saveUploadedImage({ filename, contentType, buffer }) {
  const safeName = sanitizeFilename(filename || "upload.png");
  const extension = path.extname(safeName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(String(contentType || "").toLowerCase())) {
    const error = new Error("仅支持 jpg、jpeg、png、webp 图片");
    error.status = 415;
    throw error;
  }
  if (!buffer?.length) {
    const error = new Error("上传图片为空");
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error("图片不能超过 25MB");
    error.status = 413;
    throw error;
  }

  const taskId = crypto.randomUUID();
  const taskDir = resolveTaskDir(taskId);
  await fs.mkdir(path.join(taskDir, "crops"), { recursive: true });

  const imageName = `source${extension}`;
  const imagePath = path.join(taskDir, imageName);
  await fs.writeFile(imagePath, buffer);

  return {
    taskId,
    imagePath: toRelativeTempPath(imagePath),
    previewUrl: imageUrl(taskId, imageName),
    originalFilename: safeName,
    size: buffer.length,
    contentType
  };
}

export async function saveShopWatermark({ shopId, filename, contentType, buffer }) {
  const shop = await getShopForWatermark(shopId);
  if (!shop) {
    const error = new Error("店铺不存在");
    error.status = 404;
    throw error;
  }

  const safeName = sanitizeFilename(filename || "watermark.png");
  const extension = path.extname(safeName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(String(contentType || "").toLowerCase())) {
    const error = new Error("水印仅支持 jpg、jpeg、png、webp 图片");
    error.status = 415;
    throw error;
  }
  if (!buffer?.length) {
    const error = new Error("水印图片为空");
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error("水印图片不能超过 25MB");
    error.status = 413;
    throw error;
  }

  await fs.mkdir(SHOP_WATERMARK_ROOT, { recursive: true });
  const storedName = `shop-${Number(shop.id)}-${crypto.randomUUID()}${extension}`;
  const filePath = path.join(SHOP_WATERMARK_ROOT, storedName);
  await fs.writeFile(filePath, buffer);
  await updateShopWatermark(shop.id, storedName, safeName);

  return {
    ok: true,
    shopId: Number(shop.id),
    watermark_path: toWatermarkReference(storedName),
    watermark_name: safeName,
    has_watermark: true
  };
}

export async function detectAndCropImage({
  taskId,
  imagePath,
  mode = "auto",
  rows = 0,
  cols = 0,
  trimBorder = 2,
  backgroundColor = "auto",
  threshold = 245,
  minAreaRatio = 0.03,
  mergeDistance = 20,
  padding = 4,
  roundCornerTolerance = true,
  manualBoxes = []
}) {
  const taskDir = resolveTaskDir(taskId);
  const sourcePath = resolveTempPath(imagePath);
  if (!sourcePath.startsWith(taskDir)) {
    const error = new Error("图片路径与任务不匹配");
    error.status = 400;
    throw error;
  }

  const batch = createBatchName("split");
  const outputDir = path.join(taskDir, "crops", batch);
  await fs.mkdir(outputDir, { recursive: true });

  const result = await runPythonCropper(sourcePath, outputDir, taskId, {
    mode,
    rows,
    cols,
    trimBorder,
    backgroundColor,
    threshold,
    minAreaRatio,
    mergeDistance,
    padding,
    roundCornerTolerance,
    manualBoxes
  });
  const crops = result.crops.map((crop) => ({
    ...crop,
    filename: scopedFilename(batch, crop.filename),
    url: imageUrl(taskId, `crops/${scopedFilename(batch, crop.filename)}`),
    downloadUrl: downloadRoute("download", taskId, scopedFilename(batch, crop.filename))
  }));

  return {
    taskId,
    image: {
      width: result.image?.width || 0,
      height: result.image?.height || 0
    },
    boxes: crops.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    crops,
    zipUrl: scopedZipRoute("download-zip", taskId, batch)
  };
}

export async function enhanceTaskCrops({ taskId, filenames = [] }) {
  const taskDir = resolveTaskDir(taskId);
  const input = await chooseInputDir(taskDir, filenames);
  const batch = createBatchName("enhanced");
  const enhancedDir = path.join(taskDir, "enhanced", batch);
  await fs.mkdir(enhancedDir, { recursive: true });

  const result = await runPythonEnhancer(input.dir, enhancedDir, taskId, input.filenames);
  const images = result.images.map((image) => ({
    ...image,
    filename: scopedFilename(batch, image.filename),
    url: imageUrl(taskId, `enhanced/${scopedFilename(batch, image.filename)}`),
    downloadUrl: downloadRoute("download-enhanced", taskId, scopedFilename(batch, image.filename))
  }));

  return {
    taskId,
    images,
    crops: images.map((image, index) => ({
      id: image.id || `enhanced-${String(index + 1).padStart(3, "0")}`,
      filename: image.filename,
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      url: image.url,
      downloadUrl: image.downloadUrl
    })),
    zipUrl: scopedZipRoute("download-enhanced-zip", taskId, batch)
  };
}

export async function convertTaskCropsToRatio({ taskId, filenames = [] }) {
  const taskDir = resolveTaskDir(taskId);
  const input = await chooseInputDir(taskDir, filenames);
  const batch = createBatchName("ratio");
  const ratioDir = path.join(taskDir, "ratio-3x4", batch);
  await fs.mkdir(ratioDir, { recursive: true });

  const result = await runPythonRatioCanvas(input.dir, ratioDir, taskId, input.filenames);
  const images = result.images.map((image) => ({
    ...image,
    filename: scopedFilename(batch, image.filename),
    url: imageUrl(taskId, `ratio-3x4/${scopedFilename(batch, image.filename)}`),
    downloadUrl: downloadRoute("download-ratio-3x4", taskId, scopedFilename(batch, image.filename))
  }));

  return {
    taskId,
    images,
    crops: images.map((image, index) => ({
      id: image.id || `ratio-3x4-${String(index + 1).padStart(3, "0")}`,
      filename: image.filename,
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      url: image.url,
      downloadUrl: image.downloadUrl
    })),
    zipUrl: scopedZipRoute("download-ratio-3x4-zip", taskId, batch)
  };
}

export async function watermarkTaskCrops({ taskId, shopId, filenames = [], options = {} }) {
  const shop = await getShopForWatermark(shopId);
  const watermark = await getWatermarkFileForShop(shop);

  const taskDir = resolveTaskDir(taskId);
  const input = await chooseInputDir(taskDir, filenames);
  const batch = createBatchName("watermarked");
  const watermarkedDir = path.join(taskDir, "watermarked", batch);
  await fs.mkdir(watermarkedDir, { recursive: true });

  const watermarkOptions = normalizeWatermarkOptions({ ...shopWatermarkDefaults(shop), ...options });
  const result = await runPythonWatermarker(input.dir, watermarkedDir, watermark.filePath, taskId, input.filenames, watermarkOptions);
  const images = result.images.map((image) => ({
    ...image,
    filename: scopedFilename(batch, image.filename),
    url: imageUrl(taskId, `watermarked/${scopedFilename(batch, image.filename)}`),
    downloadUrl: downloadRoute("download-watermarked", taskId, scopedFilename(batch, image.filename))
  }));

  return {
    taskId,
    shop: { id: Number(shop.id), name: shop.name || "", watermark_name: shop.watermark_name || "" },
    options: watermarkOptions,
    images,
    crops: images.map((image, index) => ({
      id: image.id || `watermarked-${String(index + 1).padStart(3, "0")}`,
      filename: image.filename,
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      url: image.url,
      downloadUrl: image.downloadUrl
    })),
    zipUrl: scopedZipRoute("download-watermarked-zip", taskId, batch)
  };
}

export async function getShopWatermarkFile(shopId) {
  const shop = await getShopForWatermark(shopId);
  return getWatermarkFileForShop(shop);
}

export async function getTaskFile(taskId, filename) {
  const taskDir = resolveTaskDir(taskId);
  const filePath = path.resolve(taskDir, filename);
  if (!filePath.startsWith(taskDir)) {
    const error = new Error("非法文件路径");
    error.status = 400;
    throw error;
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    const error = new Error("文件不存在");
    error.status = 404;
    throw error;
  }

  return {
    filePath,
    filename: path.basename(filePath),
    size: stat.size,
    contentType: contentTypeFor(filePath)
  };
}

export async function createTaskZip(taskId, batch = "") {
  const taskDir = resolveTaskDir(taskId);
  const cropsDir = resolveScopedOutputDir(taskDir, "crops", batch);
  const imageEntries = await listImageFiles(cropsDir);

  if (!imageEntries.length) {
    const error = new Error("没有可下载的裁切图片");
    error.status = 404;
    throw error;
  }

  const files = await Promise.all(imageEntries.map(async (entry) => {
    const filePath = path.join(cropsDir, entry);
    return {
      name: path.basename(entry),
      data: await fs.readFile(filePath)
    };
  }));

  return {
    filename: `image-cropper-${taskId}.zip`,
    buffer: buildZip(files)
  };
}

export async function createEnhancedTaskZip(taskId, batch = "") {
  if (batch) {
    return createScopedTaskZip({
      taskId,
      scope: "enhanced",
      batch,
      errorMessage: "娌℃湁鍙笅杞界殑澧炲己鍥剧墖",
      filenamePrefix: "image-cropper-enhanced"
    });
  }
  const taskDir = resolveTaskDir(taskId);
  const enhancedDir = path.join(taskDir, "enhanced");
  const entries = await fs.readdir(enhancedDir).catch(() => []);
  const imageEntries = entries
    .filter((entry) => ALLOWED_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

  if (!imageEntries.length) {
    const error = new Error("没有可下载的增强图片");
    error.status = 404;
    throw error;
  }

  const files = await Promise.all(imageEntries.map(async (entry) => {
    const filePath = path.join(enhancedDir, entry);
    return {
      name: entry,
      data: await fs.readFile(filePath)
    };
  }));

  return {
    filename: `image-cropper-enhanced-${taskId}.zip`,
    buffer: buildZip(files)
  };
}

export async function createRatioTaskZip(taskId, batch = "") {
  return createScopedTaskZip({
    taskId,
    scope: "ratio-3x4",
    batch,
    errorMessage: "没有可下载的 3:4 图片",
    filenamePrefix: "image-cropper-3x4"
  });
}

export async function createWatermarkedTaskZip(taskId, batch = "") {
  return createScopedTaskZip({
    taskId,
    scope: "watermarked",
    batch,
    errorMessage: "没有可下载的水印图片",
    filenamePrefix: "image-cropper-watermarked"
  });
}

export function streamFile(filePath) {
  return createReadStream(filePath);
}

export function runPythonCropper(sourcePath, outputDir, taskId, options = {}) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || process.env.PYTHON_BIN || "python";
    const args = [
      PYTHON_SCRIPT,
      "--input", sourcePath,
      "--output", outputDir,
      "--task-id", taskId,
      "--mode", options.mode || "auto",
      "--rows", String(options.rows || 0),
      "--cols", String(options.cols || 0),
      "--trim-border", String(options.trimBorder ?? 2),
      "--background-color", String(options.backgroundColor || "auto"),
      "--threshold", String(options.threshold ?? 245),
      "--min-area-ratio", String(options.minAreaRatio ?? 0.03),
      "--merge-distance", String(options.mergeDistance ?? 20),
      "--padding", String(options.padding ?? 4),
      "--round-corner-tolerance", options.roundCornerTolerance === false ? "0" : "1",
      "--manual-boxes", JSON.stringify(Array.isArray(options.manualBoxes) ? options.manualBoxes : [])
    ];
    const child = spawn(python, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Python 启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python 裁切脚本执行失败，退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Python 返回结果解析失败：${error.message}`));
      }
    });
  });
}

export function runPythonEnhancer(inputDir, outputDir, taskId, filenames = []) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || process.env.PYTHON_BIN || "python";
    const args = [
      PYTHON_ENHANCER_SCRIPT,
      "--input-dir", inputDir,
      "--output", outputDir,
      "--task-id", taskId,
      "--filenames", JSON.stringify(Array.isArray(filenames) ? filenames : [])
    ];
    const child = spawn(python, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Python 启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python 图片增强脚本执行失败，退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Python 返回结果解析失败：${error.message}`));
      }
    });
  });
}

export function runPythonRatioCanvas(inputDir, outputDir, taskId, filenames = []) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || process.env.PYTHON_BIN || "python";
    const args = [
      PYTHON_RATIO_CANVAS_SCRIPT,
      "--input-dir", inputDir,
      "--output", outputDir,
      "--task-id", taskId,
      "--filenames", JSON.stringify(Array.isArray(filenames) ? filenames : [])
    ];
    const child = spawn(python, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Python 启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python 3:4 画布脚本执行失败，退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Python 返回结果解析失败：${error.message}`));
      }
    });
  });
}

export function runPythonWatermarker(inputDir, outputDir, watermarkPath, taskId, filenames = [], options = {}) {
  const safeOptions = {
    position: options.position || "bottom-right",
    scale: Number(options.scale || 0.22),
    opacity: Number(options.opacity || 0.82),
    xPercent: Number(options.xPercent ?? 75),
    yPercent: Number(options.yPercent ?? 75)
  };
  return runPythonImageProcess(PYTHON_WATERMARK_SCRIPT, [
    "--input-dir", inputDir,
    "--output", outputDir,
    "--watermark", watermarkPath,
    "--task-id", taskId,
    "--filenames", JSON.stringify(Array.isArray(filenames) ? filenames : []),
    "--position", safeOptions.position,
    "--scale", String(safeOptions.scale),
    "--opacity", String(safeOptions.opacity),
    "--x-percent", String(safeOptions.xPercent),
    "--y-percent", String(safeOptions.yPercent)
  ], "Python 水印脚本执行失败");
}

async function chooseInputDir(taskDir, filenames) {
  const names = normalizeCropFilenames(filenames);
  const candidates = ["watermarked", "enhanced", "ratio-3x4", "crops"];

  for (const scope of candidates) {
    const root = path.join(taskDir, scope);
    if (names.length) {
      const groups = new Map();
      for (const name of names) {
        const filePath = path.join(root, name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile()) continue;
        const groupDir = path.dirname(name).replace(/\\/g, "/");
        const basename = path.basename(name);
        const list = groups.get(groupDir) || [];
        list.push(basename);
        groups.set(groupDir, list);
      }
      if (groups.size) {
        const [groupDir, groupNames] = [...groups.entries()][0];
        return {
          dir: path.join(root, groupDir),
          filenames: groupNames
        };
      }
    }

    const latestDir = await latestImageDirectory(root);
    if (latestDir) return { dir: latestDir, filenames: [] };
  }

  return { dir: path.join(taskDir, "crops"), filenames: [] };
}

function runPythonImageProcess(scriptPath, args, fallbackMessage) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || process.env.PYTHON_BIN || "python";
    const child = spawn(python, [scriptPath, ...args], {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Python 启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${fallbackMessage}，退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Python 返回结果解析失败：${error.message}`));
      }
    });
  });
}

async function getShopForWatermark(shopId) {
  const id = Number(shopId);
  if (!Number.isInteger(id) || id <= 0) return null;
  await ensureMysqlShopWatermarkColumns();
  return (await mysqlQuery(`
    SELECT id, name, watermark_path, watermark_name,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent
    FROM shops
    WHERE id = ? AND status != 'deleted'
    LIMIT 1
  `, [id]))[0] || null;
}

async function updateShopWatermark(shopId, storedName, originalName) {
  const relativePath = toWatermarkReference(storedName);
  await ensureMysqlShopWatermarkColumns();
  await mysqlExecute("UPDATE shops SET watermark_path = ?, watermark_name = ? WHERE id = ?", [relativePath, originalName, Number(shopId)]);
  invalidateMasterDataCache("shops");
}

let mysqlShopWatermarkColumnsReady = false;

async function ensureMysqlShopWatermarkColumns() {
  if (mysqlShopWatermarkColumnsReady) return;
  for (const sql of [
    "ALTER TABLE shops ADD COLUMN watermark_path TEXT NULL",
    "ALTER TABLE shops ADD COLUMN watermark_name VARCHAR(255) NULL",
    "ALTER TABLE shops ADD COLUMN watermark_position VARCHAR(32) NOT NULL DEFAULT 'bottom-right'",
    "ALTER TABLE shops ADD COLUMN watermark_x_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_y_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_scale_percent DECIMAL(8,4) NOT NULL DEFAULT 22.0000",
    "ALTER TABLE shops ADD COLUMN watermark_opacity_percent DECIMAL(8,4) NOT NULL DEFAULT 82.0000"
  ]) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  mysqlShopWatermarkColumnsReady = true;
}

function toWatermarkReference(filename) {
  return `shop-watermarks/${filename}`;
}

function resolveShopWatermarkPath(reference) {
  const clean = String(reference || "").replace(/\\/g, "/");
  if (!clean.startsWith("shop-watermarks/")) return "";
  return resolveShopWatermarkPaths(reference)[0] || "";
}

function resolveShopWatermarkPaths(reference) {
  const clean = String(reference || "").replace(/\\/g, "/");
  if (!clean.startsWith("shop-watermarks/")) return [];
  const filename = path.basename(clean);
  if (!filename || filename !== clean.slice("shop-watermarks/".length)) return [];
  return SHOP_WATERMARK_ROOTS
    .map((root) => path.resolve(root, filename))
    .filter((absolutePath, index, list) => isPathInside(absolutePath, SHOP_WATERMARK_ROOTS[index]) && list.indexOf(absolutePath) === index);
}

function isPathInside(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function getWatermarkFileForShop(shop) {
  if (!shop) {
    const error = new Error("店铺不存在");
    error.status = 404;
    throw error;
  }
  const candidates = resolveShopWatermarkPaths(shop.watermark_path);
  if (!candidates.length) {
    const error = new Error("该店铺还没有配置水印");
    error.status = 400;
    throw error;
  }
  let filePath = "";
  let stat = null;
  for (const candidate of candidates) {
    const candidateStat = await fs.stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      filePath = candidate;
      stat = candidateStat;
      break;
    }
  }
  if (!filePath || !stat) {
    const error = new Error("店铺水印素材不存在，请重新上传");
    error.status = 404;
    throw error;
  }
  return {
    filePath,
    filename: shop.watermark_name || path.basename(filePath),
    size: stat.size,
    contentType: contentTypeFor(filePath)
  };
}

function normalizeWatermarkOptions(options = {}) {
  const positions = new Set(["top-left", "top-right", "bottom-left", "bottom-right", "center", "custom"]);
  const scalePercent = Number(options.scalePercent ?? options.scale_percent ?? options.scale ?? 22);
  const opacityPercent = Number(options.opacityPercent ?? options.opacity_percent ?? options.opacity ?? 82);
  const position = positions.has(String(options.position || "")) ? String(options.position) : "bottom-right";
  return {
    position,
    scale: clampNumber(scalePercent, 8, 45) / 100,
    opacity: clampNumber(opacityPercent, 10, 100) / 100,
    xPercent: clampNumber(Number(options.xPercent ?? options.x_percent ?? options.leftPercent ?? options.left_percent ?? options.x ?? 75), 0, 100),
    yPercent: clampNumber(Number(options.yPercent ?? options.y_percent ?? options.topPercent ?? options.top_percent ?? options.y ?? 75), 0, 100)
  };
}

function shopWatermarkDefaults(shop = {}) {
  return {
    position: shop.watermark_position || "bottom-right",
    xPercent: Number(shop.watermark_x_percent ?? 75),
    yPercent: Number(shop.watermark_y_percent ?? 75),
    scalePercent: Number(shop.watermark_scale_percent ?? 22),
    opacityPercent: Number(shop.watermark_opacity_percent ?? 82)
  };
}

function clampNumber(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

async function createScopedTaskZip({ taskId, scope, batch = "", errorMessage, filenamePrefix }) {
  const taskDir = resolveTaskDir(taskId);
  const scopedDir = resolveScopedOutputDir(taskDir, scope, batch);
  const imageEntries = await listImageFiles(scopedDir);

  if (!imageEntries.length) {
    const error = new Error(errorMessage);
    error.status = 404;
    throw error;
  }

  const files = await Promise.all(imageEntries.map(async (entry) => {
    const filePath = path.join(scopedDir, entry);
    return {
      name: path.basename(entry),
      data: await fs.readFile(filePath)
    };
  }));

  return {
    filename: `${filenamePrefix}-${taskId}.zip`,
    buffer: buildZip(files)
  };
}

function normalizeCropFilenames(filenames) {
  const list = Array.isArray(filenames) ? filenames : [];
  return list
    .map((item) => normalizeRelativeImagePath(item))
    .filter((item) => item && ALLOWED_EXTENSIONS.has(path.extname(item).toLowerCase()))
    .slice(0, 60);
}

function normalizeRelativeImagePath(value) {
  const parts = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => sanitizePathPart(part))
    .filter(Boolean);
  if (!parts.length) return "";
  return parts.slice(-2).join("/");
}

function sanitizePathPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function createBatchName(prefix) {
  return `${sanitizePathPart(prefix)}-${crypto.randomUUID().slice(0, 12)}`;
}

function scopedFilename(batch, filename) {
  return `${sanitizePathPart(batch)}/${path.basename(String(filename || ""))}`;
}

function downloadRoute(route, taskId, filename) {
  return `/api/tools/image-cropper/${route}/${encodeURIComponent(taskId)}/${encodeURIComponent(filename)}`;
}

function scopedZipRoute(route, taskId, batch) {
  return `/api/tools/image-cropper/${route}/${encodeURIComponent(taskId)}/${encodeURIComponent(batch)}`;
}

function resolveScopedOutputDir(taskDir, scope, batch = "") {
  const root = path.join(taskDir, scope);
  if (!batch) return root;
  const cleanBatch = normalizeRelativeImagePath(batch);
  const dir = path.resolve(root, cleanBatch);
  if (!dir.startsWith(root)) {
    const error = new Error("闈炴硶鏂囦欢璺緞");
    error.status = 400;
    throw error;
  }
  return dir;
}

async function listImageFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      const nested = await listImageFiles(path.join(dir, entry.name));
      files.push(...nested.map((item) => `${entry.name}/${item}`));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

async function latestImageDirectory(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const directFiles = entries.filter((entry) => entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  if (directFiles.length) return root;

  const dirs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const dir = path.join(root, entry.name);
      const files = await listImageFiles(dir);
      const stat = files.length ? await fs.stat(dir).catch(() => null) : null;
      return files.length ? { dir, time: stat?.mtimeMs || 0 } : null;
    }));
  return dirs.filter(Boolean).sort((a, b) => b.time - a.time)[0]?.dir || "";
}

function resolveTaskDir(taskId) {
  const safeTaskId = String(taskId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(safeTaskId)) {
    const error = new Error("无效 taskId");
    error.status = 400;
    throw error;
  }
  const taskDir = path.resolve(TEMP_ROOT, safeTaskId);
  if (!taskDir.startsWith(TEMP_ROOT)) {
    const error = new Error("非法任务路径");
    error.status = 400;
    throw error;
  }
  return taskDir;
}

function resolveTempPath(relativePath) {
  const clean = String(relativePath || "").replace(/\\/g, "/");
  const absolutePath = path.resolve(TEMP_ROOT, clean);
  if (!absolutePath.startsWith(TEMP_ROOT)) {
    const error = new Error("非法图片路径");
    error.status = 400;
    throw error;
  }
  return absolutePath;
}

function toRelativeTempPath(filePath) {
  return path.relative(TEMP_ROOT, filePath).replace(/\\/g, "/");
}

function imageUrl(taskId, filename) {
  return `/api/tools/image-cropper/file/${encodeURIComponent(taskId)}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

function sanitizeFilename(filename) {
  return String(filename).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 120);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

export function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

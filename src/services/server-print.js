import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { degrees, PDFDocument } from "pdf-lib";

const PRINT_JOB_RETENTION = 100;
const DEFAULT_LABEL_PRINTER = process.env.OZON_LABEL_PRINTER || "Gprinter GP-1324D";
const DEFAULT_DOCUMENT_PRINTER = process.env.OZON_DOCUMENT_PRINTER || "Canon MG2500 series Printer";
const MM_TO_PT = 72 / 25.4;
const LABEL_PAPER_SIZES = [
  { value: "order_label_72x130", widthMm: 72, heightMm: 130, paperName: "72mm x 130mm", rotateLandscape: true, fillPaper: true, aliases: ["72mm x 130mm", "72x130", "72*130", "order_label_76x130", "76mm x 130mm", "76x130", "76*130"] },
  { value: "fbp_label_72x130", widthMm: 72, heightMm: 130, paperName: "72mm x 130mm", rotateLandscape: true, fillPaper: true, aliases: ["72mm x 130mm", "72x130", "72*130"] },
  { value: "barcode_70x30", widthMm: 70, heightMm: 30, paperName: "70mm*30mm", aliases: ["70mm x 30mm", "70mm*30mm", "70x30", "70*30"] }
];

const jobs = [];
let queue = Promise.resolve();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
    const child = spawn(command, args, { windowsHide: true, ...options });
    let settled = false;
    let timer = null;
    let stdout = "";
    let stderr = "";
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch {}
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function findSumatraPdf() {
  const candidates = [
    process.env.SUMATRA_PDF_PATH,
    path.resolve("tools", "SumatraPDF.exe"),
    path.resolve("tools", "sumatra", "SumatraPDF.exe"),
    "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe"
  ].filter(Boolean);
  return candidates.find((file) => {
    try { return fs.existsSync(file); } catch { return false; }
  }) || "";
}

function normalizePrinterName(value) {
  return String(value || "").trim();
}

function printerForRole(roleOrName = "label") {
  const normalized = String(roleOrName || "label").trim().toLowerCase();
  if (normalized === "label" || normalized === "labels" || normalized === "shipping-label") return DEFAULT_LABEL_PRINTER;
  if (normalized === "document" || normalized === "a4" || normalized === "ink") return DEFAULT_DOCUMENT_PRINTER;
  return normalizePrinterName(roleOrName);
}

function safeFilename(value = "print-job.pdf") {
  const normalized = String(value || "print-job.pdf").replace(/[^\w.-]+/g, "-").slice(0, 80) || "print-job.pdf";
  return normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized}.pdf`;
}

function rememberJob(job) {
  jobs.unshift(job);
  if (jobs.length > PRINT_JOB_RETENTION) jobs.length = PRINT_JOB_RETENTION;
  return job;
}

function paperKey(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/毫米/g, "mm").replace(/[×*]/g, "x");
}

function paperSpecByValue(value = "") {
  const key = paperKey(value);
  if (!key) return null;
  return LABEL_PAPER_SIZES.find((item) => {
    if (paperKey(item.value) === key || paperKey(item.paperName) === key) return true;
    return item.aliases.some((alias) => paperKey(alias) === key);
  }) || null;
}

function paperSpecFromPrintSettings(printSettings = "") {
  const match = String(printSettings || "").match(/(?:^|,)paper=([^,]+)/i);
  return paperSpecByValue(match?.[1] || "");
}

function normalizePaperSetting(printSettings = "") {
  return String(printSettings || "")
    .split(",")
    .map((item) => {
      const trimmed = item.trim();
      const match = trimmed.match(/^paper=(.+)$/i);
      if (!match) return trimmed;
      const spec = paperSpecByValue(match[1]);
      return spec ? `paper=${spec.paperName}` : trimmed;
    })
    .filter(Boolean)
    .join(",");
}

function normalizeLabelPrintSettings(printSettings = "", paperSpec = null) {
  const normalized = normalizePrintSettings(printSettings) || "fit";
  if (!paperSpec) return normalized;
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !["portrait", "landscape"].includes(item.toLowerCase()))
    .join(",") || "noscale";
}

function resolveJobPaperSpec({ paperSize = "", printSettings = "", meta = {} } = {}) {
  return paperSpecByValue(paperSize)
    || paperSpecByValue(meta?.paper_size || meta?.paperSize || meta?.label_size || meta?.labelSize || meta?.preset)
    || paperSpecFromPrintSettings(printSettings);
}

function normalizePrintSettings(value = "") {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const allowed = new Set([
    "fit",
    "shrink",
    "noscale",
    "portrait",
    "landscape",
    "simplex",
    "duplex",
    "duplexshort",
    "duplexlong",
    "color",
    "monochrome",
    "odd",
    "even"
  ]);
  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const lower = item.toLowerCase();
      if (allowed.has(lower)) return true;
      if (/^paper=[\w .\-()*]+$/i.test(item)) return true;
      if (/^bin=[\w .\-()]+$/i.test(item)) return true;
      if (/^\d+(-\d+)?$/.test(item)) return true;
      return false;
    });
  return parts.join(",");
}

function normalizeCopies(value = 1) {
  const copies = Math.round(Number(value || 1));
  return Math.min(999, Math.max(1, Number.isFinite(copies) ? copies : 1));
}

function createJob({ source = "manual", printer = "label", printSettings = "fit", copies = 1, filename = "print-job.pdf", userId = null, meta = {}, paperSize = "" }) {
  const normalizedSettings = normalizePaperSetting(printSettings);
  const paperSpec = resolveJobPaperSpec({ paperSize, printSettings: normalizedSettings, meta });
  return rememberJob({
    id: `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    printer: printerForRole(printer),
    printer_role: printer,
    print_settings: normalizeLabelPrintSettings(normalizedSettings, paperSpec),
    copies: normalizeCopies(copies),
    filename: safeFilename(filename),
    user_id: userId,
    meta: {
      ...meta,
      paper_size: paperSpec?.value || meta?.paper_size || meta?.paperSize || ""
    },
    status: "queued",
    error: "",
    created_at: new Date().toISOString(),
    started_at: "",
    finished_at: ""
  });
}

async function getWindowsPrinters() {
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$printers = Get-Printer | Select-Object Name,DriverName,PortName,Shared,ShareName,PrinterStatus,Default",
    "$printers | ConvertTo-Json -Compress"
  ].join("; ");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function serverPrintPrinters() {
  const printers = process.platform === "win32" ? await getWindowsPrinters() : [];
  const installedNames = new Set(printers.map((printer) => String(printer.Name || "")));
  const labelPrinter = DEFAULT_LABEL_PRINTER;
  const documentPrinter = DEFAULT_DOCUMENT_PRINTER;
  return {
    ok: true,
    platform: process.platform,
    sumatra: process.platform === "win32" ? Boolean(findSumatraPdf()) : false,
    roles: {
      label: {
        printer: labelPrinter,
        installed: installedNames.has(labelPrinter)
      },
      document: {
        printer: documentPrinter,
        installed: installedNames.has(documentPrinter)
      }
    },
    printers
  };
}

function assertPrintablePdf(buffer, printerName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("没有可打印的 PDF 文件");
  if (!printerName) throw new Error("缺少打印机名称");
  if (process.platform !== "win32") throw new Error(`服务器端打印暂时只支持 Windows，当前平台：${process.platform}`);
}

async function printPdfFileWindows(pdfPath, printerName, printSettings = "fit") {
  const sumatra = findSumatraPdf();
  if (!sumatra) {
    throw new Error("服务器缺少 SumatraPDF，无法稳定指定打印机。请安装 SumatraPDF，或把 SumatraPDF.exe 放到项目 tools 目录。");
  }
  const args = ["-silent", "-print-to", printerName];
  const normalizedSettings = normalizePrintSettings(printSettings);
  if (normalizedSettings) args.push("-print-settings", normalizedSettings);
  args.push(pdfPath);
  await run(sumatra, args, { timeoutMs: 30_000 });
}

async function resizePdfToPaper(pdfBuffer, paperSpec) {
  if (!paperSpec) return pdfBuffer;
  const source = await PDFDocument.load(pdfBuffer);
  const output = await PDFDocument.create();
  const targetWidth = paperSpec.widthMm * MM_TO_PT;
  const targetHeight = paperSpec.heightMm * MM_TO_PT;
  for (const sourcePage of source.getPages()) {
    const { width: sourceWidth, height: sourceHeight } = sourcePage.getSize();
    const targetPage = output.addPage([targetWidth, targetHeight]);
    const shouldRotate = Boolean(paperSpec.rotateLandscape && sourceWidth > sourceHeight && targetHeight > targetWidth);
    const cropBox = paperSpec.fillPaper
      ? coverCropBox(sourceWidth, sourceHeight, shouldRotate ? targetHeight / targetWidth : targetWidth / targetHeight)
      : { left: 0, bottom: 0, right: sourceWidth, top: sourceHeight };
    const cropWidth = cropBox.right - cropBox.left;
    const cropHeight = cropBox.top - cropBox.bottom;
    const embedded = await output.embedPage(sourcePage, cropBox);
    const sourceBoxWidth = shouldRotate ? cropHeight : cropWidth;
    const sourceBoxHeight = shouldRotate ? cropWidth : cropHeight;
    const scale = Math.min(targetWidth / sourceBoxWidth, targetHeight / sourceBoxHeight);
    const drawWidth = cropWidth * scale;
    const drawHeight = cropHeight * scale;
    const visualWidth = sourceBoxWidth * scale;
    const visualHeight = sourceBoxHeight * scale;
    const visualX = (targetWidth - visualWidth) / 2;
    const visualY = (targetHeight - visualHeight) / 2;
    if (shouldRotate) {
      targetPage.drawPage(embedded, {
        x: visualX + drawHeight,
        y: visualY,
        width: drawWidth,
        height: drawHeight,
        rotate: degrees(90)
      });
    } else {
      targetPage.drawPage(embedded, {
        x: visualX,
        y: visualY,
        width: drawWidth,
        height: drawHeight
      });
    }
  }
  return Buffer.from(await output.save());
}

function coverCropBox(sourceWidth, sourceHeight, targetAspect) {
  const sourceAspect = sourceWidth / sourceHeight;
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) {
    return { left: 0, bottom: 0, right: sourceWidth, top: sourceHeight };
  }
  if (sourceAspect > targetAspect) {
    const nextWidth = sourceHeight * targetAspect;
    const inset = (sourceWidth - nextWidth) / 2;
    return { left: inset, bottom: 0, right: sourceWidth - inset, top: sourceHeight };
  }
  const nextHeight = sourceWidth / targetAspect;
  const inset = (sourceHeight - nextHeight) / 2;
  return { left: 0, bottom: inset, right: sourceWidth, top: sourceHeight - inset };
}

async function executePdfJob(job, pdfBuffer) {
  assertPrintablePdf(pdfBuffer, job.printer);
  const paperSpec = paperSpecByValue(job.meta?.paper_size);
  const printableBuffer = paperSpec ? await resizePdfToPaper(pdfBuffer, paperSpec) : pdfBuffer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ozon-print-"));
  const pdfPath = path.join(dir, job.filename);
  fs.writeFileSync(pdfPath, printableBuffer);
  try {
    for (let index = 0; index < job.copies; index += 1) {
      await printPdfFileWindows(pdfPath, job.printer, job.print_settings);
    }
  } finally {
    const cleanupTimer = setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 5 * 60_000);
    cleanupTimer.unref?.();
  }
}

function enqueue(job, task) {
  const runJob = async () => {
    job.status = "printing";
    job.started_at = new Date().toISOString();
    try {
      const result = await task(job);
      job.status = "printed";
      job.finished_at = new Date().toISOString();
      return { ...job, result };
    } catch (error) {
      job.status = "failed";
      job.error = error?.message || String(error);
      job.finished_at = new Date().toISOString();
      const printableError = error instanceof Error ? error : new Error(job.error);
      printableError.print_job = job;
      printableError.validation = { print_job: job };
      throw printableError;
    }
  };
  const next = queue.then(runJob, runJob);
  queue = next.catch(() => {});
  return next;
}

export async function serverPrintPdf(body = {}, userId = null) {
  const pdfBase64 = String(body.pdf_base64 || "");
  const job = createJob({
    source: body.source || "manual",
    printer: body.printer || body.printer_role || "label",
    printSettings: body.print_settings || body.printSettings || "fit",
    copies: body.copies || 1,
    filename: body.filename || "print-job.pdf",
    userId,
    meta: {
      ...(body.meta || {}),
      paper_size: body.paper_size || body.paperSize || body.label_size || body.labelSize || body.preset || body.meta?.paper_size || ""
    },
    paperSize: body.paper_size || body.paperSize || body.label_size || body.labelSize || body.preset || ""
  });
  const pdfBuffer = Buffer.from(pdfBase64, "base64");
  return enqueue(job, (activeJob) => executePdfJob(activeJob, pdfBuffer));
}

export async function serverPrintOrderLabels(body = {}, userId = null, services) {
  const label = await services.orderPackageLabel({
    order_ids: body.order_ids,
    posting_numbers: body.posting_numbers,
    require_all: body.require_all,
    allow_partial: body.allow_partial,
    refresh_cache: body.refresh_cache
  }, userId);
  const job = createJob({
    source: "order-label",
    printer: body.printer || "label",
    printSettings: body.print_settings || body.printSettings || "fit",
    copies: body.copies || 1,
    filename: label.filename || "ozon-labels.pdf",
    userId,
    meta: {
      order_ids: label.printed_ids || [],
      requested: label.requested,
      count: label.count,
      paper_size: body.paper_size || body.paperSize || body.label_size || body.labelSize || body.preset || ""
    },
    paperSize: body.paper_size || body.paperSize || body.label_size || body.labelSize || body.preset || ""
  });
  const printedJob = await enqueue(job, (activeJob) => executePdfJob(activeJob, label.buffer));
  if (label.printed_ids?.length) {
    await services.markOrderLabelsPrinted({ order_ids: label.printed_ids }, userId);
  }
  return {
    ok: true,
    job: printedJob,
    count: label.count || 0,
    requested: label.requested || 0,
    printed_ids: label.printed_ids || [],
    failures: label.failures || [],
    stats: label.stats || {}
  };
}

export function serverPrintJobs() {
  return { ok: true, jobs };
}

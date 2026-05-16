import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.OZON_PRINT_HELPER_PORT || 17878);
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 80 * 1024 * 1024;

function allowedOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return "*";
  try {
    const { hostname } = new URL(origin);
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return origin;
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return origin;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return origin;
  } catch {}
  return "null";
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Ozon-Print-Helper",
    "Access-Control-Max-Age": "86400"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Print file is too large. Max size is 80MB."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

function startDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...options
  });
  child.unref();
}

function findSumatraPdf() {
  const candidates = [
    process.env.SUMATRA_PDF_PATH,
    path.join(process.cwd(), "tools", "SumatraPDF.exe"),
    path.join(process.cwd(), "tools", "sumatra", "SumatraPDF.exe"),
    "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe"
  ].filter(Boolean);
  return candidates.find((file) => {
    try { return fs.existsSync(file); } catch { return false; }
  }) || "";
}

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

async function getPrinters() {
  if (process.platform === "win32") return await getWindowsPrinters();
  if (process.platform === "darwin") return await getMacPrinters();
  return [];
}

async function getWindowsPrinters() {
  const command = [
    "$printers = Get-Printer | Select-Object Name,DriverName,PortName,Default",
    "$printers | ConvertTo-Json -Compress"
  ].join("; ");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getMacPrinters() {
  const { stdout } = await run("lpstat", ["-p", "-d"]);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const defaultLine = lines.find((line) => line.startsWith("system default destination:"));
  const defaultName = defaultLine ? defaultLine.split(":").slice(1).join(":").trim() : "";
  return lines
    .filter((line) => line.startsWith("printer "))
    .map((line) => {
      const name = line.split(/\s+/)[1] || "";
      return {
        Name: name,
        DriverName: "CUPS",
        PortName: "",
        Default: Boolean(defaultName && name === defaultName),
        State: line.includes(" is idle") ? "idle" : line.includes(" disabled") ? "disabled" : "unknown"
      };
    })
    .filter((printer) => printer.Name);
}

async function printPdfWithSumatra(pdfPath, printerName = "") {
  const sumatra = findSumatraPdf();
  if (!sumatra) return false;
  const args = ["-silent"];
  if (printerName) args.push("-print-to", printerName);
  else args.push("-print-to-default");
  args.push(pdfPath);
  await run(sumatra, args);
  return true;
}

async function printPdfWithWindowsDefault(pdfPath) {
  const command = [
    `$p = Start-Process -FilePath ${psQuote(pdfPath)} -Verb Print -PassThru`,
    "Start-Sleep -Seconds 8",
    "if ($p -and -not $p.HasExited) { try { $p.CloseMainWindow() | Out-Null } catch {} }"
  ].join("; ");
  startDetached("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
}

async function printPdfWithMac(pdfPath, printerName = "") {
  const args = [];
  if (printerName) args.push("-d", printerName);
  args.push(pdfPath);
  await run("lp", args);
}

async function printPdf(pdfPath, printerName = "") {
  if (process.platform === "win32") {
    const printedBySumatra = await printPdfWithSumatra(pdfPath, printerName);
    if (!printedBySumatra && printerName) {
      throw new Error("Windows printer selection requires SumatraPDF. Install it or put SumatraPDF.exe under the tools folder.");
    }
    if (!printedBySumatra) await printPdfWithWindowsDefault(pdfPath);
    return;
  }
  if (process.platform === "darwin") {
    await printPdfWithMac(pdfPath, printerName);
    return;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function handlePrint(payload) {
  const base64 = String(payload?.pdf_base64 || "");
  if (!base64) throw new Error("No PDF data received.");
  const safeName = String(payload?.filename || "ozon-labels.pdf").replace(/[^\w.-]+/g, "-").slice(0, 80) || "ozon-labels.pdf";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ozon-label-"));
  const pdfPath = path.join(dir, safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`);
  fs.writeFileSync(pdfPath, Buffer.from(base64, "base64"));

  const printerName = String(payload?.printer || "").trim();
  await printPdf(pdfPath, printerName);

  setTimeout(() => {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }, 5 * 60_000);
  return { printed: true, printer: printerName || "default", platform: process.platform };
}

function healthPayload() {
  return {
    ok: true,
    name: "ozon-local-print-helper",
    platform: process.platform,
    sumatra: process.platform === "win32" ? Boolean(findSumatraPdf()) : false,
    printCommand: process.platform === "darwin" ? "lp" : process.platform === "win32" ? "powershell/sumatra" : ""
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(req, res, 204, {});
      return;
    }
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, healthPayload());
      return;
    }
    if (req.method === "GET" && url.pathname === "/printers") {
      sendJson(req, res, 200, { printers: await getPrinters() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/print") {
      const body = await readBody(req);
      const result = await handlePrint(JSON.parse(body || "{}"));
      sendJson(req, res, 200, result);
      return;
    }
    sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(req, res, 500, { error: error.message || "Print helper failed." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ozon local print helper started: http://${HOST}:${PORT}`);
  if (process.platform === "win32") {
    console.log("Windows: printer selection works best with SumatraPDF or SUMATRA_PDF_PATH.");
  } else if (process.platform === "darwin") {
    console.log("macOS: using CUPS/lp. Configure the default printer in System Settings.");
  }
});

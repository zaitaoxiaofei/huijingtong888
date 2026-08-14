import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright-core";
import { resolveUploadSubdir } from "../runtime-uploads.js";

const contexts = new Map();
const contextLaunches = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function resolveBrowserProxyServer() {
  const configured = text(process.env.SELLER_ANALYTICS_PROXY_SERVER);
  if (configured) return configured;
  for (const port of [7890, 7897, 1080]) {
    if (await canConnect(port)) return `http://127.0.0.1:${port}`;
  }
  return "";
}

function text(value) {
  return String(value ?? "").trim();
}

function profileKey(tenantId, storeId) {
  return crypto.createHash("sha256").update(`${text(tenantId) || "admin"}:${text(storeId)}`).digest("hex").slice(0, 24);
}

function profilePaths(tenantId, storeId) {
  const root = resolveUploadSubdir("seller-analytics-browser-profiles");
  const profileDir = path.join(root, profileKey(tenantId, storeId));
  return {
    root,
    profileDir,
    markerPath: path.join(profileDir, "erp-profile.json"),
    authStatePath: path.join(profileDir, "erp-auth-state.json")
  };
}

function readMarker(tenantId, storeId) {
  const { markerPath } = profilePaths(tenantId, storeId);
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveChromeExecutable() {
  const configured = text(process.env.SELLER_ANALYTICS_CHROME_PATH);
  const candidates = [
    configured,
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw Object.assign(new Error("未找到 Google Chrome，请配置 SELLER_ANALYTICS_CHROME_PATH"), { statusCode: 500 });
  return executable;
}

async function waitForDevToolsEndpoint(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return `http://127.0.0.1:${port}`;
    if (child.exitCode !== null) {
      throw Object.assign(new Error(`Chrome 启动后立即退出（退出码 ${child.exitCode}）`), { statusCode: 500 });
    }
    await sleep(150);
  }
  throw Object.assign(new Error(`Chrome 已启动，但调试端口 ${port} 未就绪`), { statusCode: 504 });
}

function publicStatus(tenantId, storeId) {
  const marker = readMarker(tenantId, storeId);
  const key = profileKey(tenantId, storeId);
  return {
    store_id: text(storeId),
    configured: Boolean(marker?.confirmed_at && text(marker?.store_id) === text(storeId)),
    running: contexts.has(`${key}:login`) || contexts.has(`${key}:runtime`),
    confirmed_at: marker?.confirmed_at || null,
    last_ok_at: marker?.last_ok_at || null,
    last_error: marker?.last_error || ""
  };
}

function readAuthState(tenantId, storeId) {
  const { authStatePath } = profilePaths(tenantId, storeId);
  try {
    const state = JSON.parse(fs.readFileSync(authStatePath, "utf8"));
    return Array.isArray(state?.cookies) ? state : null;
  } catch {
    return null;
  }
}

async function contextIsUsable(context) {
  try {
    context.pages();
    await context.cookies();
    return true;
  } catch {
    return false;
  }
}

async function launchContextOnce(tenantId, storeId, { headless = true, mode = headless ? "runtime" : "login", forceFresh = false } = {}) {
  const baseKey = profileKey(tenantId, storeId);
  const key = `${baseKey}:${mode}`;
  const existing = contexts.get(key);
  if (existing && await contextIsUsable(existing)) return existing;
  contexts.delete(key);
  const paths = profilePaths(tenantId, storeId);
  if (mode === "runtime") {
    const authState = readAuthState(tenantId, storeId);
    if (!authState?.cookies?.length) {
      throw Object.assign(new Error("后台授权快照不存在，请重新确认长期绑定"), { code: "BROWSER_AUTH_STATE_MISSING", statusCode: 409 });
    }
    const proxyServer = await resolveBrowserProxyServer();
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      proxy: proxyServer ? { server: proxyServer } : undefined
    });
    const context = await browser.newContext({
      storageState: { cookies: authState.cookies, origins: Array.isArray(authState.origins) ? authState.origins : [] }
    });
    contexts.set(key, context);
    browser.on("disconnected", () => contexts.delete(key));
    return context;
  }
  const browserProfileDir = paths.profileDir;
  fs.mkdirSync(browserProfileDir, { recursive: true });
  const endpointPath = path.join(browserProfileDir, "erp-cdp.json");
  try {
    const saved = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    if (!forceFresh && Number(saved?.port) && await canConnect(saved.port)) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${saved.port}`);
      const context = browser.contexts()[0];
      await sleep(250);
      if (context && await contextIsUsable(context)) {
        contexts.set(key, context);
        browser.on("disconnected", () => contexts.delete(key));
        return context;
      }
    }
  } catch {}
  const debugPort = await reserveLocalPort();
  const args = [
    `--user-data-dir=${browserProfileDir}`,
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding"
  ];
  const proxyServer = await resolveBrowserProxyServer();
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (headless) args.push("--headless=new");
  const child = spawn(resolveChromeExecutable(), args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  const endpoint = await waitForDevToolsEndpoint(debugPort, child);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw Object.assign(new Error("Chrome 独立用户目录连接失败"), { statusCode: 500 });
  contexts.set(key, context);
  fs.writeFileSync(endpointPath, JSON.stringify({ port: debugPort, started_at: new Date().toISOString() }, null, 2), "utf8");
  browser.on("disconnected", () => contexts.delete(key));
  return context;
}

async function launchContext(tenantId, storeId, options = {}) {
  const mode = options.mode || (options.headless === false ? "login" : "runtime");
  const key = `${profileKey(tenantId, storeId)}:${mode}`;
  const pending = contextLaunches.get(key);
  if (pending) return pending;
  const launch = launchContextOnce(tenantId, storeId, { ...options, mode });
  contextLaunches.set(key, launch);
  try {
    return await launch;
  } finally {
    if (contextLaunches.get(key) === launch) contextLaunches.delete(key);
  }
}

async function currentCompanyId(context) {
  const cookies = await context.cookies("https://seller.ozon.ru/");
  return text(cookies.find((cookie) => cookie.name === "sc_company_id")?.value);
}

async function launchVerifiedContext(tenantId, storeId, options) {
  const key = `${profileKey(tenantId, storeId)}:${options.mode}`;
  try {
    const context = await launchContext(tenantId, storeId, options);
    if (await contextIsUsable(context)) return context;
  } catch {}
  contexts.delete(key);
  contextLaunches.delete(key);
  await sleep(500);
  return launchContext(tenantId, storeId, { ...options, forceFresh: true });
}

export function sellerAnalyticsBrowserProfileStatus(payload = {}, tenantId = "admin") {
  return publicStatus(tenantId, payload.store_id || payload.storeId || payload.company_id || payload.companyId);
}

export async function prepareSellerAnalyticsBrowserProfile(payload = {}, tenantId = "admin") {
  const storeId = text(payload.store_id || payload.storeId || payload.company_id || payload.companyId);
  if (!storeId) throw Object.assign(new Error("Missing store id"), { statusCode: 400 });
  const context = await launchVerifiedContext(tenantId, storeId, { headless: false, mode: "login" });
  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.goto("https://seller.ozon.ru/app/analytics/graphs", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.bringToFront();
  return { ...publicStatus(tenantId, storeId), login_window_opened: true };
}

export async function confirmSellerAnalyticsBrowserProfile(payload = {}, tenantId = "admin") {
  const storeId = text(payload.store_id || payload.storeId || payload.company_id || payload.companyId);
  if (!storeId) throw Object.assign(new Error("Missing store id"), { statusCode: 400 });
  const context = await launchVerifiedContext(tenantId, storeId, { headless: false, mode: "login" });
  const detectedStoreId = await currentCompanyId(context);
  if (!detectedStoreId) {
    throw Object.assign(new Error("未检测到 Ozon 登录店铺，请在打开的窗口完成登录后重试"), { statusCode: 409, code: "OZON_LOGIN_REQUIRED" });
  }
  if (detectedStoreId !== storeId) {
    throw Object.assign(new Error(`登录店铺不匹配：ERP 店铺 ${storeId}，Ozon 当前店铺 ${detectedStoreId}`), { statusCode: 409, code: "OZON_STORE_MISMATCH" });
  }
  const now = new Date().toISOString();
  const { profileDir, markerPath, authStatePath } = profilePaths(tenantId, storeId);
  fs.mkdirSync(profileDir, { recursive: true });
  const authState = await context.storageState();
  fs.writeFileSync(authStatePath, JSON.stringify({ ...authState, saved_at: now }, null, 2), "utf8");
  const runtimeContext = contexts.get(`${profileKey(tenantId, storeId)}:runtime`);
  if (runtimeContext && await contextIsUsable(runtimeContext) && authState.cookies?.length) {
    await runtimeContext.addCookies(authState.cookies);
  }
  fs.writeFileSync(markerPath, JSON.stringify({ tenant_id: tenantId, store_id: storeId, confirmed_at: now, last_ok_at: now }, null, 2), "utf8");
  return { ...publicStatus(tenantId, storeId), detected_store_id: detectedStoreId };
}

export async function executeSellerAnalyticsBrowserRequest(payload = {}, tenantId = "admin") {
  const storeId = text(payload.store_id || payload.storeId || payload.company_id || payload.companyId);
  const marker = readMarker(tenantId, storeId);
  if (!marker || text(marker.store_id) !== storeId) {
    throw Object.assign(new Error("Persistent browser profile is not configured"), { code: "BROWSER_PROFILE_MISSING", statusCode: 409 });
  }
  const context = await launchVerifiedContext(tenantId, storeId, { headless: true, mode: "runtime" });
  let page = context.pages().find((item) => item.url().startsWith("https://seller.ozon.ru/"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://seller.ozon.ru/app/analytics/graphs", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  const detectedStoreId = await currentCompanyId(context);
  if (detectedStoreId !== storeId) {
    throw Object.assign(new Error(`Persistent browser store mismatch: expected ${storeId}, got ${detectedStoreId || "none"}`), { code: "BROWSER_PROFILE_STORE_MISMATCH", statusCode: 409 });
  }
  const result = await page.evaluate(async ({ url, method, headers, body }) => {
    try {
      const safeHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([key]) => ![
        "cookie", "cookie2", "host", "origin", "referer", "content-length", "connection"
      ].includes(String(key).toLowerCase())));
      const response = await fetch(url, {
        method,
        headers: safeHeaders,
        body: method === "GET" ? undefined : JSON.stringify(body || {}),
        credentials: "include"
      });
      const responseText = await response.text();
      let responseBody = responseText;
      try { responseBody = responseText ? JSON.parse(responseText) : null; } catch {}
      return { success: response.ok, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: responseBody };
    } catch (error) {
      return { success: false, status: 0, headers: {}, body: null, error: error?.message || String(error) };
    }
  }, {
    url: text(payload.request_url || payload.requestUrl),
    method: text(payload.request_method || payload.requestMethod || "POST").toUpperCase(),
    headers: payload.request_headers || payload.requestHeaders || {},
    body: payload.request_body || payload.requestBody || {}
  });
  const now = new Date().toISOString();
  const { markerPath } = profilePaths(tenantId, storeId);
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, last_ok_at: result.success ? now : marker.last_ok_at, last_error: result.success ? "" : (result.error || `HTTP ${result.status}`) }, null, 2), "utf8");
  return result;
}

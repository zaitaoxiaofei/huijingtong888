const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const DEFAULT_REMOTE_URL = "https://erp.hjt888.xyz";
const remoteUrl = normalizeRemoteUrl(process.env.ELECTRON_REMOTE_URL || process.env.APP_BASE_URL || DEFAULT_REMOTE_URL);
const allowedOrigins = new Set([remoteUrl.origin]);
const OZON_SELLER_ORIGIN = "https://seller.ozon.ru";

let ozonSellerWindow = null;

function normalizeRemoteUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Electron remote URL must use http or https.");
    }
    return url;
  } catch (error) {
    console.error(`Invalid ELECTRON_REMOTE_URL: ${rawUrl}`);
    throw error;
  }
}

function isAllowedNavigation(targetUrl) {
  try {
    const url = new URL(targetUrl);
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    title: "爆单ERP",
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  win.loadURL(remoteUrl.toString());
  return win;
}

function createOzonSellerWindow() {
  if (ozonSellerWindow && !ozonSellerWindow.isDestroyed()) {
    ozonSellerWindow.show();
    ozonSellerWindow.focus();
    return ozonSellerWindow;
  }

  ozonSellerWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: "Ozon Seller",
    backgroundColor: "#ffffff",
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:ozon-seller"
    }
  });

  ozonSellerWindow.on("closed", () => {
    ozonSellerWindow = null;
  });

  return ozonSellerWindow;
}

function buildSellerProductsUrl(query) {
  const search = new URLSearchParams();
  if (query) search.set("text", query);
  return `${OZON_SELLER_ORIGIN}/app/products/list?${search.toString()}`;
}

async function waitForDownload(downloadPromise, timeoutMs = 45000) {
  return Promise.race([
    downloadPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Ozon barcode PDF download")), timeoutMs))
  ]);
}

async function downloadOfficialBarcodePdf(payload = {}) {
  const sku = String(payload.ozon_sku || payload.sku || "").trim();
  const offerId = String(payload.offer_id || payload.offerId || "").trim();
  const query = offerId || sku;
  if (!query) throw new Error("ozon_sku or offer_id is required");

  const win = createOzonSellerWindow();
  const targetUrl = buildSellerProductsUrl(query);
  await win.loadURL(targetUrl);
  win.show();
  win.focus();

  const downloadDir = path.join(os.tmpdir(), "ozon-erp-official-barcodes");
  fs.mkdirSync(downloadDir, { recursive: true });

  const downloadPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      win.webContents.session.removeListener("will-download", onWillDownload);
    };
    const onWillDownload = (_event, item) => {
      const filename = item.getFilename();
      const targetPath = path.join(downloadDir, `${Date.now()}-${filename}`);
      item.setSavePath(targetPath);
      item.once("done", (_doneEvent, state) => {
        cleanup();
        if (state !== "completed") {
          reject(new Error(`Official barcode PDF download failed: ${state}`));
          return;
        }
        resolve({
          ok: true,
          path: targetPath,
          filename
        });
      });
    };
    win.webContents.session.on("will-download", onWillDownload);
  });

  const ready = await waitForPageReady(win, "products", query, 120000);
  if (!ready.ok) return { ok: false, ...ready, url: targetUrl };

  const result = await win.webContents.executeJavaScript(`
    (() => {
      const query = ${JSON.stringify(query)};
      const bodyText = String(document.body?.innerText || "");
      if (/login|sign in|登录|登入/i.test(bodyText) || location.pathname.includes("/login")) {
        return { ok: false, code: "needs_login", message: "Ozon Seller window needs login before barcode PDF can be downloaded." };
      }
      const clickable = Array.from(document.querySelectorAll("button, a, span, div"))
        .find((el) => /download pdf|pdf|скачать pdf|штрихкод/i.test(String(el.textContent || "").trim()));
      if (!clickable) {
        return { ok: false, code: "download_button_not_found", message: "Download PDF button was not found on the product page." };
      }
      clickable.click();
      return { ok: true };
    })();
  `, true);

  if (!result?.ok) return { ok: false, ...result, url: targetUrl };
  const download = await waitForDownload(downloadPromise);
  return {
    ok: true,
    url: targetUrl,
    ...download
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSellerCampaignUrl(campaignId) {
  return `${OZON_SELLER_ORIGIN}/app/advertisement/product/cpc/${encodeURIComponent(String(campaignId || "").trim())}`;
}

async function waitForPageReady(win, campaignId, sku, timeoutMs = 120000) {
  const startedAt = Date.now();
  const url = buildSellerCampaignUrl(campaignId);
  while (Date.now() - startedAt < timeoutMs) {
    const state = await win.webContents.executeJavaScript(`
      (() => {
        const bodyText = String(document.body?.innerText || "");
        const normalizedSku = ${JSON.stringify(String(sku || "").trim())};
        const hasSku = bodyText.includes(normalizedSku);
        const hasTable = bodyText.includes("SKU") && bodyText.includes("目标广告费用份额");
        const looksLikeLogin = /login|sign in|登录|登入/i.test(bodyText) || location.pathname.includes("/login");
        return {
          href: location.href,
          hasSku,
          hasTable,
          looksLikeLogin,
          title: document.title,
          preview: bodyText.slice(0, 800)
        };
      })();
    `, true);
    if (state?.hasSku && state?.hasTable) return { ok: true, state };
    if (state?.looksLikeLogin) {
      return { ok: false, code: "needs_login", message: "Ozon Seller window needs login before adjustments can be applied.", state };
    }
    await sleep(1000);
  }
  return { ok: false, code: "page_not_ready", message: "Timed out waiting for the Ozon campaign page to become editable." };
}

async function applyTargetCirAdjustment(win, sku, targetCir) {
  return win.webContents.executeJavaScript(`
    (() => {
      const normalizedSku = ${JSON.stringify(String(sku || "").trim())};
      const desiredValue = ${JSON.stringify(String(targetCir))};
      const skuNodes = Array.from(document.querySelectorAll("div, span, a, p"))
        .filter((el) => String(el.textContent || "").trim() === normalizedSku);
      if (!skuNodes.length) {
        return { ok: false, code: "sku_not_found", message: "SKU row not found on the current page." };
      }
      const skuRect = skuNodes[0].getBoundingClientRect();
      const inputs = Array.from(document.querySelectorAll("input"))
        .filter((el) => el.type === "text" && el.getBoundingClientRect().height > 0);
      const rowInput = inputs
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => Math.abs(rect.y - skuRect.y) <= 24)
        .sort((a, b) => Math.abs(a.rect.y - skuRect.y) - Math.abs(b.rect.y - skuRect.y))[0];
      if (!rowInput?.el) {
        return { ok: false, code: "input_not_found", message: "Editable target CIR input was not found for the SKU row." };
      }
      const submitButton = Array.from(document.querySelectorAll('button[type="submit"]'))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => Math.abs(rect.y - skuRect.y) <= 24)
        .sort((a, b) => Math.abs(a.rect.y - skuRect.y) - Math.abs(b.rect.y - skuRect.y))[0];
      if (!submitButton?.el) {
        return { ok: false, code: "submit_not_found", message: "Submit button was not found for the SKU row." };
      }
      rowInput.el.click();
      rowInput.el.focus();
      rowInput.el.select?.();
      const valueSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, "value")?.set;
      if (valueSetter) {
        valueSetter.call(rowInput.el, desiredValue);
      } else {
        rowInput.el.value = desiredValue;
      }
      rowInput.el.dispatchEvent(new Event("input", { bubbles: true }));
      rowInput.el.dispatchEvent(new Event("change", { bubbles: true }));
      submitButton.el.click();
      return {
        ok: true,
        code: "submitted",
        currentValue: rowInput.el.value
      };
    })();
  `, true);
}

async function readTargetCirValue(win, sku) {
  return win.webContents.executeJavaScript(`
    (() => {
      const normalizedSku = ${JSON.stringify(String(sku || "").trim())};
      const skuNodes = Array.from(document.querySelectorAll("div, span, a, p"))
        .filter((el) => String(el.textContent || "").trim() === normalizedSku);
      if (!skuNodes.length) return { ok: false, code: "sku_not_found" };
      const skuRect = skuNodes[0].getBoundingClientRect();
      const rowInput = Array.from(document.querySelectorAll("input"))
        .filter((el) => el.type === "text" && el.getBoundingClientRect().height > 0)
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => Math.abs(rect.y - skuRect.y) <= 24)
        .sort((a, b) => Math.abs(a.rect.y - skuRect.y) - Math.abs(b.rect.y - skuRect.y))[0];
      return rowInput?.el
        ? { ok: true, value: String(rowInput.el.value || "").trim() }
        : { ok: false, code: "input_not_found" };
    })();
  `, true);
}

async function adjustAdvertisingSetting(payload = {}) {
  const mode = String(payload.mode || "").trim();
  const campaignId = String(payload.campaign_id || payload.campaignId || "").trim();
  const sku = String(payload.ozon_sku || payload.sku || "").trim();
  const targetCir = Number(payload.target_cir || payload.targetCir || 0);
  if (!campaignId || !sku) throw new Error("campaign_id and ozon_sku are required");
  if (mode !== "targetCir") {
    throw new Error("Desktop browser adjustment currently supports targetCir mode only.");
  }
  if (!(targetCir > 0)) {
    throw new Error("target_cir must be greater than 0");
  }

  const win = createOzonSellerWindow();
  const targetUrl = buildSellerCampaignUrl(campaignId);
  if (win.webContents.getURL() !== targetUrl) {
    await win.loadURL(targetUrl);
  }
  win.show();
  win.focus();

  const ready = await waitForPageReady(win, campaignId, sku);
  if (!ready.ok) return { ok: false, ...ready, url: targetUrl };

  const submitted = await applyTargetCirAdjustment(win, sku, targetCir);
  if (!submitted?.ok) return { ok: false, ...submitted, url: targetUrl };

  await sleep(5000);
  await win.webContents.reload();
  await sleep(5000);

  const verified = await readTargetCirValue(win, sku);
  if (!verified?.ok) return { ok: false, ...verified, url: targetUrl };

  return {
    ok: String(verified.value) === String(targetCir),
    mode,
    campaignId,
    sku,
    requestedValue: targetCir,
    persistedValue: verified.value,
    url: targetUrl
  };
}

app.whenReady().then(() => {
  createMainWindow();

  ipcMain.handle("advertising:adjust-setting", async (_event, payload) => adjustAdvertisingSetting(payload));
  ipcMain.handle("barcode:download-official-pdf", async (_event, payload) => downloadOfficialBarcodePdf(payload));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

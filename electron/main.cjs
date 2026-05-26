const path = require("node:path");
const { app, BrowserWindow, shell } = require("electron");

const DEFAULT_REMOTE_URL = "http://localhost:8787";
const remoteUrl = normalizeRemoteUrl(process.env.ELECTRON_REMOTE_URL || process.env.APP_BASE_URL || DEFAULT_REMOTE_URL);
const allowedOrigins = new Set([remoteUrl.origin]);

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
    title: "Ozon ERP",
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

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

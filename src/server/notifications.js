import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.resolve("data");
const statusFile = path.join(runtimeDir, "global-update-status.json");
const defaultPluginVersion = process.env.COLLECTOR_PLUGIN_VERSION || "1.3.9";
const defaultPluginPackageName = `ozon-baodan-erp-plugin-${defaultPluginVersion}.rar`;
const updateSubscribers = new Set();
const defaultStatus = {
  app: {
    version: process.env.APP_RELEASE_VERSION || "2026.06.01.1",
    title: "后台已更新",
    message: "系统后台已经发布新版本，空闲时刷新页面即可加载最新功能。",
    action: "reload",
    mandatory: false,
    published_at: new Date().toISOString()
  },
  plugin: {
    version: defaultPluginVersion,
    title: "爆单ERP插件有新版本",
    message: "爆单ERP插件已经更新，请下载最新版并重新安装。",
    download_url: process.env.COLLECTOR_PLUGIN_DOWNLOAD_URL || `/downloads/${defaultPluginPackageName}`,
    package_name: defaultPluginPackageName,
    mandatory: true,
    published_at: new Date().toISOString()
  }
};

function normalizeUpdatePayload(input = {}) {
  const app = input.app && typeof input.app === "object" ? input.app : {};
  const plugin = input.plugin && typeof input.plugin === "object" ? input.plugin : {};
  return {
    app: {
      ...defaultStatus.app,
      ...app,
      version: String(app.version || defaultStatus.app.version).trim()
    },
    plugin: {
      ...defaultStatus.plugin,
      ...plugin,
      version: String(plugin.version || defaultStatus.plugin.version).trim(),
      download_url: String(plugin.download_url || plugin.downloadUrl || defaultStatus.plugin.download_url).trim(),
      package_name: String(plugin.package_name || plugin.packageName || `ozon-baodan-erp-plugin-${plugin.version || defaultStatus.plugin.version}.rar`).trim()
    }
  };
}

function readUpdateStatusFile() {
  try {
    if (!fs.existsSync(statusFile)) return defaultStatus;
    return normalizeUpdatePayload(JSON.parse(fs.readFileSync(statusFile, "utf8")));
  } catch (error) {
    console.error("read global update status failed:", error.message);
    return defaultStatus;
  }
}

function writeUpdateStatusFile(payload) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(statusFile, `${JSON.stringify(normalizeUpdatePayload(payload), null, 2)}\n`);
}

function sendUpdateEvent(res, eventName, payload) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

export function subscribeGlobalUpdateEvents(res, query = {}) {
  const client = {
    res,
    appVersion: String(query.app_version || query.appVersion || "").trim(),
    pluginVersion: String(query.plugin_version || query.pluginVersion || "").trim()
  };
  updateSubscribers.add(client);

  sendUpdateEvent(res, "hello", {
    connected: true,
    server_time: new Date().toISOString(),
    status: globalUpdateStatus({
      app_version: client.appVersion,
      plugin_version: client.pluginVersion
    })
  });

  const heartbeat = setInterval(() => {
    if (!sendUpdateEvent(res, "ping", { server_time: new Date().toISOString() })) {
      clearInterval(heartbeat);
      updateSubscribers.delete(client);
    }
  }, 25000);

  return () => {
    clearInterval(heartbeat);
    updateSubscribers.delete(client);
  };
}

export function broadcastGlobalUpdateStatus(status = readUpdateStatusFile()) {
  for (const client of [...updateSubscribers]) {
    const payload = globalUpdateStatus({
      app_version: client.appVersion,
      plugin_version: client.pluginVersion
    });
    if (!sendUpdateEvent(client.res, "update", payload)) updateSubscribers.delete(client);
  }
}

export function globalUpdateStatus(query = {}) {
  const status = readUpdateStatusFile();
  const appVersion = String(query.app_version || query.appVersion || "").trim();
  const pluginVersion = String(query.plugin_version || query.pluginVersion || "").trim();
  return {
    app: {
      ...status.app,
      update_required: Boolean(appVersion && appVersion !== status.app.version)
    },
    plugin: {
      ...status.plugin,
      update_required: Boolean(pluginVersion && pluginVersion !== status.plugin.version)
    }
  };
}

export function updateGlobalUpdateStatus(body = {}) {
  const current = readUpdateStatusFile();
  const now = new Date().toISOString();
  const next = {
    app: {
      ...current.app,
      ...(body.app || {})
    },
    plugin: {
      ...current.plugin,
      ...(body.plugin || {})
    }
  };
  if (body.app) next.app.published_at = body.app.published_at || now;
  if (body.plugin) next.plugin.published_at = body.plugin.published_at || now;
  writeUpdateStatusFile(next);
  const status = globalUpdateStatus();
  broadcastGlobalUpdateStatus(status);
  return status;
}

export function checkDailyPurchaseNotification(all) {
  const now = new Date();
  if (now.getHours() === 18 && now.getMinutes() === 0) generateDailyPurchaseNotification(all);
}

export function generateDailyPurchaseNotification(all) {
  try {
    const pendingRequests = all(`
      SELECT pr.*, p.name AS product_name, p.code AS product_code, p.image_url AS product_image_url,
             pe.name AS person_name
      FROM procurement_requests pr
      JOIN products p ON p.id = pr.product_id
      JOIN people pe ON pe.id = pr.person_id
      WHERE pr.status = 'submitted'
      ORDER BY pr.created_at DESC
    `);
    if (!pendingRequests.length) return;
    const merged = {};
    for (const r of pendingRequests) {
      const key = r.product_id;
      if (!merged[key]) {
        merged[key] = { product_name: r.product_name, product_code: r.product_code, total_quantity: 0, total_amount: 0, request_count: 0 };
      }
      merged[key].total_quantity += Number(r.quantity || 0);
      merged[key].total_amount += Number(r.amount || 0) + Number(r.shipping_amount || 0);
      merged[key].request_count++;
    }
    const productList = Object.values(merged);
    const totalProducts = productList.length;
    const totalQuantity = productList.reduce((s, m) => s + m.total_quantity, 0);
    const totalAmount = productList.reduce((s, m) => s + m.total_amount, 0);
    console.log(`[purchase notification] ${new Date().toLocaleString()} - pending products ${totalProducts}, quantity ${totalQuantity}, amount ${totalAmount.toFixed(2)}`);
  } catch (error) {
    console.error("[purchase notification] failed:", error.message);
  }
}

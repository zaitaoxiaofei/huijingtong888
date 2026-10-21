import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.resolve("data");
const statusFile = path.join(runtimeDir, "global-update-status.json");
const collectorPluginManifestPath = path.resolve("ozon-erp-collector-plugin", "manifest.json");
const analyticsPluginManifestPath = path.resolve("pivot-table-master", "manifest.json");
const pddProcurementPluginManifestPath = path.resolve("pdd-procurement-logistics-plugin", "manifest.json");
function readPluginManifestVersion(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const version = String(manifest?.version || "").trim();
    return version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const defaultPluginVersion = process.env.COLLECTOR_PLUGIN_VERSION || readPluginManifestVersion(collectorPluginManifestPath);
const defaultPluginPackageName = `ozon-baodan-erp-plugin-${defaultPluginVersion}.zip`;
const analyticsPluginManifestVersion = readPluginManifestVersion(analyticsPluginManifestPath);
const defaultAnalyticsPluginVersion = process.env.ANALYTICS_PLUGIN_VERSION === analyticsPluginManifestVersion
  ? process.env.ANALYTICS_PLUGIN_VERSION : analyticsPluginManifestVersion;
const defaultAnalyticsPluginPackageName = `ozon-seller-analytics-plugin-${defaultAnalyticsPluginVersion}.zip`;
const defaultPddProcurementPluginVersion = process.env.PDD_PROCUREMENT_PLUGIN_VERSION || readPluginManifestVersion(pddProcurementPluginManifestPath);
const defaultPddProcurementPluginPackageName = `pdd-procurement-logistics-plugin-${defaultPddProcurementPluginVersion}.zip`;
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
    message: "爆单ERP插件有新增或增强功能，可按需下载更新，兼容的旧版本可继续使用。",
    download_url: process.env.COLLECTOR_PLUGIN_DOWNLOAD_URL || `/downloads/${defaultPluginPackageName}`,
    package_name: defaultPluginPackageName,
    mandatory: false,
    published_at: new Date().toISOString()
  },
  analytics_plugin: {
    version: defaultAnalyticsPluginVersion,
    title: "店铺数据分析插件有新版本",
    message: "店铺数据分析插件有新增或增强功能，可按需下载更新，兼容的旧版本可继续使用。",
    download_url: process.env.ANALYTICS_PLUGIN_DOWNLOAD_URL || `/downloads/${defaultAnalyticsPluginPackageName}`,
    package_name: defaultAnalyticsPluginPackageName,
    mandatory: false,
    published_at: new Date().toISOString()
  },
  pdd_procurement_plugin: {
    version: defaultPddProcurementPluginVersion,
    title: "拼多多采购物流插件有新版本",
    message: "拼多多采购物流插件有新增或增强功能，可按需下载更新，兼容的旧版本可继续使用。",
    download_url: process.env.PDD_PROCUREMENT_PLUGIN_DOWNLOAD_URL || `/downloads/${defaultPddProcurementPluginPackageName}`,
    package_name: defaultPddProcurementPluginPackageName,
    mandatory: false,
    published_at: new Date().toISOString()
  }
};

function comparePluginVersions(left, right) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(left) || !/^\d+(?:\.\d+){0,3}$/.test(right)) return null;
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const difference = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function normalizePluginUpdatePolicy(input, version) {
  const minimumVersion = String(input.minimum_supported_version || "").trim();
  const reasonType = String(input.update_reason_type || "").trim();
  const reason = String(input.update_reason || "").trim();
  const minimumComparison = comparePluginVersions(minimumVersion, version);
  return {
    minimum_supported_version: minimumVersion,
    update_reason_type: reasonType,
    update_reason: reason,
    mandatory: input.mandatory === true && reasonType === "system_bug" && Boolean(reason)
      && minimumComparison !== null && minimumComparison <= 0
  };
}

function pluginUpdateStatus(status, installedVersion) {
  const updateAvailable = comparePluginVersions(installedVersion, status.version) === -1;
  const updateRequired = updateAvailable && status.mandatory === true
    && comparePluginVersions(installedVersion, status.minimum_supported_version) === -1;
  return {
    ...status,
    installed_version: installedVersion,
    update_available: updateAvailable,
    update_required: updateRequired,
    mandatory: updateRequired
  };
}

function normalizeUpdatePayload(input = {}) {
  const app = input.app && typeof input.app === "object" ? input.app : {};
  const plugin = input.plugin && typeof input.plugin === "object" ? input.plugin : {};
  const analyticsPlugin = input.analytics_plugin && typeof input.analytics_plugin === "object"
    ? input.analytics_plugin
    : (input.analyticsPlugin && typeof input.analyticsPlugin === "object" ? input.analyticsPlugin : {});
  const pddProcurementPlugin = input.pdd_procurement_plugin && typeof input.pdd_procurement_plugin === "object"
    ? input.pdd_procurement_plugin
    : (input.pddProcurementPlugin && typeof input.pddProcurementPlugin === "object" ? input.pddProcurementPlugin : {});
  return {
    app: {
      ...defaultStatus.app,
      ...app,
      version: String(app.version || defaultStatus.app.version).trim()
    },
    plugin: {
      ...defaultStatus.plugin,
      ...plugin,
      ...normalizePluginUpdatePolicy(plugin, String(plugin.version || defaultStatus.plugin.version).trim()),
      version: String(plugin.version || defaultStatus.plugin.version).trim(),
      download_url: String(plugin.download_url || plugin.downloadUrl || defaultStatus.plugin.download_url).trim(),
      package_name: String(plugin.package_name || plugin.packageName || `ozon-baodan-erp-plugin-${plugin.version || defaultStatus.plugin.version}.zip`).trim()
    },
    analytics_plugin: {
      ...defaultStatus.analytics_plugin,
      ...analyticsPlugin,
      ...normalizePluginUpdatePolicy(analyticsPlugin, defaultAnalyticsPluginVersion),
      version: defaultAnalyticsPluginVersion,
      download_url: defaultStatus.analytics_plugin.download_url,
      package_name: defaultAnalyticsPluginPackageName
    },
    pdd_procurement_plugin: {
      ...defaultStatus.pdd_procurement_plugin,
      ...pddProcurementPlugin,
      ...normalizePluginUpdatePolicy(pddProcurementPlugin, String(pddProcurementPlugin.version || defaultStatus.pdd_procurement_plugin.version).trim()),
      version: String(pddProcurementPlugin.version || defaultStatus.pdd_procurement_plugin.version).trim(),
      download_url: String(pddProcurementPlugin.download_url || pddProcurementPlugin.downloadUrl || defaultStatus.pdd_procurement_plugin.download_url).trim(),
      package_name: String(pddProcurementPlugin.package_name || pddProcurementPlugin.packageName || `pdd-procurement-logistics-plugin-${pddProcurementPlugin.version || defaultStatus.pdd_procurement_plugin.version}.zip`).trim()
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

export function subscribeGlobalUpdateEvents(res, query = {}, trustedSession = {}) {
  const client = {
    res,
    personId: Number(trustedSession?.personId || 0) || 0,
    tenantId: Number(trustedSession?.tenant?.id || 0) || 0,
    tenantSlug: String(trustedSession?.tenant?.slug || ""),
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

// Reuse the authenticated application event stream for short-lived operational events.
export function broadcastGlobalEvent(eventName, payload = {}, options = {}) {
  const personId = Number(options.personId || 0) || 0;
  const tenantScoped = Object.hasOwn(options, "tenantId");
  const tenantId = Number(options.tenantId || 0);
  for (const client of [...updateSubscribers]) {
    if (personId && Number(client.personId || 0) !== personId) continue;
    if (tenantScoped) {
      if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || client.tenantId !== tenantId) continue;
    } else if (client.tenantSlug !== "default") continue;
    if (!sendUpdateEvent(client.res, eventName, payload)) updateSubscribers.delete(client);
  }
}

export function globalUpdateStatus(query = {}) {
  const status = readUpdateStatusFile();
  const appVersion = String(query.app_version || query.appVersion || "").trim();
  const pluginVersion = String(query.plugin_version || query.pluginVersion || "").trim();
  const analyticsPluginVersion = String(query.analytics_plugin_version || query.analyticsPluginVersion || "").trim();
  const pddProcurementPluginVersion = String(query.pdd_procurement_plugin_version || query.pddProcurementPluginVersion || "").trim();
  return {
    app: {
      ...status.app,
      update_required: Boolean(appVersion && appVersion !== status.app.version)
    },
    plugin: pluginUpdateStatus(status.plugin, pluginVersion),
    analytics_plugin: pluginUpdateStatus(status.analytics_plugin, analyticsPluginVersion),
    pdd_procurement_plugin: pluginUpdateStatus(status.pdd_procurement_plugin, pddProcurementPluginVersion)
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
    },
    analytics_plugin: {
      ...current.analytics_plugin,
      ...(body.analytics_plugin || body.analyticsPlugin || {})
    },
    pdd_procurement_plugin: {
      ...current.pdd_procurement_plugin,
      ...(body.pdd_procurement_plugin || body.pddProcurementPlugin || {})
    }
  };
  if (body.app) next.app.published_at = body.app.published_at || now;
  if (body.plugin) next.plugin.published_at = body.plugin.published_at || now;
  if (body.analytics_plugin || body.analyticsPlugin) next.analytics_plugin.published_at = body.analytics_plugin?.published_at || body.analyticsPlugin?.published_at || now;
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

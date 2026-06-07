import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const manifestPath = path.resolve(rootDir, "public", "vue-apps", ".vite", "manifest.json");
const adminHtmlPath = path.resolve(rootDir, "public", "admin.html");

const text = {
  title: "\u7206\u5355ERP",
  fallbackAria: "\u7206\u5355ERP \u52a0\u8f7d\u72b6\u6001",
  loading: "\u7206\u5355\u7cfb\u7edf\u542f\u52a8\u4e2d",
  loadingHint: "\u6b63\u5728\u52a0\u8f7d\u7cfb\u7edf\u8d44\u6e90\uff0c\u8bf7\u7a0d\u5019...",
  retrying: "\u6b63\u5728\u52a0\u8f7d\u66f4\u65b0\u8d44\u6e90",
  retryingHint: "\u65b0\u7248\u672c\u6587\u4ef6\u6b63\u5728\u5207\u6362\uff0c\u7cfb\u7edf\u5c06\u81ea\u52a8\u91cd\u8bd5...",
  errorTitle: "\u9875\u9762\u52a0\u8f7d\u5f02\u5e38",
  errorHint: "\u8bf7\u5237\u65b0\u9875\u9762\u91cd\u8bd5\uff0c\u6216\u8054\u7cfb\u7ba1\u7406\u5458\u68c0\u67e5\u524d\u7aef\u8d44\u6e90\u3002",
  missingManifest: "Vite manifest \u7f3a\u5c11 frontend/admin/main.js \u5165\u53e3\u3002"
};

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const adminEntry = manifest["frontend/admin/main.js"];
  const globalStyleEntry = manifest["style.css"];
  const buildStamp = Date.now().toString(36);

  if (!adminEntry?.file) {
    throw new Error(text.missingManifest);
  }

  const styleFiles = [
    ...(globalStyleEntry?.file ? [globalStyleEntry.file] : []),
    ...((adminEntry.css || []).filter(Boolean)),
    ...((adminEntry.imports || [])
      .flatMap((key) => manifest[key]?.css || [])
      .filter(Boolean))
  ];

  const styleTags = [...new Set(styleFiles)]
    .map((file) => `    <link rel="stylesheet" href="/vue-apps/${file}?v=${buildStamp}" />`)
    .join("\n");
  const modulePreloadTags = (adminEntry.imports || [])
    .map((key) => manifest[key]?.file)
    .filter(Boolean)
    .map((file) => `    <link rel="modulepreload" href="/vue-apps/${file}" />`)
    .join("\n");
  const routePreloadSources = {
    "/dashboard": "frontend/admin/views/DashboardView.vue",
    "/exceptions/profit": "frontend/admin/views/exceptions/ProfitExceptionView.vue",
    "/exceptions/deadline": "frontend/admin/views/exceptions/DeadlineExceptionView.vue",
    "/exceptions/deadline-warning": "frontend/admin/views/exceptions/DeadlineWarningExceptionView.vue",
    "/exceptions/stock": "frontend/admin/views/exceptions/StockExceptionView.vue",
    "/exceptions/binding": "frontend/admin/views/exceptions/BindingExceptionView.vue",
    "/inventory": "frontend/admin/views/inventory/InventoryView.vue",
    "/inventory/products": "frontend/admin/views/inventory/InventoryProductsPage.vue",
    "/inventory/fbp": "frontend/admin/views/inventory/InventoryFbpPage.vue",
    "/inventory/fbp-opportunities": "frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue",
    "/inventory/hidden": "frontend/admin/views/inventory/InventoryHiddenPage.vue",
    "/inventory/mappings": "frontend/admin/views/inventory/InventoryMappingsPage.vue",
    "/inventory/suppliers": "frontend/admin/views/inventory/InventorySuppliersPage.vue",
    "/inventory/alerts": "frontend/admin/views/inventory/InventoryAlertsPage.vue",
    "/online-products": "frontend/admin/views/inventory/OnlineProductsView.vue",
    "/asset-variant-center": "frontend/admin/views/listing/ShopAssetVariantCenter.vue",
    "/asset-variant-center/create": "frontend/admin/views/settings/PromptLibraryView.vue",
    "/listing-automation": "frontend/admin/views/listing/ListingAutomationView.vue",
    "/collector-box": "frontend/admin/views/listing/CollectorBoxView.vue",
    "/listing-records": "frontend/admin/views/listing/ListingPublishRecordsView.vue",
    "/ozon-actions": "frontend/admin/views/marketing/OzonActionsView.vue",
    "/selection": "frontend/admin/views/selection/SelectionView.vue",
    "/profit": "frontend/admin/views/profit/ProfitDashboardView.vue",
    "/seller-analytics": "frontend/admin/views/analytics/SellerAnalyticsView.vue",
    "/profit/aftersales": "frontend/admin/views/profit/ProfitAftersalesView.vue",
    "/profit/sku-ranking": "frontend/admin/views/profit/ProfitDashboardView.vue",
    "/profit/shop-ranking": "frontend/admin/views/profit/ProfitDashboardView.vue",
    "/advertising/daily": "frontend/admin/views/advertising/AdvertisingDailyView.vue",
    "/orders": "frontend/admin/views/orders/OrdersView.vue",
    "/outbound": "frontend/admin/views/orders/OutboundView.vue",
    "/customer-messages": "frontend/admin/views/orders/CustomerMessagesView.vue",
    "/procurement": "frontend/admin/views/procurement/ProcurementView.vue",
    "/purchase-list": "frontend/admin/views/procurement/PurchaseListView.vue",
    "/purchase-history": "frontend/admin/views/procurement/PurchaseHistoryView.vue",
    "/settings": "frontend/admin/views/settings/SettingsView.vue",
    "/settings/scheduled-jobs": "frontend/admin/views/settings/ScheduledJobsView.vue",
    "/settings/ai": "frontend/admin/views/settings/AiProviderSettingsView.vue",
    "/settings/materials": "frontend/admin/views/settings/MaterialCenterView.vue",
    "/tools/product-video-generator": "frontend/admin/views/tools/ProductVideoGenerator.vue",
    "/tools/image-cropper": "frontend/admin/views/tools/EcommerceImageSplitterV3.vue",
    "/tools/ecommerce-image-splitter": "frontend/admin/views/tools/EcommerceImageSplitterV3.vue"
  };
  const routePreloadMap = Object.fromEntries(Object.entries(routePreloadSources)
    .map(([route, source]) => {
      const entry = manifest[source];
      if (!entry?.file) return null;
      return [route, {
        js: `/vue-apps/${entry.file}`,
        css: (entry.css || []).map((file) => `/vue-apps/${file}`)
      }];
    })
    .filter(Boolean));
  const routePreloadScript = `    <script>
      (function () {
        var preloadMap = ${JSON.stringify(routePreloadMap)};
        var route = decodeURIComponent(String(window.location.hash || "#/dashboard").slice(1).split("?")[0] || "/dashboard");
        var preload = preloadMap[route];
        if (!preload) return;
        function addLink(rel, href) {
          if (!href || document.querySelector('link[href="' + href + '"]')) return;
          var link = document.createElement("link");
          link.rel = rel;
          link.href = href;
          document.head.appendChild(link);
        }
        addLink("modulepreload", preload.js);
        (preload.css || []).forEach(function (href) {
          addLink("stylesheet", href);
        });
      })();
    </script>`;

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <script>
      window.__ERP_BOOT_STARTED_AT = performance && performance.now ? performance.now() : Date.now();
    </script>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${text.title}</title>
    <meta http-equiv="Cache-Control" content="no-cache, must-revalidate, max-age=0" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='28' font-family='Arial, sans-serif' font-weight='700' fill='white'%3EOZ%3C/text%3E%3C/svg%3E" />
${styleTags}
${modulePreloadTags}
${routePreloadScript}
    <style>
      .admin-static-login-fallback {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at 18% 18%, rgba(37, 99, 235, 0.18), transparent 30%),
          radial-gradient(circle at 82% 78%, rgba(239, 68, 68, 0.1), transparent 28%),
          linear-gradient(135deg, #f4f8ff 0%, #ffffff 48%, #edf5ff 100%);
        color: #0f172a;
        font-family: Arial, "Microsoft YaHei", sans-serif;
      }
      .admin-static-login-fallback.is-hidden {
        display: none;
      }
      .admin-static-login-card {
        width: min(420px, 100%);
        padding: 30px;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.13);
        text-align: center;
      }
      .admin-static-login-card h1 {
        margin: 18px 0 8px;
        font-size: 25px;
        line-height: 1.18;
      }
      .admin-static-login-card p {
        margin: 0;
        color: #64748b;
        line-height: 1.7;
      }
      .admin-static-login-mark {
        width: 64px;
        height: 64px;
        margin: 0 auto;
        border-radius: 18px;
        display: grid;
        place-items: center;
        color: #ffffff;
        background: linear-gradient(135deg, #075eea, #2563eb 58%, #ef4444);
        font-size: 22px;
        font-weight: 900;
        box-shadow: 0 18px 38px rgba(37, 99, 235, 0.24);
      }
      .admin-static-login-spinner {
        width: 28px;
        height: 28px;
        margin: 20px auto 0;
        border: 3px solid rgba(37, 99, 235, 0.14);
        border-top-color: #2563eb;
        border-radius: 999px;
        animation: adminShellSpin 0.8s linear infinite;
      }
      .admin-static-login-fallback.is-error .admin-static-login-spinner {
        display: none;
      }
      @keyframes adminShellSpin {
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div id="adminStaticLoginFallback" class="admin-static-login-fallback" hidden>
      <section class="admin-static-login-card" aria-label="${text.fallbackAria}">
        <div class="admin-static-login-mark">OZ</div>
        <h1 id="adminStaticLoginTitle">${text.loading}</h1>
        <p id="adminStaticLoginHint">${text.loadingHint}</p>
        <div class="admin-static-login-spinner"></div>
      </section>
    </div>
    <div id="adminApp"></div>
    <script>
      (function () {
        var fallback = document.getElementById("adminStaticLoginFallback");
        var title = document.getElementById("adminStaticLoginTitle");
        var hint = document.getElementById("adminStaticLoginHint");
        var fallbackTimer = 0;
        var chunkReloadKey = "ozon-admin-shell-chunk-reload";
        var maxChunkReloads = 2;
        function errorMessage(event) {
          var reason = event && (event.reason || event.error || event.message || event);
          return String(reason && (reason.message || reason) || "");
        }
        function errorSource(event) {
          var target = event && event.target;
          var reason = event && (event.reason || event.error);
          return String(
            (target && (target.src || target.href))
              || (event && event.filename)
              || (reason && (reason.fileName || reason.sourceURL))
              || ""
          );
        }
        function isExtensionError(event) {
          var source = errorSource(event);
          var message = errorMessage(event);
          return source.indexOf("chrome-extension://") === 0
            || source.indexOf("moz-extension://") === 0
            || source.indexOf("content_main.js") >= 0
            || message.indexOf("Immersive Translate") >= 0
            || message.indexOf("dynamic-i18n") >= 0;
        }
        function isAppAssetError(event) {
          var source = errorSource(event);
          var message = errorMessage(event);
          return source.indexOf("/vue-apps/assets/") >= 0
            || message.indexOf("/vue-apps/assets/") >= 0
            || message.indexOf("Failed to fetch dynamically imported module") >= 0
            || message.indexOf("Importing a module script failed") >= 0
            || message.indexOf("Unable to preload CSS") >= 0
            || message.indexOf("dynamically imported module") >= 0
            || message.indexOf("static asset not found") >= 0;
        }
        function isChunkLoadError(event) {
          return isAppAssetError(event);
        }
        function shouldShowFatalError(event) {
          if (!shouldShowFallback()) return false;
          if (isExtensionError(event)) return false;
          var source = errorSource(event);
          if (source && !isAppAssetError(event)) return false;
          return true;
        }
        function reloadForChunkError(event) {
          if (!isChunkLoadError(event)) return false;
          var attempts = Number(sessionStorage.getItem(chunkReloadKey) || "0");
          if (attempts >= maxChunkReloads) return false;
          sessionStorage.setItem(chunkReloadKey, String(attempts + 1));
          window.clearTimeout(fallbackTimer);
          showFallback(true, false, true);
          window.setTimeout(function () {
            var url = new URL(window.location.href);
            url.searchParams.set("_erp_chunk_reload", Date.now().toString(36));
            window.location.replace(url.toString());
          }, 250 + attempts * 500);
          return true;
        }
        function shouldShowFallback() {
          var app = document.getElementById("adminApp");
          return !app || !app.children.length;
        }
        function showFallback(force, isError, isRetrying) {
          if (!fallback || (!force && !shouldShowFallback())) return;
          fallback.hidden = false;
          fallback.classList.remove("is-hidden");
          fallback.classList.toggle("is-error", Boolean(isError));
          if (isRetrying) {
            title.textContent = "${text.retrying}";
            hint.textContent = "${text.retryingHint}";
          } else if (isError) {
            title.textContent = "${text.errorTitle}";
            hint.textContent = "${text.errorHint}";
          }
        }
        function hideFallback() {
          if (!fallback) return;
          fallback.classList.add("is-hidden");
          fallback.hidden = true;
          sessionStorage.removeItem(chunkReloadKey);
        }
        window.__showAdminStaticLoginFallback = function () {
          showFallback(true);
        };
        window.__hideAdminStaticLoginFallback = hideFallback;
        fallbackTimer = window.setTimeout(showFallback, 2600);
        window.addEventListener("error", function (event) {
          if (reloadForChunkError(event)) return;
          if (!shouldShowFatalError(event)) return;
          window.clearTimeout(fallbackTimer);
          showFallback(true, true);
        }, true);
        window.addEventListener("unhandledrejection", function (event) {
          if (reloadForChunkError(event)) return;
          if (!shouldShowFatalError(event)) return;
          window.clearTimeout(fallbackTimer);
          showFallback(true, true);
        });
      })();
    </script>
    <script type="module" src="/vue-apps/${adminEntry.file}?v=${buildStamp}"></script>
  </body>
</html>
`;

  await fs.writeFile(adminHtmlPath, html, "utf8");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

(function initOzonErpCollectorContent() {
  const collector = window.OzonErpCollector;
  if (!collector || window.__ozonErpCollectorContentLoaded) return;
  window.__ozonErpCollectorContentLoaded = true;

  const state = {
    routeKey: '',
    routeVersion: 0,
    listRows: [],
    detailTask: null,
    detailSku: '',
    detailStatus: 'idle',
    collapsedDetailSkus: new Set(),
    observer: null,
    routeTimer: null,
    scanTimer: null,
    lastScanAt: 0,
    isScanning: false,
    pendingListMutation: false,
    detailPanelRestoreTimer: null,
    autoCollectingSkus: new Set(),
    autoCollectAttemptedSkus: new Set(),
    previewFetchedAtBySku: new Map(),
    lookupCacheBySku: new Map(),
    collectLoadingSkus: new Set(),
    fullDetailBackfillBySku: new Map(),
    manualCollectedSkus: new Set(),
    actionLoadingKeys: new Set(),
    detailUiRow: null,
    closedDetailSkus: new Set(),
    pluginStatus: null,
    sellerStatus: null,
    lastListAutoCollectMeta: null,
    watchedSkus: new Set(),
    settings: {
      injectCards: false,
      visibleFieldKeys: null
    }
  };

  const erpConfig = window.OzonErpCollectorConfig || {};
  const contentCore = window.OzonErpContentCore || {};
  const fieldRegistry = window.OzonErpFieldRegistry || {};
  const dataAggregator = window.OzonErpDataAggregator || {};
  const ERP_BASE_URL_STORAGE_KEY = erpConfig.ERP_BASE_URL_STORAGE_KEY || 'ozon-erp-base-url';
  const LOCAL_PLUGIN_TOKEN_STORAGE_KEY = erpConfig.LOCAL_PLUGIN_TOKEN_STORAGE_KEY || 'ozon-erp-local-plugin-token';
  const DEFAULT_LOCAL_PLUGIN_TOKEN = erpConfig.DEFAULT_LOCAL_PLUGIN_TOKEN || 'ozon-erp-collector-hjt888-default';
  const DEFAULT_ERP_BASE_URL = erpConfig.DEFAULT_ERP_BASE_URL || 'https://erp.hjt888.xyz';
  const FIELD_VISIBILITY_STORAGE_KEY = 'ozon-erp-detail-visible-fields';
  const WATCHED_SKUS_STORAGE_KEY = 'ozon-erp-local-watched-skus';
  const LIST_SCAN_LIMIT = 80;
  const LIST_SCAN_LIMIT_MANUAL = 120;
  const LIST_AUTO_REFRESH_LIMIT = 12;
  const LIST_MANUAL_CONTINUE_COLLECT_LIMIT = 24;
  const COLLECTOR_BOX_BACKFILL_TIMEOUT_MS = 90000;

  function withTimeoutReject(promise, ms, message) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || `Operation timed out after ${ms}ms`)), Math.max(1, Number(ms || 1)));
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get([
      'ozon-erp-inject-cards',
      FIELD_VISIBILITY_STORAGE_KEY,
      WATCHED_SKUS_STORAGE_KEY,
      ERP_BASE_URL_STORAGE_KEY
    ]);
    state.settings.injectCards = stored['ozon-erp-inject-cards'] !== false;
    state.settings.visibleFieldKeys = normalizeVisibleFieldKeys(stored[FIELD_VISIBILITY_STORAGE_KEY]);
    state.watchedSkus = new Set(Array.isArray(stored[WATCHED_SKUS_STORAGE_KEY]) ? stored[WATCHED_SKUS_STORAGE_KEY].map((sku) => String(sku || '').trim()).filter(Boolean) : []);
    state.settings.erpBaseUrl = normalizeErpBaseUrl(stored[ERP_BASE_URL_STORAGE_KEY] || DEFAULT_ERP_BASE_URL);
  }

  function normalizeErpBaseUrl(value) {
    if (typeof erpConfig.normalizeErpBaseUrl === 'function') {
      return erpConfig.normalizeErpBaseUrl(value);
    }
    return DEFAULT_ERP_BASE_URL;
  }

  function resolveErpBaseUrl() {
    return normalizeErpBaseUrl(state.settings.erpBaseUrl || DEFAULT_ERP_BASE_URL);
  }

  function resolveLocalPluginApiBaseUrl() {
    if (typeof erpConfig.resolveLocalPluginApiBaseUrl === 'function') {
      return erpConfig.resolveLocalPluginApiBaseUrl(resolveErpBaseUrl());
    }
    return `${resolveErpBaseUrl()}/api/local-plugin`;
  }

  function resolveLocalPluginApiBaseUrlFor(baseUrl) {
    if (typeof erpConfig.resolveLocalPluginApiBaseUrl === 'function') {
      return erpConfig.resolveLocalPluginApiBaseUrl(baseUrl || resolveErpBaseUrl());
    }
    return `${baseUrl || resolveErpBaseUrl()}/api/local-plugin`;
  }

  function isAllowedLocalPluginUrlFor(url, baseUrl) {
    if (typeof erpConfig.isAllowedLocalPluginUrl === 'function') {
      return erpConfig.isAllowedLocalPluginUrl(url, baseUrl || resolveErpBaseUrl());
    }
    try {
      const target = new URL(String(url || ''));
      const allowedBase = new URL(resolveLocalPluginApiBaseUrlFor(baseUrl));
      return (
        target.protocol === allowedBase.protocol &&
        target.hostname === allowedBase.hostname &&
        String(target.port || '') === String(allowedBase.port || '') &&
        target.pathname.startsWith(allowedBase.pathname.replace(/\/+$/, '') + '/')
      );
    } catch (error) {
      return false;
    }
  }

  function resolveErpApiBaseUrlFor(baseUrl) {
    return `${baseUrl || resolveErpBaseUrl()}/api`;
  }

  function resolveProductEditUrl(collectionId) {
    if (typeof erpConfig.resolveProductEditUrl === 'function') {
      return erpConfig.resolveProductEditUrl(resolveErpBaseUrl(), collectionId);
    }
    const query = collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : '';
    return `${resolveErpBaseUrl()}/#/product-edit${query}`;
  }

  function resolveCollectorBoxUrl(sku) {
    if (typeof erpConfig.resolveCollectorBoxUrl === 'function') {
      return erpConfig.resolveCollectorBoxUrl(resolveErpBaseUrl(), sku);
    }
    const query = sku ? `?sku=${encodeURIComponent(sku)}` : '';
    return `${resolveErpBaseUrl()}/#/collector-box${query}`;
  }

  function isOzonFront() {
    if (typeof contentCore.isOzonFrontLocation === 'function') {
      return contentCore.isOzonFrontLocation(location);
    }
    return /(^|\.)ozon\.(ru|kz|by)$/i.test(location.hostname);
  }

  function shouldRequestDesktopAuthContext() {
    const userAgent = String(globalThis.navigator?.userAgent || '').trim();
    return /Electron\//i.test(userAgent) || Boolean(window.electronAPI?.isElectron);
  }

  function requestDesktopAuthContext(timeoutMs = 1200) {
    if (!shouldRequestDesktopAuthContext()) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const requestId = `desktop-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener?.('message', handleMessage);
      };
      const handleMessage = (event) => {
        if (event?.data?.type !== 'OZON_ERP_DESKTOP_AUTH_CONTEXT') return;
        if (String(event.data.requestId || '') !== requestId) return;
        cleanup();
        const tenantId = String(event.data?.payload?.tenantId || '').trim();
        const erpBaseUrl = normalizeErpBaseUrl(event.data?.payload?.erpBaseUrl || event.data?.payload?.apiBaseUrl || '');
        if (!tenantId || !erpBaseUrl) {
          resolve(null);
          return;
        }
        resolve({ tenantId, erpBaseUrl });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      window.addEventListener?.('message', handleMessage);
      window.postMessage({
        type: 'OZON_ERP_REQUEST_DESKTOP_AUTH_CONTEXT',
        requestId
      }, '*');
    });
  }

  async function resolveLocalPluginRequestContext() {
    const desktopContext = await requestDesktopAuthContext();
    if (desktopContext?.erpBaseUrl) {
      return desktopContext;
    }
    return {
      tenantId: '',
      erpBaseUrl: resolveErpBaseUrl()
    };
  }

  function parseJsonResponseText(text) {
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  }

  function normalizeLocalPluginErrorMessage(error, fallback = 'ERP 本地接口请求失败') {
    const message = String(error?.message || error || '').trim();
    if (!message) return fallback;
    if (/Failed to fetch|ERR_CONNECTION_REFUSED|ECONNREFUSED|NetworkError|Load failed/i.test(message)) {
      return 'ERP 本地服务未连接，请确认 ERP 已启动后重试';
    }
    if (/local plugin endpoint requires localhost|valid plugin token|403/i.test(message)) {
      return 'ERP 插件授权失败，请重新打开 ERP 或检查插件 token 配置';
    }
    if (/返回了页面内容|Unexpected token\s*</i.test(message)) {
      return 'ERP 插件接口未正确挂载，请重启 ERP 后重试';
    }
    if (/timeout|超时|AbortError/i.test(message)) {
      return 'ERP 接口请求超时，请稍后重试或检查 ERP 服务状态';
    }
    return message;
  }

  async function loadPluginStatus() {
    const requestContext = await resolveLocalPluginRequestContext();
    const url = `${resolveLocalPluginApiBaseUrlFor(requestContext.erpBaseUrl)}/plugin/status?plugin_version=${encodeURIComponent(chrome.runtime?.getManifest?.().version || '')}`;
    const response = await localPluginFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }, requestContext);
    const text = await response.text();
    const json = parseJsonResponseText(text);
    if (!response.ok || json?.success === false) {
      throw new Error(json?.error || json?.message || text || `ERP 状态检查失败：HTTP ${response.status}`);
    }
    return json?.data || json || {};
  }

  async function refreshPluginStatus() {
    try {
      state.pluginStatus = await loadPluginStatus();
    } catch (error) {
      state.pluginStatus = {
        connected: false,
        error: normalizeLocalPluginErrorMessage(error, 'ERP 状态检查失败')
      };
    }
    return state.pluginStatus;
  }

  async function refreshSellerStatus() {
    const response = await sendRuntimeMessageCompat({ type: 'CHECK_SELLER_TAB' }).catch((error) => ({
      success: false,
      error: error?.message || String(error)
    }));
    const testResponse = response?.hasSellerTab
      ? await sendRuntimeMessageCompat({ type: 'TEST_SELLER_TAB_COMMUNICATION' }).catch((error) => ({
          success: false,
          error: error?.message || String(error)
        }))
      : null;
    state.sellerStatus = {
      success: response?.success !== false,
      hasSellerTab: Boolean(response?.hasSellerTab),
      tabCount: Number(response?.tabCount || 0),
      bridgeOk: Boolean(testResponse?.success),
      error: response?.message || response?.error || testResponse?.message || testResponse?.error || ''
    };
    return state.sellerStatus;
  }

  async function refreshWorkbenchStatuses({ rerender = true } = {}) {
    await Promise.allSettled([
      refreshPluginStatus(),
      refreshSellerStatus()
    ]);
    if (rerender && pageSku() && state.detailUiRow) renderDetailProductPanel(state.detailUiRow);
  }

  function pageSku() {
    if (typeof contentCore.getCurrentPageSku === 'function') {
      return contentCore.getCurrentPageSku(location, collector);
    }
    return collector.extractOzonSku(location.href);
  }

  function appendUniqueSku(target, value) {
    const sku = String(value || '').trim();
    if (!sku || target.includes(sku)) return;
    target.push(sku);
  }

  function isListLikePage() {
    if (typeof contentCore.isListLikePage === 'function') {
      return contentCore.isListLikePage(location, collector);
    }
    return !pageSku();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  function normalizeVisibleFieldKeys(value) {
    if (!Array.isArray(value)) return null;
    const keys = value.map((item) => String(item || '').trim()).filter(Boolean);
    return keys;
  }

  function getVisibleFieldKeySet() {
    if (Array.isArray(state.settings.visibleFieldKeys)) return new Set(state.settings.visibleFieldKeys);
    if (typeof fieldRegistry.getDefaultDetailCardVisibleKeys === 'function') {
      return new Set(fieldRegistry.getDefaultDetailCardVisibleKeys());
    }
    return null;
  }

  function getSavedVisibleFieldKeySet() {
    return Array.isArray(state.settings.visibleFieldKeys) ? new Set(state.settings.visibleFieldKeys) : null;
  }

  function getSavedDetailForCurrentSku() {
    const sku = String(pageSku() || '').trim();
    const detail = window.__ozonErpLastDetailCollect;
    if (!sku || !detail) return null;
    const detailSku = String(detail?.sku || detail?.productDetail?.sku || '').trim();
    return detailSku && detailSku === sku ? detail : null;
  }

  function clearSavedDetailForCurrentSku() {
    if (getSavedDetailForCurrentSku()) window.__ozonErpLastDetailCollect = null;
  }

  function hasFilledValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
  }

  function deriveCollectedCategoryMeta(detail) {
    const candidates = [
      detail,
      detail?.productDetail,
      detail?.normalized,
      detail?.followEditPayload
    ];
    let categoryIds = [];
    let descriptionCategoryId = '';
    let typeId = '';
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      if (categoryIds.length === 0) {
        const nextIds = normalizeCategoryIds(item.category_ids || item.categoryIds);
        if (nextIds.length > 0) categoryIds = nextIds;
      }
      if (!hasFilledValue(descriptionCategoryId)) {
        descriptionCategoryId = item.description_category_id || item.descriptionCategoryId || '';
      }
      if (!hasFilledValue(typeId)) {
        typeId = item.description_type_dict_value || item.descriptionTypeDictValue || item.type_id || item.typeId || '';
      }
    }
    if (categoryIds.length >= 2) {
      descriptionCategoryId = String(categoryIds[categoryIds.length - 2]);
      typeId = String(categoryIds[categoryIds.length - 1]);
    }
    return {
      categoryIds,
      description_category_id: descriptionCategoryId,
      type_id: typeId
    };
  }

  function deriveCollectedLogisticsMeta(detail) {
    const rows = Array.isArray(detail?.followEditPayload?.rows)
      ? detail.followEditPayload.rows
      : Array.isArray(detail?.rows)
        ? detail.rows
        : [];
    const variants = Array.isArray(detail?.variants) ? detail.variants : [];
    const candidates = [
      detail,
      detail?.productDetail,
      detail?.normalized,
      detail?.followEditPayload,
      rows[0],
      variants[0]
    ];
    let customWeight = '';
    let weightG = '';
    let depth = '';
    let width = '';
    let height = '';
    let customVolume = '';

    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      if (!hasFilledValue(customWeight)) customWeight = item.custom_weight || item.customWeight || '';
      if (!hasFilledValue(weightG)) weightG = item.weight_g || item.weightG || '';
      if (!hasFilledValue(depth)) depth = item.depth || '';
      if (!hasFilledValue(width)) width = item.width || '';
      if (!hasFilledValue(height)) height = item.height || '';
      if (!hasFilledValue(customVolume)) {
        customVolume = item.custom_volume || item.customVolume || item.real_dimensions || '';
      }
      if ((!hasFilledValue(depth) || !hasFilledValue(width) || !hasFilledValue(height) || !hasFilledValue(customVolume)) && hasFilledValue(item.custom_volume || item.customVolume || item.real_dimensions)) {
        const parsed = parseCustomVolume(item.custom_volume || item.customVolume || item.real_dimensions || '');
        if (!hasFilledValue(depth) && hasFilledValue(parsed.depth)) depth = parsed.depth;
        if (!hasFilledValue(width) && hasFilledValue(parsed.width)) width = parsed.width;
        if (!hasFilledValue(height) && hasFilledValue(parsed.height)) height = parsed.height;
        if (!hasFilledValue(customVolume) && hasFilledValue(parsed.custom_volume)) customVolume = parsed.custom_volume;
      }
    }

    return {
      custom_weight: customWeight,
      weight_g: weightG,
      depth,
      width,
      height,
      custom_volume: customVolume
    };
  }

  function canReuseCollectedDetail(detail) {
    if (!(detail?.savedCollectionId || detail?.collectionId)) return false;
    const source = String(detail?.cachedProductLookup?.product?.data_source || detail?.data_source || '').trim();
    if (source === 'ozon_plugin_fast_add_to_box') return false;
    if (detail?.cachedProductLookup?.needsRefresh === false) return true;
    const categoryMeta = deriveCollectedCategoryMeta(detail);
    const logisticsMeta = deriveCollectedLogisticsMeta(detail);
    const hasCategory = categoryMeta.categoryIds.length > 0 && hasFilledValue(categoryMeta.description_category_id) && hasFilledValue(categoryMeta.type_id);
    const hasWeight = hasFilledValue(logisticsMeta.custom_weight) || hasFilledValue(logisticsMeta.weight_g);
    const hasVolume = hasFilledValue(logisticsMeta.custom_volume) || (hasFilledValue(logisticsMeta.depth) && hasFilledValue(logisticsMeta.width) && hasFilledValue(logisticsMeta.height));
    return hasCategory && hasWeight && hasVolume;
  }

  function normalizeCachedProductImages(product = {}) {
    const source = Array.isArray(product.images) && product.images.length
      ? product.images
      : product.productImage || product.mainImage || product.primary_image || product.photo || product.main_image || product.image
        ? [product.productImage || product.mainImage || product.primary_image || product.photo || product.main_image || product.image]
        : [];
    const secondary = Array.isArray(product.secondary_images) ? product.secondary_images : [];
    return Array.from(new Set(source.concat(secondary).map((item) => String(item || '').trim()).filter(Boolean)));
  }

  function buildCachedCollectedDetail(cacheData, sku) {
    const product = cacheData?.product && typeof cacheData.product === 'object' ? cacheData.product : {};
    const normalizedSku = String(product.sku || product.product_id || sku || '').trim();
    const collectionId = String(
      product.savedCollectionId ||
      product.collectionId ||
      product.collection_id ||
      product.id ||
      `cached_${normalizedSku || 'unknown'}_${Date.now()}`
    );
    const images = normalizeCachedProductImages(product);
    const title = product.productTitle || product.name || product.title || '';
    const customWeight = product.custom_weight || product.weight_g || '';
    const customVolume = product.custom_volume || product.real_dimensions || '';
    const row = {
      sku: normalizedSku,
      title,
      images,
      sell_price: product.cardPrice ?? product.price ?? product.productPrice ?? '',
      custom_weight: customWeight,
      weight_g: customWeight,
      custom_volume: customVolume,
      real_dimensions: customVolume,
      depth: product.depth || '',
      width: product.width || '',
      height: product.height || '',
      dimensions: product.dimensions || null,
      attributes: Array.isArray(product.attributes) ? product.attributes : []
    };
    const productDetail = {
      sku: normalizedSku,
      title,
      images,
      videos: product.videos || product.videoUrls || [],
      description: product.description || '',
      price: product.cardPrice ?? product.price ?? product.productPrice ?? '',
      productPrice: product.cardPrice ?? product.productPrice ?? product.price ?? '',
      cardPrice: product.cardPrice ?? product.price ?? product.productPrice ?? '',
      originalPrice: product.originalPrice ?? '',
      brand: product.brand || '',
      category: product.category || '',
      category_ids: product.category_ids || product.categoryIds || [],
      category_commission: product.category_commission || null,
      description_category_id: product.description_category_id || product.descriptionCategoryId || '',
      type_id: product.type_id || product.typeId || '',
      custom_weight: customWeight,
      weight_g: customWeight,
      custom_volume: customVolume,
      real_dimensions: customVolume,
      depth: product.depth || '',
      width: product.width || '',
      height: product.height || '',
      dimensions: product.dimensions || null,
      coverImage: product.productImage || product.mainImage || images[0] || '',
      attributes: Array.isArray(product.attributes) ? product.attributes : []
    };
    const followEditPayload = product.followEditPayload && typeof product.followEditPayload === 'object'
      ? product.followEditPayload
      : {
          scene: 'plugin',
          sku: normalizedSku,
          currecny: 'CNY',
          attributes: productDetail.attributes,
          rows: [row],
          json_content: product.json_content || product.jsonContent || null
        };
    if (!Array.isArray(followEditPayload.rows) || followEditPayload.rows.length === 0) {
      followEditPayload.rows = [row];
    }
    const cachedDetail = {
      success: true,
      mode: 'erp-cache',
      collectionId,
      savedCollectionId: collectionId,
      sku: normalizedSku,
      productDetail,
      variants: Array.isArray(product.variants) ? product.variants : [],
      rows: followEditPayload.rows,
      jsonContent: product.jsonContent || product.json_content || null,
      followEditPayload,
      normalized: {
        ...product,
        collectionId,
        productUrl: product.productUrl || product.productLink || location.href
      },
      category: product.category || '',
      category_ids: product.category_ids || product.categoryIds || [],
      category_commission: product.category_commission || null,
      description_category_id: product.description_category_id || product.descriptionCategoryId || '',
      type_id: product.type_id || product.typeId || '',
      sellerEnrichment: product.sellerEnrichment || null,
      cachedProductLookup: {
        found: true,
        needsRefresh: false,
        reason: cacheData?.reason || 'fresh',
        collectDate: cacheData?.collectDate || product.collect_date || '',
        collectedAt: cacheData?.collectedAt || product.collectedAt || product.collected_at || ''
      },
      collectedAt: product.collectedAt || product.collected_at || cacheData?.collectedAt || new Date().toISOString(),
      stages: [
        {
          name: 'erp_cache_lookup',
          status: 'success',
          detail: cacheData?.collectDate || 'fresh',
          at: new Date().toISOString()
        }
      ]
    };
    applyCollectedFieldPatch(cachedDetail, product);
    return cachedDetail;
  }

  function normalizeVideoUrls(value) {
    if (collector.normalizeVideoUrls) return collector.normalizeVideoUrls(value);
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    return Array.from(
      new Set(
        raw
          .flatMap((item) => {
            if (!item) return [];
            if (typeof item === 'string') return [item];
            if (typeof item === 'object') return [item.url, item.src, item.link, item.href, item.value].filter(Boolean);
            return [String(item)];
          })
          .map((item) => String(item).trim())
          .filter(Boolean)
      )
    );
  }

  function normalizeHashtags(value) {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    const tags = raw
      .flatMap((item) => {
        if (!item) return [];
        if (typeof item === 'object') return [item.text, item.value, item.name, item.title, item.label].filter(Boolean);
        return String(item).split(/[\n\r]+|,|，|\s+/g);
      })
      .map((item) => {
        const text = String(item || '').trim();
        if (!text) return '';
        return text.startsWith('#') ? text : `#${text}`;
      })
      .filter(Boolean);
    return Array.from(new Set(tags));
  }

  function extractCollectedText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    if (Array.isArray(value)) return value.map((item) => extractCollectedText(item)).filter(Boolean).join(' ').trim();
    if (typeof value === 'object') return extractCollectedText(value.content ?? value.text ?? value.value ?? value.title ?? value.name ?? value.textRs);
    return '';
  }

  function extractCharacteristicsFromCollectedRaw(value) {
    const list = Array.isArray(value?.characteristics)
      ? value.characteristics.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
      : Array.isArray(value?.items)
        ? value.items
        : Array.isArray(value)
          ? value.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
          : [];
    const result = [];
    const seen = new Set();
    list.forEach((item) => {
      const title = extractCollectedText(item?.title?.textRs || item?.title || item?.name || item?.label);
      const values = (Array.isArray(item?.values) ? item.values : [])
        .map((v) => extractCollectedText(v?.text ?? v?.value ?? v?.title ?? v?.name ?? v))
        .filter(Boolean);
      if (!title || values.length === 0) return;
      const key = `${title.toLowerCase()}=${values.join('|').toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        source: 'ozon_characteristics',
        source_id: item?.id || '',
        name: title,
        title,
        value: values.length === 1 ? values[0] : values,
        values: values.map((text) => ({ value: text }))
      });
    });
    return result;
  }

  function sendRuntimeMessageCompat(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ success: false, error: error.message });
            return;
          }
          resolve(response);
        });
      } catch (error) {
        resolve({ success: false, error: error?.message || String(error) });
      }
    });
  }

  function normalizeCategoryIds(value) {
    const raw = Array.isArray(value) ? value : value == null ? [] : String(value).split(/[,\s/]+/g);
    return raw
      .map((item) => Number(String(item || '').trim()))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  function normalizeDecimal(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatMeasurementValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const rounded = Math.round(numeric * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  function toMillimeters(value, unit = 'mm') {
    const numeric = normalizeDecimal(value);
    if (numeric === null) return '';
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (['см', 'cm'].includes(normalizedUnit)) return formatMeasurementValue(numeric * 10);
    if (['м', 'm'].includes(normalizedUnit)) return formatMeasurementValue(numeric * 1000);
    if (['in', 'inch', 'inches'].includes(normalizedUnit)) return formatMeasurementValue(numeric * 25.4);
    return formatMeasurementValue(numeric);
  }

  function toGrams(value, unit = 'g') {
    const numeric = normalizeDecimal(value);
    if (numeric === null) return '';
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (['кг', 'kg'].includes(normalizedUnit)) return formatMeasurementValue(numeric * 1000);
    if (['lb', 'lbs', 'pound', 'pounds'].includes(normalizedUnit)) return formatMeasurementValue(numeric * 453.59237);
    return formatMeasurementValue(numeric);
  }

  function parseCustomVolume(value) {
    const text = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[褏啸]/g, 'x')
      .trim();
    if (!text) {
      return {
        depth: '',
        width: '',
        height: '',
        dimensions: null,
        real_dimensions: '',
        custom_volume: ''
      };
    }
    const match = text.match(
      /(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)(?:\s*(мм|mm|см|cm|м|m|in|inch|inches))?/i
    );
    if (!match) {
      return {
        depth: '',
        width: '',
        height: '',
        dimensions: null,
        real_dimensions: '',
        custom_volume: ''
      };
    }
    const unit = match[4] || 'mm';
    const depth = toMillimeters(match[1], unit);
    const width = toMillimeters(match[2], unit);
    const height = toMillimeters(match[3], unit);
    const customVolume = depth && width && height ? `${depth}x${width}x${height}` : '';
    return {
      depth,
      width,
      height,
      dimensions: customVolume ? { depth, width, height, unit: 'mm' } : null,
      real_dimensions: customVolume,
      custom_volume: customVolume
    };
  }

  function applyLogisticsPatch(target, logistics) {
    if (!target || typeof target !== 'object' || !logistics || typeof logistics !== 'object') return target;
    if (logistics.custom_weight) target.custom_weight = logistics.custom_weight;
    if (logistics.weight_g) target.weight_g = logistics.weight_g;
    if (logistics.depth) target.depth = logistics.depth;
    if (logistics.width) target.width = logistics.width;
    if (logistics.height) target.height = logistics.height;
    if (logistics.dimensions) target.dimensions = logistics.dimensions;
    if (logistics.real_dimensions) target.real_dimensions = logistics.real_dimensions;
    if (logistics.custom_volume) target.custom_volume = logistics.custom_volume;
    return target;
  }

  function hasPatchValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return hasFilledValue(value);
  }

  function applyCollectedFieldPatch(target, patch) {
    if (!target || typeof target !== 'object' || !patch || typeof patch !== 'object') return target;
    const keys = [
      'brand',
      'brandId',
      'category',
      'category_ids',
      'category1',
      'category1Id',
      'category2Id',
      'category3',
      'category3Id',
      'category_commission',
      'commissions',
      'description_category_id',
      'new_description_category_id',
      'type_id',
      'variantId',
      'variantName',
      'origin_variant_id',
      'bundle_id',
      'offer_id',
      'barcode',
      'barcodes',
      'rating',
      'description_type_name',
      'description_type_dict_value',
      'salesSchema',
      'sources',
      'soldCount',
      'soldSum',
      'soldSumRub',
      'soldSumCny',
      'gmvSum',
      'avgGmv',
      'views',
      'hitsView',
      'hits_view',
      'avgGmvOnAccDays',
      'avgGmvOnAccDaysCny',
      'avgOrdersOnAccDays',
      'sumMissedGmv',
      'salesDynamics',
      'drr',
      'daysInPromo',
      'discount',
      'promoRevenueShare',
      'daysWithTrafarets',
      'sessionCount',
      'convToCart',
      'qtyViewPdp',
      'convToCartPdp',
      'pdpToCartConversion',
      'sessionCountSearch',
      'convToCartSearch',
      'convViewToOrder',
      'custom_click_rate',
      'nullableRedemptionRate',
      'nullableCreateDate',
      'createDays',
      'fbo_rate',
      'fbs_rate',
      'rfbs_rate',
      'commission',
      'commission_percent',
      'commissionPercent',
      'commission_rate',
      'commissionRate',
      'avgPrice',
      'priceIndex',
      'price_index',
      'minSellerPrice',
      'minPrice',
      'min_price',
      'stock',
      'fbsStock',
      'fboStock',
      'cbStock',
      'retailStock',
      'sumItemsInStock',
      'daysInStock',
      'availableStock',
      'available_stock',
      'totalStock',
      'total_stock',
      'accessibility',
      'accessibilityByDays',
      'avgDeliveryDays',
      'avgDeliveryTime',
      'volume',
      'sellerId',
      'sellerName',
      'article',
      'bin',
      'salesUpdateDate',
      'salesTotals',
      'salesBenchmark',
      'attributes'
    ];
    for (const key of keys) {
      if (hasPatchValue(patch[key])) target[key] = patch[key];
    }
    applyLogisticsPatch(target, patch);
    return target;
  }

  function collectDetailSkuCandidates(result) {
    const candidates = [];
    const rows = Array.isArray(result?.followEditPayload?.rows)
      ? result.followEditPayload.rows
      : Array.isArray(result?.rows)
        ? result.rows
        : [];
    const variants = Array.isArray(result?.variants) ? result.variants : [];
    const detailVariants = Array.isArray(result?.productDetail?.variants) ? result.productDetail.variants : [];
    const firstRow = rows[0] || null;
    const firstVariant = variants[0] || null;

    // 优先使用当前详情页 URL 中的商品 SKU
    appendUniqueSku(candidates, pageSku());

    // 再沿用旧逻辑里的优先顺序
    appendUniqueSku(candidates, firstRow?.sku);
    appendUniqueSku(candidates, firstVariant?.sku);
    appendUniqueSku(candidates, result?.sku);
    appendUniqueSku(candidates, result?.productDetail?.sku);

    // 最后补充其他变体 SKU，逐个兜底尝试
    rows.forEach((item) => appendUniqueSku(candidates, item?.sku));
    variants.forEach((item) => appendUniqueSku(candidates, item?.sku));
    detailVariants.forEach((item) => appendUniqueSku(candidates, item?.sku));

    return candidates;
  }

  function buildSellerCategoryPatch(sellerResult) {
    const sellerPatch = { ...(sellerResult?.fields || {}) };
    for (const key of ['price', 'productPrice', 'sell_price', 'cardPrice', 'originalPrice', 'currency']) {
      delete sellerPatch[key];
    }
    const categoryIds = normalizeCategoryIds(sellerPatch.category_ids || sellerPatch.categoryIds);
    const hasCategoryPair = categoryIds.length >= 2;
    const descriptionCategoryId = hasCategoryPair
      ? String(categoryIds[categoryIds.length - 2])
      : sellerPatch.description_category_id || sellerPatch.descriptionCategoryId || '';
    const typeId = hasCategoryPair
      ? String(categoryIds[categoryIds.length - 1])
      : sellerPatch.description_type_dict_value || sellerPatch.descriptionTypeDictValue || sellerPatch.type_id || sellerPatch.typeId || '';
    return {
      ...sellerPatch,
      category: sellerPatch.category || '',
      category_ids: categoryIds,
      category_commission: sellerPatch.category_commission || null,
      description_category_id: descriptionCategoryId,
      type_id: typeId
    };
  }

  function removeVariantOnlySellerFields(patch) {
    const cleanPatch = { ...(patch || {}) };
    delete cleanPatch.attributes;
    delete cleanPatch.variantId;
    delete cleanPatch.variantName;
    delete cleanPatch.origin_variant_id;
    delete cleanPatch.bundle_id;
    delete cleanPatch.offer_id;
    delete cleanPatch.barcode;
    delete cleanPatch.barcodes;
    return cleanPatch;
  }

  function applySellerPatchBySku(items, patchBySku) {
    if (!Array.isArray(items) || !patchBySku || typeof patchBySku !== 'object') return;
    items.forEach((item) => {
      const sku = String(item?.sku || item?.source_sku || item?.product_id || '').trim();
      if (!sku || !patchBySku[sku]) return;
      applyCollectedFieldPatch(item, patchBySku[sku]);
    });
  }

  async function enrichDetailWithSellerFallback(result) {
    const candidateSkus = collectDetailSkuCandidates(result);
    if (candidateSkus.length === 0) return result;
    const stages = Array.isArray(result.stages) ? result.stages : [];
    stages.push({ name: 'seller_fallback', status: 'running', detail: candidateSkus.join(' -> '), at: new Date().toISOString() });
    try {
      let sellerResult = null;
      let requestedSku = '';
      const errors = [];
      const sellerResultBySku = {};
      const sellerPatchBySku = {};
      const maxVariantSellerFetch = 30;
      for (const sku of candidateSkus.slice(0, maxVariantSellerFetch)) {
        try {
          const currentSellerResult = await collector.fetchSellerFallbackData(sku);
          if (currentSellerResult?.fields && Object.keys(currentSellerResult.fields).length > 0) {
            sellerResultBySku[sku] = currentSellerResult;
            sellerPatchBySku[sku] = buildSellerCategoryPatch(currentSellerResult);
            if (!sellerResult) {
              sellerResult = currentSellerResult;
              requestedSku = sku;
            }
            continue;
          }
          errors.push(`${sku}: seller 未返回可用字段`);
        } catch (error) {
          errors.push(`${sku}: ${error?.message || String(error)}`);
        }
      }
      if (!sellerResult?.fields || Object.keys(sellerResult.fields).length === 0) {
        throw new Error(errors[0] || 'seller 兜底未返回可用商品数据');
      }
      const rootPatch = buildSellerCategoryPatch(sellerResult);
      const productPatch = removeVariantOnlySellerFields(rootPatch);
      Object.assign(result, productPatch, {
        sellerFallback: sellerResult,
        sellerVariantBySku: sellerPatchBySku,
        variantSellerFallbacks: Object.fromEntries(
          Object.entries(sellerResultBySku).map(([sku, item]) => [
            sku,
            {
              sku,
              fields: sellerPatchBySku[sku] || {},
              warnings: Array.isArray(item?.warnings) ? item.warnings : []
            }
          ])
        )
      });
      if (result.productDetail && typeof result.productDetail === 'object') {
        applyCollectedFieldPatch(result.productDetail, productPatch);
        const detailSku = String(result.productDetail.sku || '').trim();
        if (detailSku && sellerPatchBySku[detailSku]) {
          applyCollectedFieldPatch(result.productDetail, sellerPatchBySku[detailSku]);
        }
      }
      applySellerPatchBySku(result.variants, sellerPatchBySku);
      applySellerPatchBySku(result.rows, sellerPatchBySku);
      if (Array.isArray(result.productDetail?.variants)) applySellerPatchBySku(result.productDetail.variants, sellerPatchBySku);
      if (result.followEditPayload && typeof result.followEditPayload === 'object') {
        applyCollectedFieldPatch(result.followEditPayload, productPatch);
        result.followEditPayload.sellerVariantBySku = sellerPatchBySku;
        result.followEditPayload.variantSellerFallbacks = result.variantSellerFallbacks;
        applySellerPatchBySku(result.followEditPayload.rows, sellerPatchBySku);
      }
      if (result.normalized && typeof result.normalized === 'object') {
        applyCollectedFieldPatch(result.normalized, productPatch);
        result.normalized.sellerFallback = sellerResult;
        result.normalized.sellerVariantBySku = sellerPatchBySku;
        result.normalized.variantSellerFallbacks = result.variantSellerFallbacks;
        if (result.normalized.editPayload && typeof result.normalized.editPayload === 'object') {
          applyCollectedFieldPatch(result.normalized.editPayload, productPatch);
          result.normalized.editPayload.sellerFallback = sellerResult;
          result.normalized.editPayload.sellerVariantBySku = sellerPatchBySku;
          result.normalized.editPayload.variantSellerFallbacks = result.variantSellerFallbacks;
          applySellerPatchBySku(result.normalized.editPayload.editorVariants, sellerPatchBySku);
          applySellerPatchBySku(result.normalized.editPayload.followEditPayload?.rows, sellerPatchBySku);
        }
      }
      const fetchedSkuCount = Object.keys(sellerPatchBySku).length;
      const skippedSkuCount = Math.max(0, candidateSkus.length - maxVariantSellerFetch);
      stages.push({
        name: 'seller_fallback',
        status: 'success',
        detail: `${requestedSku}${productPatch.category_ids.length ? ` -> ${productPatch.category_ids.join(' > ')}` : ''}; variants ${fetchedSkuCount}${skippedSkuCount ? `, skipped ${skippedSkuCount}` : ''}`,
        at: new Date().toISOString()
      });
    } catch (error) {
      result.sellerFallback = { success: false, error: error?.message || String(error) };
      stages.push({ name: 'seller_fallback', status: 'warning', detail: error?.message || String(error), at: new Date().toISOString() });
    }
    result.stages = stages;
    return result;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: options.signal || controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('ERP 本地接口请求超时，请确认 ERP 服务是否已启动');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function directLocalPluginFetch(url, options = {}, erpBaseUrl = resolveErpBaseUrl(), timeoutMs = 15000) {
    if (!isAllowedLocalPluginUrlFor(url, erpBaseUrl)) {
      throw new Error('只允许访问当前 ERP 配置下的本地插件接口');
    }
    const response = await fetchWithTimeout(url, {
      ...options,
      mode: 'cors'
    }, timeoutMs);
    return {
      ok: response.ok,
      status: response.status,
      responseText: await response.text()
    };
  }

  function withTenantHeader(options = {}, tenantId = '') {
    const normalizedTenantId = String(tenantId || '').trim();
    if (!normalizedTenantId) return options;
    const headers = options?.headers && typeof options.headers === 'object'
      ? { ...options.headers }
      : {};
    const hasTenantHeader = Object.keys(headers).some((key) => String(key).toLowerCase() === 'x-tenant-id');
    if (!hasTenantHeader) {
      headers['x-tenant-id'] = normalizedTenantId;
    }
    return {
      ...options,
      headers
    };
  }

  async function withLocalPluginTokenHeader(options = {}) {
    const stored = await chrome.storage.local.get([LOCAL_PLUGIN_TOKEN_STORAGE_KEY]);
    const token = String(stored?.[LOCAL_PLUGIN_TOKEN_STORAGE_KEY] || DEFAULT_LOCAL_PLUGIN_TOKEN).trim();
    if (!token) return options;
    const headers = options?.headers && typeof options.headers === 'object'
      ? { ...options.headers }
      : {};
    headers['x-local-plugin-token'] = token;
    return {
      ...options,
      headers
    };
  }

  async function localPluginFetch(url, options = {}, requestContext = null) {
    const erpBaseUrl = normalizeErpBaseUrl(requestContext?.erpBaseUrl || resolveErpBaseUrl());
    const timeoutMs = Number(options.timeoutMs || 15000);
    const cleanOptions = { ...options };
    delete cleanOptions.timeoutMs;
    const requestOptions = await withLocalPluginTokenHeader(withTenantHeader(cleanOptions, requestContext?.tenantId || ''));
    let result = await sendRuntimeMessageCompat({
      type: 'OZON_ERP_LOCAL_PLUGIN_FETCH',
      url,
      erpBaseUrl,
      options: requestOptions,
      timeoutMs
    });

    if (!result?.success) {
      if (result?.message) {
        throw new Error(result.message);
      }
      const backgroundError = result?.error || '后台代理无响应';
      try {
        result = {
          success: true,
          ...(await directLocalPluginFetch(url, requestOptions, erpBaseUrl, timeoutMs))
        };
      } catch (error) {
        throw new Error(normalizeLocalPluginErrorMessage(error, `本地插件接口请求失败：${backgroundError}`));
      }
    }

    return {
      ok: Boolean(result.ok),
      status: Number(result.status || 0),
      text: async () => result.responseText || '',
      json: async () => {
        const text = result.responseText || '';
        return text ? JSON.parse(text) : null;
      }
    };
  }

  async function erpApiFetch(url, options = {}, requestContext = null) {
    const erpBaseUrl = normalizeErpBaseUrl(requestContext?.erpBaseUrl || resolveErpBaseUrl());
    const requestOptions = withTenantHeader({
      credentials: 'include',
      ...options
    }, requestContext?.tenantId || '');
    const result = await sendRuntimeMessageCompat({
      type: 'OZON_ERP_API_FETCH',
      url,
      erpBaseUrl,
      options: requestOptions
    });
    if (!result?.success) {
      throw new Error(result?.message || result?.error || 'ERP API 请求失败');
    }
    return {
      ok: Boolean(result.ok),
      status: Number(result.status || 0),
      text: async () => result.responseText || '',
      json: async () => {
        const text = result.responseText || '';
        return text ? JSON.parse(text) : null;
      }
    };
  }

  async function saveCollectedSnapshotToDb(sourcePayload, requestContext = null) {
    if (!sourcePayload?.collectionId) throw new Error('采集数据缺少 collectionId');
    const response = await localPluginFetch(`${resolveLocalPluginApiBaseUrlFor(requestContext?.erpBaseUrl)}/collected-product-details`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: sourcePayload.collectionId,
        collectionId: sourcePayload.collectionId,
        platform: 'Ozon',
        sku: sourcePayload.sku || '',
        productId: sourcePayload.product_id || sourcePayload.productId || sourcePayload.sku || '',
        productUrl: sourcePayload.productUrl || sourcePayload.productLink || location.href,
        title: sourcePayload.productTitle || sourcePayload.name || '',
        price: sourcePayload.price ?? '',
        currency: 'CNY',
        category: sourcePayload.category || '',
        description_category_id: sourcePayload.description_category_id || sourcePayload.descriptionCategoryId || '',
        type_id: sourcePayload.type_id || sourcePayload.typeId || '',
        mainImage: sourcePayload.mainImage || '',
        images: sourcePayload.images || [],
        videos: sourcePayload.videos || [],
        description: sourcePayload.description || '',
        attributes: sourcePayload.attributes || [],
        variants: sourcePayload.variants || [],
        dimensions: sourcePayload.dimensions || null,
        weight_g: sourcePayload.weight_g || '',
        custom_weight: sourcePayload.custom_weight || '',
        custom_volume: sourcePayload.custom_volume || '',
        jsonContent: sourcePayload.jsonContent || sourcePayload.json_content || sourcePayload.followEditPayload?.json_content || null,
        json_content: sourcePayload.json_content || sourcePayload.jsonContent || sourcePayload.followEditPayload?.json_content || null,
        editPayload: sourcePayload,
        collectedAt: sourcePayload.collectedAt || new Date().toISOString()
      })
    }, requestContext);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {}
    if (!json && text && /^\s*</.test(text)) {
      throw new Error('本地服务返回了页面内容，采集详情接口可能未正确挂载');
    }
    if (!response.ok || json?.success === false) {
      throw new Error(json?.error || text || `保存采集数据失败：HTTP ${response.status}`);
    }
    return json?.data?.id || json?.data?.detail?.id || sourcePayload.collectionId;
  }

  function isCollectorPayloadMediaField(key = '') {
    return /^(?:images?|image_urls?|imageUrls|source_images?|sourceImages|detail_images?|detailImageUrls|main_images?|mainImage|productImage|primary_image|photo|gallery|videos?|video_urls?|videoUrls|video_cover_urls?|cover_video_urls?)$/i.test(String(key || ''));
  }

  function normalizeCollectorPayloadMedia(value) {
    if (typeof value === 'string') {
      const source = value.trim();
      return /^(?:https?:\/\/|\/?uploads\/|\/?public\/uploads\/|\/?api\/)/i.test(source) ? source : '';
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalizeCollectorPayloadMedia(item)).filter((item) => Array.isArray(item) ? item.length : Boolean(item));
    }
    if (!value || typeof value !== 'object') return '';
    const direct = value.url || value.src || value.source_url || value.sourceUrl || value.path || '';
    return normalizeCollectorPayloadMedia(direct);
  }

  function buildUrlOnlyCollectorPayload(value) {
    if (Array.isArray(value)) return value.map((item) => buildUrlOnlyCollectorPayload(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isCollectorPayloadMediaField(key) ? normalizeCollectorPayloadMedia(child) : buildUrlOnlyCollectorPayload(child)
    ]));
  }

  async function syncCollectedProductToCollectorBox(productPayload, requestContext = null) {
    const payload = buildUrlOnlyCollectorPayload(productPayload && typeof productPayload === 'object' ? productPayload : {});
    const sku = String(payload.sku || payload.product_id || payload.productId || '').trim();
    if (!sku) throw new Error('采集数据缺少 SKU');
    const response = await localPluginFetch(`${resolveLocalPluginApiBaseUrlFor(requestContext?.erpBaseUrl)}/collected-products/sync`, {
      method: 'POST',
      timeoutMs: 30000,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        products: [{
          ...payload,
          sku,
          product_id: String(payload.product_id || payload.productId || sku).trim(),
          productUrl: payload.productUrl || payload.productLink || location.href,
          productLink: payload.productLink || payload.productUrl || location.href,
          data_source: payload.data_source || 'ozon_plugin_preview_collect',
          media_storage_mode: 'remote_url_reference',
          process_status: payload.process_status || 'pending',
          collectedAt: payload.collectedAt || new Date().toISOString()
        }]
      })
    }, requestContext);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {}
    if (!json && text && /^\s*</.test(text)) {
      throw new Error('本地服务返回了页面内容，采集箱同步接口可能未正确挂载');
    }
    if (!response.ok || json?.success === false) {
      throw new Error(json?.error || text || `同步到采集箱失败：HTTP ${response.status}`);
    }
    return {
      collectionId: json?.data?.id || json?.id || sku,
      payload: json,
      sku
    };
  }

  async function waitForCollectedSnapshot(collectionId, timeoutMs = 8000, requestContext = null) {
    const id = String(collectionId || '').trim();
    if (!id) throw new Error('采集数据缺少 collectionId');
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const response = await localPluginFetch(`${resolveLocalPluginApiBaseUrlFor(requestContext?.erpBaseUrl)}/collected-product-details/${encodeURIComponent(id)}`, {
          headers: {}
        }, requestContext);
        if (response.ok) {
          const text = await response.text();
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (error) {
            if (/^\s*</.test(text || '')) {
              lastError = '本地服务返回了页面内容，采集详情接口可能未正确挂载';
              continue;
            }
          }
          if (json?.id || json?.detail?.id || json?.data?.id) return json;
        } else {
          lastError = `HTTP ${response.status}`;
        }
      } catch (error) {
        lastError = error?.message || String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`采集数据已提交，但数据库暂时读取不到：${lastError || id}`);
  }

  async function ensureCollectedSaved(result) {
    const sourcePayload = buildCollectedProductListPayload(result);
    const requestContext = await resolveLocalPluginRequestContext();
    if (result?.savedCollectionId) {
      sourcePayload.collectionId = result.savedCollectionId;
      return { collectionId: result.savedCollectionId, sourcePayload };
    }
    const saved = await syncCollectedProductToCollectorBox(sourcePayload, requestContext);
    const collectionId = saved.collectionId || sourcePayload.sku;
    sourcePayload.collectionId = collectionId;
    result.savedCollectionId = collectionId;
    result.collectionId = collectionId;
    return { collectionId, sourcePayload };
  }

  async function persistCollectedResultUpdate(result, requestContext = null) {
    if (!result || typeof result !== 'object') return null;
    const sourcePayload = buildCollectedProductListPayload(result);
    const normalizedCollectionId = String(result.savedCollectionId || result.collectionId || sourcePayload.collectionId || '').trim();
    if (normalizedCollectionId) sourcePayload.collectionId = normalizedCollectionId;
    const saved = await syncCollectedProductToCollectorBox(sourcePayload, requestContext || await resolveLocalPluginRequestContext());
    const collectionId = saved.collectionId || sourcePayload.collectionId || sourcePayload.sku;
    result.savedCollectionId = collectionId;
    result.collectionId = collectionId;
    return { collectionId, sourcePayload, saved };
  }

  function scheduleSellerFallbackBackfill(result, options = {}) {
    if (!result || typeof result !== 'object') return Promise.resolve(null);
    const shouldPersist = options.persist !== false;
    const backgroundTask = enrichDetailWithSellerFallback(result)
      .then(async (enriched) => {
        if (!shouldPersist) return enriched;
        try {
          await persistCollectedResultUpdate(enriched);
        } catch (error) {
          const stages = Array.isArray(enriched?.stages) ? enriched.stages : [];
          stages.push({ name: 'seller_fallback_persist', status: 'warning', detail: error?.message || String(error), at: new Date().toISOString() });
          enriched.stages = stages;
        }
        return enriched;
      })
      .catch((error) => {
        console.warn('[爆单ERP] seller fallback backfill failed', error);
        return null;
      });
    result.sellerFallbackBackfillTask = backgroundTask;
    return backgroundTask;
  }

  function ensureRoot() {
    let root = document.getElementById('ozon-erp-collector-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ozon-erp-collector-root';
      document.documentElement.appendChild(root);
    }
    return root;
  }

  async function lookupCollectedProductForCurrentSku(sku) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) return null;
    if (state.lookupCacheBySku.has(normalizedSku)) {
      return state.lookupCacheBySku.get(normalizedSku)?.data || null;
    }
    const requestContext = await resolveLocalPluginRequestContext();
    const response = await sendRuntimeMessageCompat({
      type: 'OZON_ERP_COLLECTED_PRODUCT_LOOKUP',
      sku: normalizedSku,
      syncContext: requestContext
    });
    if (!response?.success) {
      const failed = {
        found: false,
        needsRefresh: true,
        reason: response?.error || 'lookup_failed',
        message: response?.message || response?.error || ''
      };
      state.lookupCacheBySku.set(normalizedSku, { success: false, data: failed });
      return failed;
    }
    state.lookupCacheBySku.set(normalizedSku, { success: true, data: response.data || null });
    return response.data || null;
  }

  function openPreviewModal(title, payload, options = {}) {
    const root = ensureRoot();
    root.querySelector('.ozon-erp-modal-mask')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ozon-erp-modal-mask';
    mask.innerHTML = `
      <div class="ozon-erp-modal">
        <div class="ozon-erp-modal-head">
          <strong>${escapeHtml(title)}</strong>
          <div class="ozon-erp-modal-actions">
            ${options.publish ? '<button type="button" data-action="publish" class="primary">打开采集箱</button>' : ''}
            ${Array.isArray(options.extraActions) ? options.extraActions.map((action) => `
              <button type="button" data-action="${escapeHtml(action.action)}" class="${escapeHtml(action.className || '')}">${escapeHtml(action.label)}</button>
            `).join('') : ''}
            <button type="button" data-action="close">关闭</button>
          </div>
        </div>
        <div class="ozon-erp-modal-summary"></div>
        <pre class="ozon-erp-json"></pre>
      </div>
    `;
    const summary = mask.querySelector('.ozon-erp-modal-summary');
    summary.innerHTML = buildSummary(payload);
    mask.querySelector('.ozon-erp-json').textContent = prettyJson(payload);
    mask.querySelector('[data-action="close"]').addEventListener('click', () => mask.remove());
    mask.querySelector('[data-action="publish"]')?.addEventListener('click', () => {
      openCollectorBox(payload?.sku || payload?.product_id || payload?.productId || pageSku());
    });
    if (typeof options.onAction === 'function') {
      mask.querySelectorAll('[data-action]').forEach((button) => {
        const action = button.dataset.action || '';
        if (!action || action === 'close' || action === 'publish') return;
        button.addEventListener('click', () => options.onAction(action, { mask, button, payload }));
      });
    }
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    root.appendChild(mask);
  }

  function buildSummary(payload) {
    if (payload?.listRows) {
      const autoCollect = payload.autoCollect || {};
      const remaining = Number(autoCollect.remainingCount || 0);
      const requested = Number(autoCollect.requestedCount || 0);
      const eligible = Number(autoCollect.eligibleCount || 0);
      return `
        <span>\u5217\u8868 SKU\uff1a${escapeHtml(payload.listRows.length)}</span>
        <span>\u5df2\u67e5\u8be2 ERP \u91c7\u96c6\u72b6\u6001</span>
        ${eligible ? `<span>\u53ef\u8865\u91c7\uff1a${escapeHtml(eligible)}</span>` : ''}
        ${requested ? `<span>\u672c\u6b21\u8865\u91c7\uff1a${escapeHtml(requested)}</span>` : ''}
        ${remaining ? `<span>\u5f85\u7ee7\u7eed\u8865\u91c7\uff1a${escapeHtml(remaining)}</span>` : ''}
      `;
    }
    if (payload?.error) {
      return `
        <span>SKU：${escapeHtml(payload.sku || '-')}</span>
        <span>失败原因：${escapeHtml(payload.error)}</span>
      `;
    }
    if (payload?.followEditPayload) {
      const rows = payload.followEditPayload.rows || [];
      return `
        <span>SKU：${escapeHtml(payload.sku || '-')}</span>
        <span>变体行：${rows.length}</span>
        <span>图片：${payload.productDetail?.images?.length || 0}</span>
        <span>视频：${payload.productDetail?.videos?.length || 0}</span>
        <span>seller类目：${escapeHtml(payload.category_ids?.join?.(' > ') || payload.sellerFallback?.error || '未获取')}</span>
        <span>seller待调用：${payload.requestSpecs?.seller?.length || 0}</span>
      `;
    }
    if (payload?.listRows) {
      const autoCollect = payload.autoCollect || {};
      const remaining = Number(autoCollect.remainingCount || 0);
      const requested = Number(autoCollect.requestedCount || 0);
      return `
        <span>列表 SKU：${payload.listRows.length}</span>
        <span>已查询 ERP 已采集商品状态</span>
        ${requested ? `<span>本次补采：${requested}</span>` : ''}
        ${remaining ? `<span>待继续补采：${remaining}</span>` : ''}
      `;
    }
    return '<span>预览数据</span>';
  }

  function renderDetailPanel(status, detail, cacheData = null) {
    const sku = pageSku() || state.detailSku || '-';
    renderDetailProductPanel(buildDetailDisplayRow(sku, status, detail, cacheData));
  }

  async function fetchCurrentPageDetailSnapshot(sku) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku || typeof collector.fetchProductDetail !== 'function') return null;
    try {
      const productDetail = await collector.fetchProductDetail(normalizedSku, { includeVariants: false });
      if (!productDetail || typeof productDetail !== 'object') return null;
      return {
        success: true,
        mode: 'current-page-snapshot',
        sku: normalizedSku,
        productDetail,
        variants: [],
        rows: []
      };
    } catch (error) {
      console.warn('[爆单ERP] 当前详情页价格读取失败', error?.message || error);
      return null;
    }
  }

  function buildAutoCollectBaseProductFromDetail(detail, sku) {
    const product = detail?.productDetail && typeof detail.productDetail === 'object' ? detail.productDetail : null;
    const normalizedSku = String(product?.sku || sku || '').trim();
    if (!normalizedSku || !product) return null;
    const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
    const price = product.cardPrice ?? product.price ?? product.productPrice ?? '';
    return {
      sku: normalizedSku,
      product_id: normalizedSku,
      productTitle: product.title || '',
      title: product.title || '',
      name: product.title || '',
      price,
      webPrice: product.webPrice ?? product.price ?? '',
      productPrice: price,
      sell_price: price,
      cardPrice: price,
      originalPrice: product.originalPrice ?? '',
      priceCurrency: 'CNY',
      currency: 'CNY',
      ozonEntrypointPriceLoaded: true,
      productImage: product.coverImage || images[0] || '',
      mainImage: product.coverImage || images[0] || '',
      images,
      productLink: location.href,
      productUrl: location.href
    };
  }

  async function refreshDetailCacheStatus(sku, currentDetail = null) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) return;
    const routeKey = state.routeKey;
    const routeVersion = state.routeVersion;
    state.detailSku = normalizedSku;
    let liveDetail = currentDetail;
    renderDetailPanel('正在读取当前页面价格', liveDetail);
    try {
      liveDetail = await fetchCurrentPageDetailSnapshot(normalizedSku) || liveDetail;
      if (routeKey !== state.routeKey || routeVersion !== state.routeVersion || pageSku() !== normalizedSku || state.detailStatus === 'running') return;
      autoCollectCollectedProductSkus([buildDetailPreviewBaseProduct(normalizedSku, liveDetail, null)], 'detail_preview', { previewTtlMs: 5 * 60 * 1000 })
        .catch((error) => {
          console.warn('[爆单ERP] 详情页预览补数失败', error);
        });
      renderDetailPanel('正在查询ERP已采集状态', liveDetail);
      const cacheData = await lookupCollectedProductForCurrentSku(normalizedSku);
      if (routeKey !== state.routeKey || routeVersion !== state.routeVersion || pageSku() !== normalizedSku || state.detailStatus === 'running') return;
      if (cacheData?.found && cacheData.needsRefresh === false) {
        const cachedDetail = buildCachedCollectedDetail(cacheData, normalizedSku);
        if (liveDetail?.productDetail && cachedDetail?.productDetail) {
          cachedDetail.productDetail = {
            ...cachedDetail.productDetail,
            price: liveDetail.productDetail.price ?? cachedDetail.productDetail.price,
            productPrice: liveDetail.productDetail.productPrice ?? cachedDetail.productDetail.productPrice,
            sell_price: liveDetail.productDetail.sell_price ?? cachedDetail.productDetail.sell_price,
            cardPrice: liveDetail.productDetail.cardPrice ?? cachedDetail.productDetail.cardPrice,
            originalPrice: liveDetail.productDetail.originalPrice ?? cachedDetail.productDetail.originalPrice,
            currency: 'CNY'
          };
        }
        window.__ozonErpLastDetailCollect = cachedDetail;
        state.detailStatus = 'success';
        renderDetailPanel(`ERP已采集：${cacheData.collectDate || '今日'}，无需补采`, cachedDetail, cacheData);
        return;
      }
      state.detailStatus = 'idle';
      if (cacheData?.found && cacheData.needsRefresh) {
        renderDetailPanel(`ERP已有历史采集：${cacheData.collectDate || '-'}，需要补采`, liveDetail, cacheData);
        return;
      }
      renderDetailPanel('ERP未找到已采集数据，需要采集', liveDetail, cacheData);
    } catch (error) {
      if (routeKey !== state.routeKey || routeVersion !== state.routeVersion || pageSku() !== normalizedSku || state.detailStatus === 'running') return;
      state.detailStatus = 'idle';
      renderDetailPanel(`ERP已采集状态查询失败：${error?.message || error}`, liveDetail);
    }
  }

  function buildDetailPreviewBaseProduct(sku, detail = null, cacheData = null) {
    const normalizedSku = String(sku || '').trim();
    const productDetail = detail?.productDetail && typeof detail.productDetail === 'object' ? detail.productDetail : {};
    const cacheProduct = cacheData?.product && typeof cacheData.product === 'object' ? cacheData.product : {};
    return {
      ...cacheProduct,
      sku: normalizedSku,
      product_id: normalizedSku,
      productTitle: productDetail.title || cacheProduct.productTitle || cacheProduct.name || cacheProduct.title || '',
      name: cacheProduct.name || productDetail.title || cacheProduct.productTitle || '',
      title: productDetail.title || cacheProduct.title || cacheProduct.productTitle || '',
      price: productDetail.cardPrice ?? productDetail.price ?? cacheProduct.cardPrice ?? cacheProduct.price ?? cacheProduct.productPrice ?? '',
      webPrice: productDetail.webPrice ?? productDetail.price ?? cacheProduct.webPrice ?? cacheProduct.price ?? '',
      productPrice: productDetail.cardPrice ?? productDetail.price ?? cacheProduct.productPrice ?? cacheProduct.price ?? '',
      sell_price: productDetail.cardPrice ?? productDetail.price ?? cacheProduct.sell_price ?? cacheProduct.price ?? '',
      cardPrice: productDetail.cardPrice ?? productDetail.price ?? cacheProduct.cardPrice ?? cacheProduct.price ?? '',
      originalPrice: productDetail.originalPrice ?? cacheProduct.originalPrice ?? '',
      priceCurrency: 'CNY',
      currency: 'CNY',
      productImage: cacheProduct.productImage || cacheProduct.mainImage || productDetail.coverImage || (Array.isArray(productDetail.images) ? productDetail.images[0] : ''),
      mainImage: cacheProduct.mainImage || cacheProduct.productImage || productDetail.coverImage || (Array.isArray(productDetail.images) ? productDetail.images[0] : ''),
      images: Array.isArray(cacheProduct.images) && cacheProduct.images.length > 0
        ? cacheProduct.images
        : Array.isArray(productDetail.images) ? productDetail.images : [],
      productLink: location.href,
      productUrl: location.href
    };
  }

  function compactString(value) {
    return String(value || '').trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = compactString(value);
      if (text) return text;
    }
    return '';
  }

  function firstArrayItem(value) {
    return Array.isArray(value) ? value.find((item) => compactString(item)) || '' : '';
  }

  function currentPageCategoryText() {
    const selectors = [
      '[data-widget*="bread"] a',
      '[data-widget*="Bread"] a',
      '[data-widget*="breadcrumb"] a',
      '[data-widget*="Breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      'nav[aria-label*="Breadcrumb"] a',
      'a[href*="/category/"]'
    ];
    const names = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const text = compactString(node.textContent);
        if (text && !names.includes(text)) names.push(text);
      });
      if (names.length >= 2) break;
    }
    return names.join('/');
  }

  function buildFastCollectorBoxPayload(sku, product = {}) {
    const normalizedSku = compactString(sku || product.sku || product.product_id || product.productId);
    const intelligence = product.ozonProductIntelligence || {};
    const basic = intelligence.basic || {};
    const price = intelligence.price || {};
    const logistics = intelligence.logistics || {};
    const category = basic.category || {};
    const images = [
      product.productImage,
      product.mainImage,
      product.coverImage,
      firstArrayItem(product.images),
      firstArrayItem(basic.images)
    ].map((item) => compactString(item)).filter(Boolean);
    const title = firstNonEmpty(
      product.productTitle,
      product.title,
      product.name,
      basic.title,
      document.querySelector('h1')?.textContent
    );
    const pageCategory = currentPageCategoryText();
    const categoryName = firstNonEmpty(product.category, product.categoryName, category.name, pageCategory);
    const currentPrice = product.cardPrice ?? product.price ?? product.productPrice ?? price.ozonCardRub ?? price.currentRub ?? '';
    const mainImage = firstNonEmpty(product.productImage, product.mainImage, product.coverImage, images[0]);
    return {
      sku: normalizedSku,
      product_id: compactString(product.product_id || product.productId || normalizedSku),
      productTitle: title,
      title,
      name: firstNonEmpty(product.name, title),
      category: categoryName,
      categoryName,
      category_path: firstNonEmpty(product.category_path, product.categoryPath, pageCategory, categoryName),
      category_id: firstNonEmpty(product.category_id, product.categoryId, category.id),
      brand: firstNonEmpty(product.brand, basic.brand),
      price: currentPrice,
      productPrice: product.productPrice ?? currentPrice,
      sell_price: product.sell_price ?? currentPrice,
      cardPrice: product.cardPrice ?? price.ozonCardRub ?? currentPrice,
      originalPrice: product.originalPrice ?? price.originalRub ?? '',
      priceCurrency: 'CNY',
      currency: 'CNY',
      productImage: mainImage,
      mainImage,
      images: mainImage ? [mainImage] : [],
      productLink: firstNonEmpty(product.productLink, product.productUrl, location.href),
      productUrl: firstNonEmpty(product.productUrl, product.productLink, location.href),
      soldCount: product.soldCount ?? product.orders ?? '',
      qtyViewPdp: product.qtyViewPdp ?? product.views ?? '',
      custom_click_rate: product.custom_click_rate ?? product.clickRate ?? '',
      convViewToOrder: product.convViewToOrder ?? product.conversionRate ?? '',
      stock: product.stock ?? product.availableStock ?? product.totalStock ?? '',
      commission_rate: product.commission_rate ?? product.commissionRate ?? '',
      salesSchema: firstNonEmpty(product.salesSchema, product.sales_schema, logistics.salesSchema),
      weight_g: product.weight_g ?? logistics.weightG ?? '',
      depth: product.depth ?? logistics.lengthMm ?? '',
      width: product.width ?? logistics.widthMm ?? '',
      height: product.height ?? logistics.heightMm ?? '',
      data_source: 'ozon_plugin_fast_add_to_box',
      process_status: 'pending',
      collectedAt: new Date().toISOString()
    };
  }

  function refreshCollectorBoxCacheAfterSync(sku, payload, reason = 'fresh') {
    const normalizedSku = compactString(sku || payload?.sku);
    if (!normalizedSku) return null;
    const cacheData = {
      found: true,
      needsRefresh: false,
      reason,
      sku: normalizedSku,
      collectDate: new Date().toISOString().slice(0, 10),
      product: payload
    };
    state.lookupCacheBySku.set(normalizedSku, { success: true, data: cacheData });
    return cacheData;
  }

  function scheduleFullCollectorBoxBackfill(sku, requestContext = null) {
    const normalizedSku = compactString(sku);
    if (!normalizedSku) return null;
    const existing = state.fullDetailBackfillBySku.get(normalizedSku);
    if (existing) return existing;
    const task = withTimeoutReject(
      collectFullDetailPayloadForCollectorBox(normalizedSku),
      COLLECTOR_BOX_BACKFILL_TIMEOUT_MS,
      `Full detail collector-box backfill timed out for ${normalizedSku}`
    )
      .then(async ({ result, payload }) => {
        const saved = await syncCollectedProductToCollectorBox(payload, requestContext);
        const cacheData = refreshCollectorBoxCacheAfterSync(payload.sku || normalizedSku, payload, 'full_detail_backfill');
        result.savedCollectionId = saved.collectionId || payload.collectionId || payload.sku || normalizedSku;
        result.collectionId = result.savedCollectionId;
        if (pageSku() === normalizedSku && cacheData) {
          renderDetailProductPanel(buildDetailDisplayRow(payload.sku || normalizedSku, '已采集，详情已补齐', null, cacheData));
        }
      })
      .catch((error) => {
        console.warn('Background full detail collector-box backfill failed:', error?.message || error);
      })
      .finally(() => {
        state.fullDetailBackfillBySku.delete(normalizedSku);
      });
    state.fullDetailBackfillBySku.set(normalizedSku, task);
    return task;
  }

  function buildEditorSourcePayload(result) {
    const detail = result?.productDetail || {};
    const rows = result?.followEditPayload?.rows || result?.rows || [];
    const images = Array.isArray(detail.images) ? detail.images : [];
    const collectionId = result?.collectionId || result?.normalized?.collectionId || `ozon_${result?.sku || detail.sku || pageSku() || 'unknown'}_${Date.now()}`;
    const jsonContent =
      result?.jsonContent ||
      result?.json_content ||
      result?.followEditPayload?.json_content ||
      result?.normalized?.jsonContent ||
      result?.normalized?.json_content ||
      null;
    const categoryMeta = deriveCollectedCategoryMeta(result);
    const logisticsMeta = deriveCollectedLogisticsMeta(result);
    const categoryIds = Array.isArray(result?.category_ids)
      ? result.category_ids
      : Array.isArray(detail.category_ids)
        ? detail.category_ids
        : Array.isArray(result?.normalized?.category_ids)
          ? result.normalized.category_ids
          : categoryMeta.categoryIds;
    const descriptionCategoryId =
      result?.description_category_id ||
      result?.descriptionCategoryId ||
      detail.description_category_id ||
      detail.descriptionCategoryId ||
      result?.normalized?.description_category_id ||
      result?.normalized?.descriptionCategoryId ||
      categoryMeta.description_category_id ||
      '';
    const typeId =
      result?.description_type_dict_value ||
      result?.descriptionTypeDictValue ||
      result?.type_id ||
      result?.typeId ||
      detail.description_type_dict_value ||
      detail.descriptionTypeDictValue ||
      detail.type_id ||
      detail.typeId ||
      result?.normalized?.description_type_dict_value ||
      result?.normalized?.descriptionTypeDictValue ||
      result?.normalized?.type_id ||
      result?.normalized?.typeId ||
      categoryMeta.type_id ||
      '';
    const attributes = [
      ...(Array.isArray(detail.attributes)
        ? detail.attributes
        : Array.isArray(result?.normalized?.attributes)
          ? result.normalized.attributes
          : []),
      ...(Array.isArray(result?.followEditPayload?.attributes) ? result.followEditPayload.attributes : []),
      ...extractCharacteristicsFromCollectedRaw(detail.raw?.characteristics || result?.normalized?.raw?.characteristics)
    ];
    const rawCharacteristics = detail.raw?.characteristics || result?.normalized?.raw?.characteristics || null;
    const hashtags = normalizeHashtags([
      ...normalizeHashtags(detail.hashtags),
      ...normalizeHashtags(result?.hashtags),
      ...normalizeHashtags(result?.normalized?.hashtags),
      ...normalizeHashtags(result?.followEditPayload?.hashtags),
      ...normalizeHashtags(rows.flatMap((row) => row.hashtags || []))
    ]);
    const valueSources = [result, detail, result?.normalized, result?.followEditPayload].filter((item) => item && typeof item === 'object');
    const pickValue = (keys, fallback = '') => {
      for (const source of valueSources) {
        for (const key of keys) {
          if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
        }
      }
      return fallback;
    };
    const editorVariants = rows.map((row, index) => {
      const rowImages = Array.isArray(row.images) ? row.images : [];
      const primary = row.cover_image || rowImages[0] || '';
      const rowAttributes = Array.isArray(row.attributes) && row.attributes.length > 0
        ? row.attributes
        : rows.length > 1 ? [] : attributes;
      return {
        id: row.collection_row_id || `${collectionId}_${row.sku || index}`,
        source_sku: String(row.sku || ''),
        title: row.title || detail.title || '',
        offer_id: row.offer_id || '',
        barcode: row.barcode || pickValue(['barcode']) || '',
        price: row.sell_price || '',
        old_price: row.old_price || '',
        custom_weight: row.custom_weight || detail.custom_weight || logisticsMeta.custom_weight || row.weight_g || detail.weight_g || logisticsMeta.weight_g || '',
        weight_g: row.custom_weight || row.weight_g || detail.custom_weight || detail.weight_g || logisticsMeta.custom_weight || logisticsMeta.weight_g || '',
        depth: row.depth || detail.depth || logisticsMeta.depth || '',
        width: row.width || detail.width || logisticsMeta.width || '',
        height: row.height || detail.height || logisticsMeta.height || '',
        dimensions: row.dimensions || detail.dimensions || null,
        real_dimensions: row.real_dimensions || detail.real_dimensions || logisticsMeta.custom_volume || '',
        custom_volume: row.custom_volume || detail.custom_volume || logisticsMeta.custom_volume || '',
        primary_image: primary,
        images: primary ? rowImages.filter((item) => item && item !== primary) : rowImages,
        video_urls: normalizeVideoUrls(row.video_urls || row.videos || detail.videoUrls || detail.videos || []),
        cover_video_urls: [],
        attributes: rowAttributes,
        hashtags: normalizeHashtags(row.hashtags || hashtags),
        searchable_text: row.searchable_text || ''
      };
    });
    return {
      collectionId,
      platform: 'Ozon',
      data_source: 'ozon_plugin_detail_collect',
      productTitle: detail.title || result?.normalized?.title || '',
      name: detail.title || result?.normalized?.title || '',
      description: detail.description || '',
      currency: 'CNY',
      brand: pickValue(['brand'], '无品牌'),
      brandId: pickValue(['brandId', 'brand_id']),
      category: result?.category || detail.category || result?.normalized?.category || '',
      category_ids: categoryIds,
      category1: pickValue(['category1']),
      category1Id: pickValue(['category1Id', 'category1_id']),
      category2Id: pickValue(['category2Id', 'category2_id']),
      category3: pickValue(['category3']),
      category3Id: pickValue(['category3Id', 'category3_id']),
      category_commission: result?.category_commission || detail.category_commission || result?.normalized?.category_commission || null,
      commissions: result?.commissions || detail.commissions || result?.normalized?.commissions || null,
      description_category_id: descriptionCategoryId,
      new_description_category_id: pickValue(['new_description_category_id', 'newDescriptionCategoryId']),
      type_id: typeId,
      sellerEnrichment: result?.sellerEnrichment || result?.normalized?.sellerEnrichment || null,
      sellerFallback: result?.sellerFallback || result?.normalized?.sellerFallback || null,
      sellerVariantBySku: result?.sellerVariantBySku || result?.normalized?.sellerVariantBySku || null,
      variantSellerFallbacks: result?.variantSellerFallbacks || result?.normalized?.variantSellerFallbacks || null,
      price: detail.cardPrice ?? detail.price ?? '',
      webPrice: detail.webPrice ?? detail.price ?? '',
      productPrice: detail.cardPrice ?? detail.price ?? '',
      cardPrice: detail.cardPrice ?? '',
      originalPrice: detail.originalPrice ?? '',
      priceCurrency: 'CNY',
      productLink: result?.normalized?.productUrl || location.href,
      productUrl: result?.normalized?.productUrl || location.href,
      sku: result?.sku || detail.sku || pageSku() || '',
      product_id: result?.sku || detail.sku || pageSku() || '',
      mainImage: detail.coverImage || images[0] || '',
      productImage: detail.coverImage || images[0] || '',
      primary_image: pickValue(['primary_image']),
      photo: pickValue(['photo']),
      images,
      videos: normalizeVideoUrls(detail.videoUrls || detail.videos || []),
      originalVideos: detail.videos || [],
      salesSchema: pickValue(['salesSchema', 'sales_schema']),
      sources: pickValue(['sources']),
      variantName: pickValue(['variantName', 'variant_name']),
      origin_variant_id: pickValue(['origin_variant_id', 'originVariantId']),
      bundle_id: pickValue(['bundle_id', 'bundleId']),
      offer_id: pickValue(['offer_id', 'offerId']),
      barcode: pickValue(['barcode']),
      barcodes: pickValue(['barcodes']),
      rating: pickValue(['rating']),
      description_type_name: pickValue(['description_type_name', 'descriptionTypeName']),
      description_type_dict_value: pickValue(['description_type_dict_value', 'descriptionTypeDictValue']),
      soldCount: pickValue(['soldCount', 'sold_count', 'orders']),
      soldSum: pickValue(['soldSum', 'sold_sum']),
      soldSumRub: pickValue(['soldSumRub', 'sold_sum_rub', 'soldSum', 'sold_sum']),
      soldSumCny: pickValue(['soldSumCny', 'sold_sum_cny']),
      gmvSum: pickValue(['gmvSum', 'gmv_sum']),
      avgGmv: pickValue(['avgGmv', 'avg_gmv']),
      views: pickValue(['views']),
      hitsView: pickValue(['hitsView', 'hits_view']),
      avgGmvOnAccDays: pickValue(['avgGmvOnAccDays', 'avg_gmv_on_acc_days']),
      avgGmvOnAccDaysCny: pickValue(['avgGmvOnAccDaysCny', 'avg_gmv_on_acc_days_cny']),
      avgOrdersOnAccDays: pickValue(['avgOrdersOnAccDays', 'avg_orders_on_acc_days']),
      sumMissedGmv: pickValue(['sumMissedGmv', 'sum_missed_gmv']),
      salesDynamics: pickValue(['salesDynamics', 'sales_dynamics']),
      drr: pickValue(['drr']),
      daysInPromo: pickValue(['daysInPromo', 'days_in_promo']),
      discount: pickValue(['discount']),
      promoRevenueShare: pickValue(['promoRevenueShare', 'promo_revenue_share']),
      daysWithTrafarets: pickValue(['daysWithTrafarets', 'days_with_trafarets']),
      sessionCount: pickValue(['sessionCount', 'session_count']),
      convToCart: pickValue(['convToCart', 'conv_to_cart']),
      qtyViewPdp: pickValue(['qtyViewPdp', 'qty_view_pdp']),
      convToCartPdp: pickValue(['convToCartPdp', 'conv_to_cart_pdp']),
      pdpToCartConversion: pickValue(['pdpToCartConversion', 'pdp_to_cart_conversion']),
      sessionCountSearch: pickValue(['sessionCountSearch', 'session_count_search']),
      convToCartSearch: pickValue(['convToCartSearch', 'conv_to_cart_search']),
      convViewToOrder: pickValue(['convViewToOrder', 'conv_view_to_order']),
      custom_click_rate: pickValue(['custom_click_rate', 'clickRate', 'click_rate']),
      nullableRedemptionRate: pickValue(['nullableRedemptionRate', 'redemptionRate', 'redemption_rate']),
      nullableCreateDate: pickValue(['nullableCreateDate', 'createDate', 'create_date']),
      createDays: pickValue(['createDays', 'create_days']),
      variantId: pickValue(['variantId', 'variant_id']),
      fbo_rate: pickValue(['fbo_rate', 'fboRate']),
      fbs_rate: pickValue(['fbs_rate', 'fbsRate']),
      rfbs_rate: pickValue(['rfbs_rate', 'rfbsRate']),
      commission: pickValue(['commission']),
      commission_percent: pickValue(['commission_percent', 'commissionPercent']),
      commission_rate: pickValue(['commission_rate', 'commissionRate']),
      avgPrice: pickValue(['avgPrice', 'avg_price']),
      priceIndex: pickValue(['priceIndex', 'price_index']),
      minSellerPrice: pickValue(['minSellerPrice', 'min_seller_price']),
      minPrice: pickValue(['minPrice', 'min_price']),
      stock: pickValue(['stock']),
      fbsStock: pickValue(['fbsStock', 'fbs_stock']),
      fboStock: pickValue(['fboStock', 'fbo_stock']),
      cbStock: pickValue(['cbStock', 'cb_stock']),
      retailStock: pickValue(['retailStock', 'retail_stock']),
      sumItemsInStock: pickValue(['sumItemsInStock', 'sum_items_in_stock']),
      daysInStock: pickValue(['daysInStock', 'days_in_stock']),
      availableStock: pickValue(['availableStock', 'available_stock']),
      totalStock: pickValue(['totalStock', 'total_stock']),
      accessibility: pickValue(['accessibility']),
      accessibilityByDays: pickValue(['accessibilityByDays', 'accessibility_by_days']),
      avgDeliveryDays: pickValue(['avgDeliveryDays', 'avg_delivery_days']),
      avgDeliveryTime: pickValue(['avgDeliveryTime', 'avg_delivery_time']),
      volume: pickValue(['volume']),
      sellerId: pickValue(['sellerId', 'seller_id']),
      sellerName: pickValue(['sellerName', 'seller_name']),
      article: pickValue(['article']),
      bin: pickValue(['bin']),
      localIndex: pickValue(['localIndex', 'local_index']),
      salesUpdateDate: pickValue(['salesUpdateDate', 'sales_update_date']),
      salesTotals: pickValue(['salesTotals', 'sales_totals']),
      salesBenchmark: pickValue(['salesBenchmark', 'sales_benchmark']),
      custom_weight: detail.custom_weight || detail.weight_g || logisticsMeta.custom_weight || logisticsMeta.weight_g || '',
      weight_g: detail.custom_weight || detail.weight_g || logisticsMeta.custom_weight || logisticsMeta.weight_g || '',
      depth: detail.depth || logisticsMeta.depth || '',
      width: detail.width || logisticsMeta.width || '',
      height: detail.height || logisticsMeta.height || '',
      dimensions: detail.dimensions || null,
      real_dimensions: detail.real_dimensions || logisticsMeta.custom_volume || '',
      custom_volume: detail.custom_volume || logisticsMeta.custom_volume || '',
      hashtags,
      attributes,
      variants: result?.variants || [],
      editorVariants,
      followEditPayload: result?.followEditPayload || null,
      requestSpecs: result?.requestSpecs || null,
      jsonContent,
      json_content: jsonContent,
      raw: {
        characteristics: rawCharacteristics
      },
      collectedAt: new Date().toISOString()
    };
  }

  function buildCollectedProductListPayload(result) {
    const source = buildEditorSourcePayload(result);
    const keys = [
      'sku',
      'product_id',
      'offer_id',
      'productTitle',
      'name',
      'brand',
      'brandId',
      'category',
      'category_ids',
      'category1',
      'category1Id',
      'category2Id',
      'category3',
      'category3Id',
      'category_commission',
      'commissions',
      'description_category_id',
      'new_description_category_id',
      'type_id',
      'variantName',
      'origin_variant_id',
      'bundle_id',
      'barcode',
      'barcodes',
      'rating',
      'description_type_name',
      'description_type_dict_value',
      'price',
      'productPrice',
      'cardPrice',
      'webPrice',
      'originalPrice',
      'priceCurrency',
      'currency',
      'productLink',
      'productUrl',
      'productImage',
      'mainImage',
      'primary_image',
      'photo',
      'images',
      'secondary_images',
      'salesSchema',
      'sources',
      'soldCount',
      'soldSum',
      'soldSumRub',
      'soldSumCny',
      'gmvSum',
      'avgGmv',
      'views',
      'hitsView',
      'hits_view',
      'avgGmvOnAccDays',
      'avgGmvOnAccDaysCny',
      'avgOrdersOnAccDays',
      'sumMissedGmv',
      'salesDynamics',
      'drr',
      'daysInPromo',
      'discount',
      'promoRevenueShare',
      'daysWithTrafarets',
      'sessionCount',
      'convToCart',
      'qtyViewPdp',
      'convToCartPdp',
      'pdpToCartConversion',
      'sessionCountSearch',
      'convToCartSearch',
      'convViewToOrder',
      'custom_click_rate',
      'nullableRedemptionRate',
      'nullableCreateDate',
      'createDays',
      'variantId',
      'fbo_rate',
      'fbs_rate',
      'rfbs_rate',
      'commission',
      'commission_percent',
      'commissionPercent',
      'commission_rate',
      'commissionRate',
      'avgPrice',
      'priceIndex',
      'price_index',
      'minSellerPrice',
      'minPrice',
      'min_price',
      'stock',
      'fbsStock',
      'fboStock',
      'cbStock',
      'retailStock',
      'sumItemsInStock',
      'daysInStock',
      'availableStock',
      'available_stock',
      'totalStock',
      'total_stock',
      'accessibility',
      'accessibilityByDays',
      'avgDeliveryDays',
      'avgDeliveryTime',
      'volume',
      'sellerId',
      'sellerName',
      'article',
      'bin',
      'localIndex',
      'salesUpdateDate',
      'salesTotals',
      'salesBenchmark',
      'custom_weight',
      'weight_g',
      'depth',
      'width',
      'height',
      'dimensions',
      'real_dimensions',
      'custom_volume',
      'description',
      'videos',
      'originalVideos',
      'hashtags',
      'attributes',
      'sellerFallback',
      'sellerVariantBySku',
      'variantSellerFallbacks',
      'variants',
      'editorVariants',
      'followEditPayload',
      'requestSpecs',
      'jsonContent',
      'json_content'
    ];
    const payload = {
      data_source: 'ozon_plugin_manual_detail_list_collect',
      process_status: 'pending',
      collectedAt: new Date().toISOString()
    };
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        payload[key] = source[key];
      }
    }
    payload.id = String(payload.product_id || payload.sku || '').trim();
    payload.product_id = String(payload.product_id || payload.sku || '').trim();
    payload.sku = String(payload.sku || payload.product_id || '').trim();
    return payload;
  }

  async function collectListPayloadFromDetail() {
    const result = await collector.runDetailAutoFeature({ concurrency: 4 });
    window.__ozonErpLastDetailCollect = result;
    scheduleSellerFallbackBackfill(result, { persist: false });
    return buildCollectedProductListPayload(result);
  }

  async function collectFullDetailPayloadForCollectorBox(expectedSku = '') {
    const result = await collector.runDetailAutoFeature({ concurrency: 4 });
    window.__ozonErpLastDetailCollect = result;
    scheduleSellerFallbackBackfill(result, { persist: false });
    const payload = buildCollectedProductListPayload(result);
    const normalizedExpectedSku = String(expectedSku || '').trim();
    if (normalizedExpectedSku && String(payload.sku || '').trim() && String(payload.sku || '').trim() !== normalizedExpectedSku) {
      throw new Error(`Collected SKU mismatch: expected ${normalizedExpectedSku}, got ${payload.sku}`);
    }
    payload.data_source = 'ozon_plugin_detail_add_to_box';
    return { result, payload };
  }

  function sendRuntimeMessage(message) {
    return sendRuntimeMessageCompat(message);
  }

  async function openCollectorBox(sku) {
    const normalizedSku = String(sku || pageSku() || '').trim();
    const response = await sendRuntimeMessage({
      type: 'OZON_ERP_OPEN_COLLECTOR_BOX_BROWSER',
      sku: normalizedSku
    });
    if (!response?.success) {
      window.open(resolveCollectorBoxUrl(normalizedSku), '_blank');
    }
  }

  function openSelectionProduct(productId = '') {
    const query = productId ? `?productId=${encodeURIComponent(productId)}` : '';
    window.open(`${resolveErpBaseUrl()}/#/selection${query}`, '_blank');
  }

  function openListingDraft(templateId = '', sku = '') {
    const params = new URLSearchParams();
    if (templateId) params.set('templateId', String(templateId));
    if (sku) params.set('collectorSku', String(sku));
    const query = params.toString() ? `?${params.toString()}` : '';
    window.open(`${resolveErpBaseUrl()}/#/listing-automation${query}`, '_blank');
  }

  async function openSellerDashboard() {
    await sendRuntimeMessageCompat({
      type: 'OPEN_NEW_TAB',
      url: 'https://seller.ozon.ru/app/dashboard/main'
    }).catch(() => {
      window.open('https://seller.ozon.ru/app/dashboard/main', '_blank');
    });
  }

  async function refreshSellerDashboard() {
    const response = await sendRuntimeMessageCompat({ type: 'REFRESH_SELLER_TAB' });
    if (!response?.success) {
      await openSellerDashboard();
      return response;
    }
    return response;
  }

  async function openProductEditor(result, options = {}) {
    // 预留旧编辑页入口：当前 UI 不再直接绑定，避免把“采集”误解为“直接上架”。
    const silent = options.silent === true;
    let collectionId = result?.savedCollectionId || result?.collectionId;
    let saveFailureMessage = '';
    const sourcePayload = buildEditorSourcePayload(result);
    try {
      if (!result?.savedCollectionId) {
        const saved = await ensureCollectedSaved(result);
        collectionId = saved.collectionId;
      }
    } catch (error) {
      saveFailureMessage = error?.message || String(error);
    }
    if (!silent) {
      renderDetailPanel(
        saveFailureMessage
          ? '采集详情未写入本地缓存，正在打开旧编辑页'
          : '采集数据已入库，正在打开旧编辑页',
        result
      );
    }
    const context = {
      mode: 'create',
      source: 'ozon_plugin_collect',
      collectionId,
      sourcePayload: collectionId
        ? { ...sourcePayload, collectionId }
        : sourcePayload
    };

    if (/Electron/i.test(navigator.userAgent)) {
      window.postMessage({
        type: 'OZON_ERP_OPEN_PRODUCT_EDIT',
        payload: {
          collectionId,
          context,
          legacy: null
        }
      }, '*');
      if (!silent) {
        renderDetailPanel(
          saveFailureMessage
            ? '已发送到 Electron 编辑页，可直接继续编辑'
            : '已发送到 Electron 编辑页',
          result
        );
      }
      return;
    }

    const response = await sendRuntimeMessage({
      type: 'OZON_ERP_OPEN_PRODUCT_EDIT_BROWSER',
      collectionId,
      context,
      legacy: null
    });
    if (!response?.success) {
      const errorText = String(response?.error || '');
      if (/Extension context invalidated/i.test(errorText)) {
        window.open(resolveProductEditUrl(collectionId), '_blank');
        return;
      }
      openPreviewModal('编辑上架跳转失败', {
        error: response?.error || '无法打开 ERP 商品编辑页',
        context
      });
      return;
    }
    if (!silent) {
      renderDetailPanel(
        saveFailureMessage
          ? '已打开浏览器商品编辑页，可直接继续编辑'
          : '已打开浏览器商品编辑页',
        result
      );
    }
  }

  function findProductCard(anchor) {
    const tileRoot = anchor?.closest?.('.tile-root');
    if (tileRoot) return tileRoot;
    let node = anchor;
    for (let i = 0; i < 8 && node && node !== document.body; i += 1) {
      const rect = node.getBoundingClientRect();
      const links = node.querySelectorAll?.('a[href*="/product/"]')?.length || 0;
      if (rect.width >= 150 && rect.height >= 100 && links <= 4) return node;
      node = node.parentElement;
    }
    return anchor.parentElement || anchor;
  }

  function parseListCardPrice(text) {
    const source = String(text || '')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const match = source.match(/(^|[^\d%])(\d[\d\s.,]*?)\s*(?:₽|руб\.?|рублей|р\b)/i);
    if (!match) return '';
    const compact = match[2].replace(/\s+/g, '');
    const lastComma = compact.lastIndexOf(',');
    const lastDot = compact.lastIndexOf('.');
    let normalized = compact;
    if (lastComma > -1 && lastDot > -1) {
      normalized = lastComma > lastDot
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
    } else if (lastComma > -1) {
      normalized = compact.replace(',', '.');
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : '';
  }

  function parseListCardPrices(text) {
    const source = String(text || '')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!source) return [];
    const prices = [];
    const pattern = /(^|[^\d%])(\d[\d\s.,]*?)\s*(₽|руб\.?|рублей|р\b)/ig;
    let match = null;
    while ((match = pattern.exec(source))) {
      const value = parseListCardPrice(`${match[2]} ${match[3]}`);
      if (value !== '') prices.push(value);
    }
    return prices;
  }

  function isLikelySecondaryPriceText(text) {
    return /(рассроч|кредит|платеж|в месяц|месяц|x\s*\d+|скидк|балл|cashback|кэшбэк|до\s+\d|от\s+\d)/i.test(String(text || ''));
  }

  function isVisibleNode(node) {
    if (!node?.getBoundingClientRect) return true;
    const rect = node.getBoundingClientRect();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    return rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
  }

  function normalizeListPriceValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    const textPrice = parseListCardPrice(value);
    if (textPrice !== '') return textPrice;
    const compact = String(value || '')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, '')
      .replace(/[^\d,.-]/g, '');
    if (!compact) return '';
    const lastComma = compact.lastIndexOf(',');
    const lastDot = compact.lastIndexOf('.');
    let normalized = compact;
    if (lastComma > -1 && lastDot > -1) {
      normalized = lastComma > lastDot
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
    } else if (lastComma > -1) {
      normalized = compact.replace(',', '.');
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : '';
  }

  function extractListCardPriceFromNodes(root) {
    if (!root?.querySelectorAll) return '';
    const candidates = [];
    for (const node of root.querySelectorAll('span, div')) {
      if (!isVisibleNode(node)) continue;
      const text = String(node?.textContent || '')
        .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || !/[₽¥руб]/i.test(text)) continue;
      const prices = parseListCardPrices(text);
      if (prices.length === 0) continue;
      const rect = node.getBoundingClientRect?.() || { width: 0, height: 0, top: 0 };
      const className = String(node.className || '');
      let score = 0;
      if (/tsHeadline|price|Price/i.test(className)) score += 20;
      if (/tsBody|old|cross|strike/i.test(className)) score -= 10;
      if (isLikelySecondaryPriceText(text)) score -= 30;
      if (prices.length === 1) score += 6;
      if (text.length <= 32) score += 12;
      if (rect.height >= 20) score += 8;
      if (rect.width <= 220) score += 4;
      score -= Math.max(0, text.length - 40) / 10;
      candidates.push({
        price: prices[0],
        score,
        top: rect.top || 0,
        text
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.top - b.top);
    return candidates[0]?.price ?? '';
  }

  function findListCardPriceRoot(anchor, fallback) {
    let node = anchor;
    let broadCandidate = null;
    for (let i = 0; i < 10 && node && node !== document.body; i += 1) {
      const price = parseListCardPrice(node.textContent || '');
      if (price !== '') {
        const links = node.querySelectorAll?.('a[href*="/product/"]')?.length || (node === anchor ? 1 : 0);
        if (links <= 6) return node;
        if (!broadCandidate) broadCandidate = node;
      }
      node = node.parentElement;
    }
    return broadCandidate || fallback || anchor;
  }

  function extractListCardPrice(card, priceRoot, anchor, row) {
    const existing = [
      row?.price,
      row?.productPrice,
      row?.sell_price,
      row?.cardPrice
    ].map(normalizeListPriceValue).find((item) => item !== '');
    if (existing !== '') return existing;
    const fromNodes = extractListCardPriceFromNodes(priceRoot) || extractListCardPriceFromNodes(card);
    if (fromNodes !== '') return fromNodes;
    return parseListCardPrice(`${priceRoot?.textContent || ''}\n${card?.textContent || ''}\n${anchor?.textContent || ''}`);
  }

  function cleanListCardTitleText(value) {
    let text = String(value || '')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    let previous = '';
    while (text && text !== previous) {
      previous = text;
      text = text
        .replace(/^\s*\d[\d\s.,]*\s*(?:₽|руб\.?|рублей|р\b)\s*/i, '')
        .replace(/^\s*\d[\d\s.,]*\s*¥\s*/i, '')
        .replace(/^\s*[–—-]?\s*\d{1,3}\s*%\s*/i, '')
        .trim();
    }
    text = text
      .replace(/\d(?:[.,]\d+)?\s+\d[\d\s.,]*\s*(?:отзыва|отзывов|оценк[аи]?|reviews?).*$/i, '')
      .replace(/\s+\d(?:[.,]\d+)?\s+\d[\d\s.,]*\s*(?:отзыва|отзывов|оценк[аи]?|reviews?).*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return /[A-Za-z\u0400-\u04ff]/.test(text) ? text : '';
  }

  function extractImageUrlFromNode(node) {
    if (!node) return '';
    const direct =
      node.currentSrc ||
      node.src ||
      node.getAttribute?.('src') ||
      node.getAttribute?.('data-src') ||
      node.getAttribute?.('data-original') ||
      '';
    if (/^https?:\/\//i.test(String(direct))) return String(direct).trim();
    const background = String(node.style?.backgroundImage || '');
    const match = background.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
    return match ? match[1] : '';
  }

  function extractListCardImages(card) {
    if (!card?.querySelectorAll) return [];
    const urls = [];
    for (const node of card.querySelectorAll('img, [style*="background-image"]')) {
      const url = extractImageUrlFromNode(node);
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  function extractListCardTitle(card, anchor, fallback = '') {
    const primaryCandidates = [
      fallback,
      anchor?.getAttribute?.('title'),
      anchor?.getAttribute?.('aria-label'),
      anchor?.textContent
    ].map(cleanListCardTitleText).filter(Boolean);
    if (primaryCandidates.length > 0) {
      return primaryCandidates.sort((a, b) => b.length - a.length)[0];
    }

    const candidates = [];
    if (card?.querySelectorAll) {
      for (const node of card.querySelectorAll('span, div')) {
        const text = cleanListCardTitleText(node?.textContent || '');
        if (text && !/[₽¥руб]/i.test(text) && !isLikelySecondaryPriceText(text)) candidates.push(text);
      }
    }
    return candidates
      .filter((item) => item && item.length <= 220)
      .sort((a, b) => b.length - a.length)[0] || '';
  }

  function enrichListRowsFromCards(rows, bySku, limit) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    let count = 0;
    for (const anchor of document.querySelectorAll('a[href*="/product/"]')) {
      if (count >= limit) break;
      count += 1;
      const sku = collector.extractOzonSku(anchor.href);
      const row = sku ? bySku.get(String(sku)) : null;
      if (!row) continue;
      const card = findProductCard(anchor);
      const priceRoot = findListCardPriceRoot(anchor, card);
      const title = extractListCardTitle(card, anchor, row.title || '');
      const price = extractListCardPrice(card, priceRoot, anchor, row);
      const images = extractListCardImages(card);
      if (title) {
        row.title = title;
        row.name = title;
        row.productTitle = title;
      }
      if (price !== '') {
        row.price = price;
        row.productPrice = price;
        row.sell_price = price;
        row.cardPrice = price;
      }
      if (images.length > 0) {
        row.images = images;
        row.productImage = images[0];
        row.mainImage = images[0];
      }
      row.productLink = row.url || anchor.href;
      row.productUrl = row.url || anchor.href;
    }
    return rows;
  }

  function normalizeCardDisplayValue(value) {
    if (value === undefined || value === null || value === '') return '--';
    if (value === '暂无数据' || value === '无') return '--';
    if (Array.isArray(value)) return value.length ? value.join(' / ') : '--';
    if (typeof value === 'object') return prettyJson(value).replace(/\s+/g, ' ').trim();
    return String(value).trim() || '--';
  }

  function hasCardMetricValue(value) {
    if (value === undefined || value === null || value === '') return false;
    const normalized = normalizeCardDisplayValue(value);
    return normalized !== '--';
  }

  function pickCardValue(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== undefined && value !== null && value !== '' && value !== '鏆傛棤鏁版嵁') return value;
    }
    return '';
  }

  function cardNumberValue(value) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).replace(/[^\d.,-]/g, '').replace(',', '.');
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function formatCardMoney(value) {
    if (value === undefined || value === null || value === '') return '--';
    const text = String(value).trim();
    if (/[₽¥]|руб|Br/i.test(text)) return text;
    const number = Number(text);
    if (!Number.isFinite(number)) return text || '--';
    return `₽${number.toLocaleString('ru-RU')}`;
  }

  function buildMoneyValue(value, currency = '') {
    const raw = pickCardValue({ value }, ['value']);
    if (raw === '') return '';
    const text = String(raw).trim();
    if (/[₽¥]|руб|Br/i.test(text)) return text;
    const normalizedCurrency = String(currency || '').trim().toUpperCase();
    if (normalizedCurrency === 'CNY') return `¥${Number(raw).toLocaleString('zh-CN')}`;
    return formatCardMoney(raw);
  }

  function formatCardValueWithUnit(value, unit, unitPattern) {
    const text = normalizeCardDisplayValue(value);
    if (text === '--') return text;
    if (unitPattern.test(text)) return text;
    return `${text}${unit}`;
  }

  function normalizeCreateDateValue(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '鏆傛棤鏁版嵁') return '';
    return raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] || raw;
  }

  function formatCreateAgeDays(value, daysValue = '') {
    const days = resolveCreateAgeDaysNumber(value, daysValue);
    if (days === null) return '';
    const floored = Math.floor(days);
    return floored < 30 ? `新品 · ${floored}天` : `${floored}天`;
  }

  function resolveCreateAgeDaysNumber(value, daysValue = '') {
    const normalizedDate = normalizeCreateDateValue(value);
    if (!normalizedDate) return null;
    let days = cardNumberValue(daysValue);
    if (days === null) {
      const parsed = new Date(normalizedDate);
      if (Number.isFinite(parsed.getTime())) {
        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const dateStart = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime();
        days = Math.max(0, Math.floor((todayStart - dateStart) / 86400000));
      }
    }
    return days === null ? null : Math.floor(days);
  }

  function normalizeCardPercent(value) {
    if (value === undefined || value === null || value === '') return '--';
    const text = String(value).trim();
    if (!text || text === '--') return '--';
    return text.includes('%') ? text : `${text}%`;
  }

  function normalizeCommissionSchema(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeCommissionValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'object') {
      return normalizeCommissionValue(
        value.value ??
        value.percent ??
        value.commission_percent ??
        value.commissionPercent ??
        value.rate ??
        value.amount
      );
    }
    const text = String(value).trim();
    if (!text) return '';
    const numeric = cardNumberValue(text);
    if (numeric === null) return text;
    const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
    return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
  }

  function collectCommissionEntries(source) {
    const result = [];
    const append = (value, fallbackSchema = '') => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return;
        if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
          try {
            append(JSON.parse(text), fallbackSchema);
            return;
          } catch (error) {}
        }
      }
      if (Array.isArray(value)) {
        value.forEach((item) => append(item, fallbackSchema));
        return;
      }
      if (value && typeof value === 'object' && !('value' in value) && !('percent' in value) && !('rate' in value) && !('commission_percent' in value)) {
        for (const [key, item] of Object.entries(value)) append(item, key);
        return;
      }
      if (value && typeof value === 'object') {
        const schema = normalizeCommissionSchema(
          value.sales_schema ||
          value.sale_schema ||
          value.salesSchema ||
          value.delivery_schema ||
          value.deliverySchema ||
          value.schema ||
          value.name ||
          fallbackSchema
        );
        const percent = normalizeCommissionValue(value);
        if (percent) result.push({ schema, value: percent });
        return;
      }
      const percent = normalizeCommissionValue(value);
      if (percent) result.push({ schema: normalizeCommissionSchema(fallbackSchema), value: percent });
    };

    append(source?.category_commission || source?.categoryCommission);
    append(source?.commissions || source?.commission);
    append(source?.fbo_rate || source?.fboRate || source?.fbo_commission || source?.fboCommission, 'fbo');
    append(source?.fbs_rate || source?.fbsRate || source?.fbs_commission || source?.fbsCommission, 'fbs');
    append(source?.rfbs_rate || source?.rfbsRate || source?.rfbs_commission || source?.rfbsCommission, 'rfbs');
    append(source?.commission_percent || source?.commissionPercent || source?.commission_rate || source?.commissionRate, source?.salesSchema || source?.sales_schema || 'fbs');
    return result;
  }

  function matchCommissionEntry(entries, targetSchema) {
    const schema = normalizeCommissionSchema(targetSchema);
    const safeEntries = Array.isArray(entries) ? entries : [];
    const exact = safeEntries.find((entry) => normalizeCommissionSchema(entry.schema) === schema);
    if (exact) return exact;
    if (schema === 'rfbs') {
      return safeEntries.find((entry) => normalizeCommissionSchema(entry.schema) === 'fbs') ||
        safeEntries.find((entry) => normalizeCommissionSchema(entry.schema).includes('rfbs'));
    }
    return safeEntries.find((entry) => normalizeCommissionSchema(entry.schema).split(/[^a-z0-9]+/).includes(schema)) ||
      safeEntries.find((entry) => entry.value);
  }

  function parseCardCommission(source, model) {
    const direct = pickCardValue(source, [`${model}_rate`, `${model}Rate`, `${model}_commission`]);
    if (direct) return normalizeCardPercent(direct);
    const targetSchema = normalizeCommissionSchema(model);
    const commissionEntries = collectCommissionEntries(source);
    const matchedEntry = matchCommissionEntry(commissionEntries, targetSchema);
    if (matchedEntry?.value) return normalizeCardPercent(matchedEntry.value);
    const raw = source?.category_commission || source?.categoryCommission;
    if (!raw) return '--';
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return normalizeCardPercent(raw);
      }
    }
    const schema = String(model || '').toLowerCase();
    if (Array.isArray(parsed)) {
      const item = parsed.find((entry) => {
        const name = String(entry?.sales_schema || entry?.sale_schema || entry?.delivery_schema || entry?.schema || '').toLowerCase();
        return name.includes(schema) || (schema === 'rfbs' && name === 'fbs');
      }) || parsed[0];
      return normalizeCardPercent(item?.value ?? item?.percent ?? item?.rate ?? '');
    }
    if (typeof parsed !== 'object' || parsed === null) return normalizeCardPercent(parsed);
    const entries = Object.entries(parsed).filter(([key]) => String(key).toLowerCase().startsWith(schema));
    if (entries.length === 0) return '--';
    const price = cardNumberValue(pickCardValue(source, ['price', 'productPrice', 'sell_price', 'cardPrice']));
    const ranked = entries
      .map(([key, value]) => {
        const parts = String(key).toLowerCase().split('_');
        const amount = Number(parts.find((part) => /^\d+$/.test(part)) || 0);
        const condition = parts.includes('gt') || parts.includes('geq') ? 'gt' : 'leq';
        return { key, value, amount, condition };
      })
      .sort((a, b) => a.amount - b.amount);
    const matched = price == null
      ? ranked[0]
      : ranked.find((item) => item.condition === 'leq' && price <= item.amount) ||
        ranked.slice().reverse().find((item) => item.condition === 'gt' && price > item.amount) ||
        ranked[ranked.length - 1];
    return normalizeCardPercent(matched?.value);
  }

  function resolveCardDisplayProduct(row) {
    const lookupProduct = row?.erpLookup?.product && typeof row.erpLookup.product === 'object'
      ? row.erpLookup.product
      : {};
    const product = {
      ...row,
      ...lookupProduct,
      sku: String(row?.sku || lookupProduct.sku || '').trim()
    };
    product.productTitle = product.productTitle || product.name || product.title || row?.title || '';
    product.name = product.name || product.productTitle || product.title || '';
    product.title = product.title || product.productTitle || product.name || '';
    product.productImage = product.productImage || product.mainImage || product.image || (Array.isArray(product.images) ? product.images[0] : '');
    product.mainImage = product.mainImage || product.productImage || '';
    product.price = pickCardValue(product, ['cardPrice', 'price', 'productPrice', 'sell_price']);
    product.webPrice = pickCardValue(product, ['webPrice', 'price']);
    product.cardPrice = pickCardValue(product, ['cardPrice', 'price', 'productPrice', 'sell_price']);
    product.originalPrice = pickCardValue(product, ['originalPrice']);
    product.ozonProductIntelligence = row?.ozonProductIntelligence || lookupProduct.ozonProductIntelligence || null;
    return product;
  }

  function readPathValue(source, path) {
    if (!source || !path) return '';
    return String(path).split('.').reduce((value, key) => (
      value && typeof value === 'object' ? value[key] : undefined
    ), source);
  }

  function formatIntelligenceList(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[;\n]/).filter(Boolean);
    return list.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3).join('、');
  }

  function formatRiskLevel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'low') return '低风险';
    if (normalized === 'medium') return '中风险';
    if (normalized === 'high') return '高风险';
    return value || '';
  }

  function cardPercentNumber(value) {
    const number = cardNumberValue(value);
    if (number === null) return null;
    return number > 0 && number <= 1 ? number * 100 : number;
  }

  function resolvePreferredCommissionPercent(product) {
    const schema = String(pickCardValue(product, ['salesSchema', 'sales_schema']) || '').trim().toLowerCase();
    const schemaKeys = schema.includes('rfbs')
      ? ['rfbs', 'fbs', 'fbo']
      : schema.includes('fbo') || schema.includes('fbp')
        ? ['fbo', 'fbs', 'rfbs']
        : ['fbs', 'rfbs', 'fbo'];
    for (const key of schemaKeys) {
      const value = parseCardCommission(product, key);
      const percent = cardPercentNumber(value);
      if (percent !== null) return percent;
    }
    return null;
  }

  function resolveSellerPriceRaw(product) {
    return pickCardValue(product, [
      'webPrice',
      'sellerPrice',
      'seller_price',
      'sellerSellPrice',
      'seller_sell_price',
      'currentPrice',
      'current_price',
      'price',
      'productPrice',
      'sell_price',
      'cardPrice'
    ]);
  }

  function resolveSellerPriceSource(product) {
    const candidates = [
      ['webPrice', '卖家真实售价'],
      ['sellerPrice', '卖家真实售价'],
      ['seller_price', '卖家真实售价'],
      ['sellerSellPrice', '卖家真实售价'],
      ['seller_sell_price', '卖家真实售价'],
      ['currentPrice', '页面当前售价'],
      ['current_price', '页面当前售价'],
      ['price', '价格字段'],
      ['productPrice', '商品售价字段'],
      ['sell_price', '销售价字段'],
      ['cardPrice', 'Ozon卡价兜底']
    ];
    for (const [key, label] of candidates) {
      if (hasFilledValue(product?.[key])) return { key, label };
    }
    return { key: '', label: '缺少售价' };
  }

  function resolveCardPriceNumber(product) {
    return cardNumberValue(resolveSellerPriceRaw(product));
  }

  function resolveRiskSafetyFactor(product) {
    const level = String(readPathValue(product.ozonProductIntelligence, 'computed.riskLevel') || '').toLowerCase();
    if (level === 'high') return 0.7;
    if (level === 'medium') return 0.8;
    return 0.85;
  }

  function roundCardMoneyNumber(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  function firstCardNumber(product, keys, fallback = 0) {
    const value = cardNumberValue(pickCardValue(product, keys));
    return value === null ? fallback : value;
  }

  function normalizeRateValue(value, fallback = 0) {
    const number = cardNumberValue(value);
    if (number === null) return fallback;
    return number > 1 ? number / 100 : number;
  }

  function resolveRateWithSource(product, keys, fallback, fallbackLabel) {
    for (const [key, label] of keys) {
      const raw = pickCardValue(product, [key]);
      if (raw === '') continue;
      const number = cardNumberValue(raw);
      if (number === null) continue;
      return {
        rate: normalizeRateValue(raw, fallback),
        sourceKey: key,
        sourceLabel: label,
        isFallback: false
      };
    }
    return {
      rate: fallback,
      sourceKey: '',
      sourceLabel: fallbackLabel,
      isFallback: true
    };
  }

  function resolveReturnRateMeta(product) {
    return resolveRateWithSource(product, [
      ['nullableRedemptionRate', 'Seller真实退货率'],
      ['return_rate', '商品退货率'],
      ['returnRate', '商品退货率'],
      ['returnCancelRate', '退货取消率'],
      ['return_cancel_rate', '退货取消率']
    ], 0.05, '默认退货率');
  }

  function resolveAdvertisingRateMeta(product) {
    return resolveRateWithSource(product, [
      ['advertising_rate', '商品广告费率'],
      ['advertisingRate', '商品广告费率'],
      ['drr', 'Seller广告费占比'],
      ['adCostRatio', '广告费占比'],
      ['ad_cost_ratio', '广告费占比']
    ], 0, '默认广告费率');
  }

  function calculateFinalMileBankFeeLocal(saleRmb) {
    const sale = Number(saleRmb || 0);
    const tierFee = sale < 50 ? 1 : sale >= 750 ? 15 : sale * 0.02;
    return roundCardMoneyNumber(sale * 0.014 + tierFee);
  }

  function calculateWithdrawalFeeLocal({ saleRmb, freightAmount = 0, finalMileBankFee = 0, withdrawalRate = 0.012, withdrawalCommissionRate = 0.2 }) {
    const base = Number(saleRmb || 0) - Number(finalMileBankFee || 0) - Number(freightAmount || 0) - Number(saleRmb || 0) * Number(withdrawalCommissionRate || 0.2);
    return roundCardMoneyNumber(Math.max(0, base) * Number(withdrawalRate || 0.012));
  }

  const DEFAULT_PACKAGING_FEE_RULE = {
    low_sale_threshold_cny: 50,
    low_fee_cny: 0.5,
    high_fee_cny: 1
  };

  function packagingFeeForSaleAmountLocal(saleAmountCny) {
    const sale = Number(saleAmountCny || 0);
    const threshold = Number(DEFAULT_PACKAGING_FEE_RULE.low_sale_threshold_cny || 0);
    const lowFee = Number(DEFAULT_PACKAGING_FEE_RULE.low_fee_cny || 0);
    const highFee = Number(DEFAULT_PACKAGING_FEE_RULE.high_fee_cny || 0);
    return roundCardMoneyNumber(sale > threshold ? highFee : lowFee);
  }

  function resolvePackagingFeeMeta(product, priceCny) {
    const explicit = cardNumberValue(pickCardValue(product, [
      'handling_fee',
      'handlingFee',
      'packaging_cost_cny',
      'packagingCost',
      'packaging_fee_cny'
    ]));
    if (explicit !== null && explicit > 0) {
      return { amount: explicit, source: '已录入包装费', isFallback: false };
    }
    return {
      amount: packagingFeeForSaleAmountLocal(priceCny),
      source: `默认包装费规则(≤${DEFAULT_PACKAGING_FEE_RULE.low_sale_threshold_cny}元:${DEFAULT_PACKAGING_FEE_RULE.low_fee_cny}元,>${DEFAULT_PACKAGING_FEE_RULE.low_sale_threshold_cny}元:${DEFAULT_PACKAGING_FEE_RULE.high_fee_cny}元)`,
      isFallback: true
    };
  }

  function resolveRubPerCnyRate(product) {
    const direct = cardNumberValue(pickCardValue(product, [
      'exchange_rate',
      'exchangeRate',
      'rubCnyRate',
      'rub_cny_rate',
      'rateRubCny'
    ]));
    return direct && direct > 0 ? direct : 11.32;
  }

  function rubToCny(value, product) {
    const number = Number(value);
    const rate = resolveRubPerCnyRate(product);
    if (!Number.isFinite(number) || !Number.isFinite(rate) || rate <= 0) return null;
    return roundCardMoneyNumber(number / rate);
  }

  const CEL_RFBS_RULES = [
    { category: 'Extra Small', label: '超级轻小件', minRub: 1, maxRub: 1500, minKg: 0.001, maxKg: 0.5, maxSumCm: 90, maxSideCm: 60, chargeByVolume: false, channels: { standard: { name: 'CEL Standard Extra Small', perGram: 0.0364, perTicket: 3.12 } } },
    { category: 'Budget', label: '低客单价标准件', minRub: 1, maxRub: 1500, minKg: 0.501, maxKg: 30, maxSumCm: 150, maxSideCm: 60, chargeByVolume: false, channels: { standard: { name: 'CEL Standard Budget', perGram: 0.026, perTicket: 23.92 } } },
    { category: 'Small', label: '小件', minRub: 1501, maxRub: 7000, minKg: 0.001, maxKg: 2, maxSumCm: 150, maxSideCm: 60, chargeByVolume: false, channels: { standard: { name: 'CEL Standard Small', perGram: 0.0364, perTicket: 16.64 } } },
    { category: 'Big', label: '大件', minRub: 1501, maxRub: 7000, minKg: 2.001, maxKg: 30, maxSumCm: 310, maxSideCm: 150, maxVolumetricKg: 31, chargeByVolume: true, volumetricDivisor: 12000, channels: { standard: { name: 'CEL Standard Big', perGram: 0.026, perTicket: 37.44 } } },
    { category: 'Premium Small', label: '高客单价小件', minRub: 7001, maxRub: 250000, minKg: 0.001, maxKg: 5, maxSumCm: 250, maxSideCm: 150, chargeByVolume: false, channels: { standard: { name: 'CEL Standard Premium Small', perGram: 0.0364, perTicket: 22.88 } } },
    { category: 'Premium Big', label: '高客单价大件', minRub: 7001, maxRub: 250000, minKg: 5.001, maxKg: 30, maxSumCm: 310, maxSideCm: 150, maxVolumetricKg: 80, chargeByVolume: true, volumetricDivisor: 6000, hundredGramCeil: true, channels: { standard: { name: 'CEL Standard Premium Big', perGram: 0.02912, perTicket: 64.48 } } }
  ];

  function resolveListingPriceRub(product, priceCny) {
    const direct = cardNumberValue(pickCardValue(product, [
      'listing_price_rub',
      'listingPriceRub',
      'priceRub',
      'cardPriceRub',
      'webPriceRub',
      'soldPriceRub'
    ]));
    if (direct !== null && direct > 0) return direct;
    const rate = resolveRubPerCnyRate(product);
    const sale = Number(priceCny || 0);
    return sale > 0 && rate > 0 ? roundCardMoneyNumber(sale * rate) : 0;
  }

  function resolveCommissionPercentMeta(product, priceCny) {
    const parsed = resolvePreferredCommissionPercent(product);
    if (parsed !== null) {
      return { percent: parsed, rate: parsed / 100, source: 'Seller/类目佣金', isFallback: false };
    }
    const listingPriceRub = resolveListingPriceRub(product, priceCny);
    const percent = listingPriceRub > 0 && listingPriceRub <= 1500 ? 12 : 17;
    return { percent, rate: percent / 100, source: `rFBS保底佣金(${listingPriceRub <= 1500 ? '≤1500 RUB' : '>1500 RUB'})`, isFallback: true };
  }

  function resolveWeightKgForCel(product) {
    const raw = pickCardValue(product, [
      'weight_kg',
      'weightKg',
      'package_weight_kg',
      'custom_weight',
      'weight_g',
      'weightG',
      'package_weight_g',
      'packageWeightG',
      'weight'
    ]);
    if (!hasFilledValue(raw)) return null;
    const text = String(raw).toLowerCase();
    const value = cardNumberValue(text);
    if (value === null || value <= 0) return null;
    if (/kg|кг/.test(text)) return value;
    if (/g|гр|г\b/.test(text)) return value / 1000;
    return value > 20 ? value / 1000 : value;
  }

  function parseDimensionsFromText(value, defaultUnit = '') {
    if (!hasFilledValue(value)) return null;
    if (value && typeof value === 'object') {
      const lengthRaw = value.length ?? value.length_cm ?? value.lengthCm ?? value.depth ?? value.depth_cm ?? value.depthCm;
      const widthRaw = value.width ?? value.width_cm ?? value.widthCm;
      const heightRaw = value.height ?? value.height_cm ?? value.heightCm;
      const nums = [lengthRaw, widthRaw, heightRaw].map((item) => cardNumberValue(item));
      if (nums.every((num) => num !== null && num > 0)) {
        const unit = String(value.unit || value.dimension_unit || defaultUnit).toLowerCase();
        const divisor = /mm|мм/.test(unit) || nums.some((num) => num > 200) ? 10 : 1;
        return { length: nums[0] / divisor, width: nums[1] / divisor, height: nums[2] / divisor };
      }
    }
    const matches = String(value).match(/\d+(?:[.,]\d+)?/g);
    if (!matches || matches.length < 3) return null;
    const nums = matches.slice(0, 3).map((item) => Number(String(item).replace(',', '.')));
    if (nums.some((num) => !Number.isFinite(num) || num <= 0)) return null;
    const text = `${String(value).toLowerCase()} ${String(defaultUnit || '').toLowerCase()}`;
    const divisor = /mm|мм/.test(text) || nums.some((num) => num > 200) ? 10 : 1;
    return { length: nums[0] / divisor, width: nums[1] / divisor, height: nums[2] / divisor };
  }

  function resolveDimensionsCmForCel(product) {
    const textValue = pickCardValue(product, [
      'custom_volume',
      'real_dimensions',
      'dimensions',
      'dimension',
      'package_dimensions',
      'size'
    ]);
    const parsed = parseDimensionsFromText(textValue, 'mm');
    if (parsed) return parsed;
    const cmValues = [
      pickCardValue(product, ['length_cm', 'lengthCm']),
      pickCardValue(product, ['width_cm', 'widthCm']),
      pickCardValue(product, ['height_cm', 'heightCm'])
    ].map((value) => cardNumberValue(value));
    if (cmValues.every((value) => value !== null && value > 0)) {
      return { length: cmValues[0], width: cmValues[1], height: cmValues[2] };
    }
    const mmValues = [
      pickCardValue(product, ['length', 'depth', 'depth_mm']),
      pickCardValue(product, ['width', 'width_mm']),
      pickCardValue(product, ['height', 'height_mm'])
    ].map((value) => cardNumberValue(value));
    if (mmValues.some((value) => value === null || value <= 0)) return null;
    const divisor = mmValues.some((value) => value > 60) ? 10 : 1;
    return { length: mmValues[0] / divisor, width: mmValues[1] / divisor, height: mmValues[2] / divisor };
  }

  function celVolumetricWeight(length, width, height, divisor = 12000) {
    return roundCardMoneyNumber((Number(length || 0) * Number(width || 0) * Number(height || 0)) / divisor);
  }

  function celChargeableWeight(rule, size) {
    if (!rule.chargeByVolume) return Math.max(Number(size.weightKg || 0), 0);
    return Math.max(Number(size.weightKg || 0), celVolumetricWeight(size.length, size.width, size.height, rule.volumetricDivisor || 12000));
  }

  function matchCelRfbsRule({ listingPriceRub, weightKg, length, width, height }) {
    const sum = length + width + height;
    const maxSide = Math.max(length, width, height);
    const volumeKg = celVolumetricWeight(length, width, height);
    return CEL_RFBS_RULES.find((rule) => {
      const charged = celChargeableWeight(rule, { weightKg, length, width, height });
      if (listingPriceRub < rule.minRub || listingPriceRub > rule.maxRub) return false;
      if (weightKg < rule.minKg || weightKg > rule.maxKg) return false;
      if (charged > rule.maxKg) return false;
      if (rule.maxVolumetricKg && volumeKg > rule.maxVolumetricKg) return false;
      if (sum > rule.maxSumCm || maxSide > rule.maxSideCm) return false;
      return true;
    }) || null;
  }

  function estimateCelInternationalFreight(product, priceCny) {
    const listingPriceRub = resolveListingPriceRub(product, priceCny);
    const weightKg = resolveWeightKgForCel(product);
    const dimensions = resolveDimensionsCmForCel(product);
    if (!listingPriceRub || !weightKg || !dimensions) {
      const missing = [];
      if (!listingPriceRub) missing.push('售价');
      if (!weightKg) missing.push('重量');
      if (!dimensions) missing.push('尺寸');
      return { amount: 0, missing, matched: false };
    }
    const rule = matchCelRfbsRule({ listingPriceRub, weightKg, ...dimensions });
    if (!rule) {
      return {
        amount: 0,
        missing: ['CEL规则匹配'],
        matched: false,
        listingPriceRub,
        weightKg,
        detail: `售价:${roundCardMoneyNumber(listingPriceRub)} RUB; 重量:${roundCardMoneyNumber(weightKg)}kg; 尺寸:${roundCardMoneyNumber(dimensions.length)}x${roundCardMoneyNumber(dimensions.width)}x${roundCardMoneyNumber(dimensions.height)}cm`,
        ...dimensions
      };
    }
    const channel = rule.channels.standard || Object.values(rule.channels)[0];
    const chargedKg = celChargeableWeight(rule, { weightKg, ...dimensions });
    const billedGrams = rule.hundredGramCeil ? Math.ceil((chargedKg * 1000) / 100) * 100 : chargedKg * 1000;
    const amount = roundCardMoneyNumber(billedGrams * channel.perGram + channel.perTicket);
    return {
      amount,
      matched: true,
      source: 'CEL标准线估算',
      rule: rule.label || rule.category,
      channel: channel.name,
      listingPriceRub,
      weightKg,
      chargeableWeightKg: chargedKg,
      ...dimensions
    };
  }

  function resolveInternationalFreightMeta(product, priceCny) {
    const explicit = cardNumberValue(pickCardValue(product, [
      'international_shipping',
      'internationalShipping',
      'international_shipping_cny',
      'freightAmount',
      'freight_amount',
      'freight'
    ]));
    if (explicit !== null && explicit > 0) {
      return { amount: explicit, source: '已录入国际运费', isEstimated: false, missing: [] };
    }
    const estimate = estimateCelInternationalFreight(product, priceCny);
    if (estimate.matched) {
      return {
        amount: estimate.amount,
        source: estimate.source,
        isEstimated: true,
        missing: [],
        detail: `规则:${estimate.rule}; 计费重:${roundCardMoneyNumber(estimate.chargeableWeightKg)}kg; 尺寸:${roundCardMoneyNumber(estimate.length)}x${roundCardMoneyNumber(estimate.width)}x${roundCardMoneyNumber(estimate.height)}cm`
      };
    }
    return { amount: 0, source: '缺少CEL估算参数', isEstimated: false, missing: estimate.missing || ['国际运费'], detail: estimate.detail || '' };
  }

  function formatCardCny(value) {
    if (value === undefined || value === null || value === '') return '--';
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value || '--');
    return `¥${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function resolveCardPriceCny(product) {
    const price = resolveCardPriceNumber(product);
    return price === null ? '' : formatCardCny(price);
  }

  function buildBreakevenEstimate(product) {
    const price = resolveCardPriceNumber(product);
    const rate = resolveRubPerCnyRate(product);
    if (price === null) {
      return {
        price: null,
        priceCny: null,
        exchangeRate: rate,
        commissionPercent: null,
        commissionAmount: null,
        commissionAmountCny: null,
        breakevenLimit: null,
        breakevenLimitCny: null,
        suggestedCost: null,
        suggestedCostCny: null,
        completeness: '残缺',
        completenessDetail: '缺少售价，无法反推保本成本',
        missingItems: ['售价']
      };
    }
    const priceCny = price;
    const commissionMeta = resolveCommissionPercentMeta(product, priceCny);
    const commissionPercent = commissionMeta.percent;
    const commissionRate = commissionPercent === null ? 0 : commissionPercent / 100;
    const commissionAmountCny = priceCny === null ? null : roundCardMoneyNumber(priceCny * commissionRate);
    const commissionAmount = commissionAmountCny === null ? null : roundCardMoneyNumber(commissionAmountCny * rate);
    const domesticShippingCny = firstCardNumber(product, ['domestic_shipping', 'domesticShipping', 'domestic_shipping_cny'], 0);
    const freightMeta = resolveInternationalFreightMeta(product, priceCny);
    const freightAmountCny = freightMeta.amount || 0;
    const packagingMeta = resolvePackagingFeeMeta(product, priceCny);
    const packagingFeeCny = packagingMeta.amount || 0;
    const returnRateMeta = resolveReturnRateMeta(product);
    const advertisingRateMeta = resolveAdvertisingRateMeta(product);
    const returnRate = returnRateMeta.rate;
    const advertisingRate = advertisingRateMeta.rate;
    const withdrawalRate = normalizeRateValue(pickCardValue(product, ['withdrawal_fee_rate', 'withdrawalFeeRate']), 0.012);
    const withdrawalCommissionRate = normalizeRateValue(pickCardValue(product, ['withdrawal_commission_rate', 'withdrawalCommissionRate']), 0.2);
    const finalMileBankFeeCny = priceCny === null ? null : calculateFinalMileBankFeeLocal(priceCny);
    const withdrawalFeeCny = priceCny === null || finalMileBankFeeCny === null
      ? null
      : calculateWithdrawalFeeLocal({
          saleRmb: priceCny,
          freightAmount: freightAmountCny,
          finalMileBankFee: finalMileBankFeeCny,
          withdrawalRate,
          withdrawalCommissionRate
        });
    const advertisingCostCny = priceCny === null ? null : roundCardMoneyNumber(priceCny * advertisingRate);
    const knownFixedBeforeReturn = domesticShippingCny + packagingFeeCny + freightAmountCny;
    const fixedFees = (commissionAmountCny || 0) + (finalMileBankFeeCny || 0) + (withdrawalFeeCny || 0) + (advertisingCostCny || 0);
    const breakevenLimitCny = priceCny === null
      ? null
      : roundCardMoneyNumber((priceCny - fixedFees - knownFixedBeforeReturn * (1 + returnRate)) / (1 + returnRate));
    const safeBreakevenLimitCny = breakevenLimitCny === null ? null : Math.max(0, breakevenLimitCny);
    const breakevenLimit = safeBreakevenLimitCny === null ? null : roundCardMoneyNumber(safeBreakevenLimitCny * rate);
    const suggestedCostCny = safeBreakevenLimitCny === null ? null : roundCardMoneyNumber(safeBreakevenLimitCny * resolveRiskSafetyFactor(product));
    const suggestedCost = suggestedCostCny === null ? null : roundCardMoneyNumber(suggestedCostCny * rate);
    const completeParts = [];
    const missingItems = [];
    completeParts.push(`${commissionMeta.source} ${commissionPercent}%`);
    if (freightAmountCny > 0) completeParts.push(`${freightMeta.source} ${formatCardCny(freightAmountCny)}`);
    else {
      completeParts.push('国际运费缺失/按0');
      (freightMeta.missing || ['国际运费']).forEach((item) => missingItems.push(item));
    }
    completeParts.push(domesticShippingCny > 0 ? '国内运费已扣' : '国内运费默认0');
    completeParts.push(`${packagingMeta.source} ${formatCardCny(packagingFeeCny)}`);
    if (advertisingRateMeta.isFallback) {
      completeParts.push('广告费率按0');
      missingItems.push('广告费率');
    } else {
      completeParts.push(`${advertisingRateMeta.sourceLabel}已扣`);
    }
    completeParts.push(`${returnRateMeta.sourceLabel} ${(returnRate * 100).toFixed(1)}%`);
    completeParts.push(`汇率 ${rate} RUB/CNY`);
    if (returnRateMeta.isFallback) missingItems.push('真实退货率');
    const completeness = missingItems.length ? '残缺' : '完整';
    const completenessDetail = missingItems.length
      ? `缺少：${missingItems.join('、')}。已按0或默认值参与初筛反推。${completeParts.join('，')}`
      : `费用完整：${completeParts.join('，')}`;
    return {
      price,
      priceCny,
      exchangeRate: rate,
      commissionPercent,
      commissionSource: commissionMeta.source,
      commissionIsFallback: commissionMeta.isFallback,
      commissionAmount,
      commissionAmountCny,
      domesticShippingCny,
      freightAmountCny,
      freightSource: freightMeta.source,
      freightIsEstimated: freightMeta.isEstimated,
      freightDetail: freightMeta.detail || '',
      packagingFeeCny,
      packagingFeeSource: packagingMeta.source,
      packagingFeeIsFallback: packagingMeta.isFallback,
      finalMileBankFeeCny,
      withdrawalFeeCny,
      advertisingRate,
      advertisingRateSource: advertisingRateMeta.sourceLabel,
      advertisingRateIsFallback: advertisingRateMeta.isFallback,
      advertisingCostCny,
      returnRate,
      returnRateSource: returnRateMeta.sourceLabel,
      returnRateIsFallback: returnRateMeta.isFallback,
      withdrawalRate,
      withdrawalCommissionRate,
      breakevenLimit,
      breakevenLimitCny: safeBreakevenLimitCny,
      suggestedCost,
      suggestedCostCny,
      completeness,
      completenessDetail,
      missingItems
    };
  }

  function buildBreakevenFormulaTooltip(product, targetKey = '') {
    const estimate = buildBreakevenEstimate(product);
    if (estimate.price === null) return '缺少卖家真实售价，无法反推保本成本';
    const missingText = estimate.missingItems?.length ? `缺：${estimate.missingItems.join('、')}` : '费用完整';
    return [
      missingText,
      `售价：${formatCardCny(estimate.priceCny)}`,
      `Ozon佣金：${formatCardCny(estimate.commissionAmountCny || 0)}（${estimate.commissionPercent}%）`,
      `国际运费：${formatCardCny(estimate.freightAmountCny || 0)}（${estimate.freightSource || '-'}）`,
      estimate.freightDetail ? `运费构成：${estimate.freightDetail}` : '',
      `国内运费：${formatCardCny(estimate.domesticShippingCny || 0)}`,
      `包装/处理：${formatCardCny(estimate.packagingFeeCny || 0)}（${estimate.packagingFeeSource || '-'}）`,
      `尾程+收单：${formatCardCny(estimate.finalMileBankFeeCny || 0)}`,
      `提现/回款：${formatCardCny(estimate.withdrawalFeeCny || 0)}`,
      `广告费：${formatCardCny(estimate.advertisingCostCny || 0)}（${(estimate.advertisingRate * 100).toFixed(1)}%）`,
      `退货率：${(estimate.returnRate * 100).toFixed(1)}%`,
      `保本成本上限：${formatCardCny(estimate.breakevenLimitCny)}`,
      `建议采购成本：${formatCardCny(estimate.suggestedCostCny)}`
    ].filter(Boolean).join('`n');
  }

  function resolveBreakevenCostLimit(product) {
    const estimate = buildBreakevenEstimate(product);
    return estimate.breakevenLimitCny === null ? '' : formatCardCny(estimate.breakevenLimitCny);
  }

  function resolveSuggestedPurchaseCost(product) {
    const estimate = buildBreakevenEstimate(product);
    return estimate.suggestedCostCny === null ? '' : `≤${formatCardCny(estimate.suggestedCostCny)}`;
  }

  function resolveFeeCompleteness(product) {
    return buildBreakevenEstimate(product).completeness;
  }

  function resolveEstimatedInternationalFreightValue(product) {
    const estimate = buildBreakevenEstimate(product);
    if (estimate.freightAmountCny > 0) return formatCardCny(estimate.freightAmountCny);
    const missing = estimate.missingItems?.filter((item) => /国际运费|重量|尺寸|售价|CEL/.test(String(item))) || [];
    return missing.length ? `缺${missing.join('/')}` : '缺参数';
  }

  function metricPercentValue(product, keys) {
    return cardPercentNumber(pickCardValue(product, Array.isArray(keys) ? keys : [keys]));
  }

  function resolveFunnelJudgement(product) {
    const clickRate = metricPercentValue(product, ['custom_click_rate']);
    const cartRate = metricPercentValue(product, ['convToCart', 'pdpToCartConversion', 'convToCartPdp']);
    const conversionRate = metricPercentValue(product, ['convViewToOrder']);
    const issues = [];
    if (clickRate !== null && clickRate < 3) issues.push('点击弱');
    if (cartRate !== null && cartRate < 1) issues.push('加购弱');
    if (conversionRate !== null && conversionRate < 0.2) issues.push('成交弱');
    return issues.length ? issues.join('、') : '漏斗相对健康';
  }

  function resolvePromoDependency(product) {
    const adCostRatio = metricPercentValue(product, ['drr']);
    const promoShare = metricPercentValue(product, ['promoRevenueShare']);
    const adDependent = adCostRatio !== null && adCostRatio >= 20;
    const promoDriven = promoShare !== null && promoShare >= 50;
    if (adDependent && promoDriven) return '广告+促销双依赖';
    if (adDependent) return '广告依赖';
    if (promoDriven) return '促销驱动';
    if ((adCostRatio !== null && adCostRatio < 10) && (promoShare === null || promoShare < 30)) return '自然相对健康';
    return '需观察';
  }

  function resolveRegistryFieldValue(field, product) {
    const salesSchema = pickCardValue(product, ['salesSchema']);
    const resolver = String(field.resolver || '');
    if (resolver === 'sku') return product.sku;
    if (resolver === 'salesSchema') return salesSchema;
    if (resolver === 'webPrice') return buildMoneyValue(product.webPrice, product.currency);
    if (resolver === 'cardPrice') return buildMoneyValue(product.cardPrice, product.currency);
    if (resolver === 'originalPrice') return buildMoneyValue(product.originalPrice, product.currency);
    if (resolver === 'monthlyRevenue') return formatCardMoney(pickCardValue(product, ['soldSumRub', 'soldSum', 'gmvSum']));
    if (resolver === 'createdAt') return normalizeCreateDateValue(pickCardValue(product, ['nullableCreateDate']));
    if (resolver === 'createAgeDays') return formatCreateAgeDays(pickCardValue(product, ['nullableCreateDate']), pickCardValue(product, ['createDays']));
    if (resolver === 'cardPriceCny') return resolveCardPriceCny(product);
    if (resolver === 'breakevenCostLimit') return resolveBreakevenCostLimit(product);
    if (resolver === 'suggestedPurchaseCost') return resolveSuggestedPurchaseCost(product);
    if (resolver === 'feeCompleteness') return resolveFeeCompleteness(product);
    if (resolver === 'estimatedInternationalFreight') return resolveEstimatedInternationalFreightValue(product);
    if (resolver === 'funnelJudgement') return resolveFunnelJudgement(product);
    if (resolver === 'promoDependency') return resolvePromoDependency(product);
    if (resolver === 'commission:rfbs') {
      const estimate = buildBreakevenEstimate(product);
      return estimate.commissionPercent === null ? '--' : `${estimate.commissionPercent}%`;
    }
    if (resolver.startsWith('commission:')) {
      return parseCardCommission(product, resolver.slice('commission:'.length));
    }
    if (resolver.startsWith('percent:')) {
      return normalizeCardPercent(pickCardValue(product, resolver.slice('percent:'.length).split(',')));
    }
    if (resolver.startsWith('unit:')) {
      const [, paths = '', unit = ''] = resolver.split(':');
      const unitPattern = unit === 'g' ? /\b(?:g|kg|г|кг)\b/i : /\b(?:mm|cm|m|мм|см|м)\b/i;
      return formatCardValueWithUnit(pickCardValue(product, paths.split(',')), unit, unitPattern);
    }
    if (resolver.startsWith('intelligence:')) {
      return readPathValue(product.ozonProductIntelligence, resolver.slice('intelligence:'.length));
    }
    if (resolver.startsWith('intelligenceList:')) {
      return formatIntelligenceList(readPathValue(product.ozonProductIntelligence, resolver.slice('intelligenceList:'.length)));
    }
    if (resolver === 'riskLevel') {
      return formatRiskLevel(readPathValue(product.ozonProductIntelligence, 'computed.riskLevel'));
    }
    return pickCardValue(product, field.paths || []);
  }

  function resolveRegistryFieldTooltip(field, product) {
    if (['web_price', 'breakeven_cost_limit', 'suggested_purchase_cost', 'fee_completeness', 'estimated_international_freight'].includes(field.key)) {
      return buildBreakevenFormulaTooltip(product, field.key);
    }
    if (['rfbs_commission', 'fbs_commission', 'fbo_commission'].includes(field.key)) {
      return '佣金为 Ozon 平台佣金百分比，保本反推会按当前发货模式优先匹配对应佣金。';
    }
    return '';
  }

  function resolveRegistryFieldTone(field, product) {
    if (field.key === 'sales_schema') {
      return String(pickCardValue(product, ['salesSchema']) || '').toUpperCase().includes('FBS') ? 'orange' : 'base';
    }
    if (field.key === 'risk_level') {
      const level = String(readPathValue(product.ozonProductIntelligence, 'computed.riskLevel') || '').toLowerCase();
      if (level === 'high') return 'danger';
      if (level === 'medium') return 'orange';
      if (level === 'low') return 'sales';
    }
    if (field.key === 'product_score') {
      const score = Number(readPathValue(product.ozonProductIntelligence, 'computed.productScore'));
      if (Number.isFinite(score)) {
        if (score >= 78) return 'sales';
        if (score >= 60) return 'orange';
        return 'danger';
      }
    }
    if (field.key === 'create_age_days') {
      const days = resolveCreateAgeDaysNumber(pickCardValue(product, ['nullableCreateDate']), pickCardValue(product, ['createDays']));
      if (days !== null && days < 30) return 'orange';
    }
    if (field.key === 'fee_completeness') {
      return buildBreakevenEstimate(product).completeness === '完整' ? 'sales' : 'orange';
    }
    return field.tone || 'base';
  }

  function getDetailCardFieldDefinitions() {
    if (typeof fieldRegistry.getDetailCardFields === 'function') {
      return fieldRegistry.getDetailCardFields();
    }
    return [];
  }

  function buildCardMetricRows(row) {
    const product = resolveCardDisplayProduct(row);
    const visibleKeys = getVisibleFieldKeySet();
    const hasCustomVisibleKeys = Boolean(getSavedVisibleFieldKeySet());
    const defs = getDetailCardFieldDefinitions()
      .filter((field) => !visibleKeys || visibleKeys.has(field.key))
      .map((field) => ({
      ...field,
      value: resolveRegistryFieldValue(field, product),
      tone: resolveRegistryFieldTone(field, product),
      tooltip: resolveRegistryFieldTooltip(field, product)
    }));
    return defs
      .filter((item) => hasCustomVisibleKeys || !item.optional || hasCardMetricValue(item.value))
      .map((item) => ({
        ...item,
        value: normalizeCardDisplayValue(item.value)
      }));
  }

  async function saveVisibleFieldKeys(keys) {
    const normalizedKeys = normalizeVisibleFieldKeys(keys);
    state.settings.visibleFieldKeys = normalizedKeys;
    if (normalizedKeys) {
      await chrome.storage.local.set({ [FIELD_VISIBILITY_STORAGE_KEY]: normalizedKeys });
    } else {
      await chrome.storage.local.remove(FIELD_VISIBILITY_STORAGE_KEY);
    }
    if (state.detailUiRow) {
      renderDetailProductPanel(state.detailUiRow);
    }
    rerenderVisibleListPanels();
  }

  function rerenderVisibleListPanels() {
    if (!state.settings.injectCards || !Array.isArray(state.listRows) || state.listRows.length === 0) return;
    const bySku = new Map(state.listRows.map((row) => [String(row?.sku || '').trim(), row]).filter(([sku]) => sku));
    renderListCardPanels(bySku, Math.max(LIST_SCAN_LIMIT, state.listRows.length));
  }

  function openFieldSettingsModal() {
    const fields = getDetailCardFieldDefinitions();
    const selectedKeys = getVisibleFieldKeySet() || new Set(fields.map((field) => field.key));
    const grouped = [];
    for (const field of fields) {
      let group = grouped.find((item) => item.title === field.group);
      if (!group) {
        group = { title: field.group || '其他', items: [] };
        grouped.push(group);
      }
      group.items.push(field);
    }

    const root = ensureRoot();
    root.querySelector('.ozon-erp-field-settings-mask')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ozon-erp-modal-mask ozon-erp-field-settings-mask';
    mask.innerHTML = `
      <div class="ozon-erp-modal ozon-erp-field-settings">
        <div class="ozon-erp-modal-head">
          <div class="ozon-erp-field-settings-heading">
            <span class="ozon-erp-field-settings-kicker">显示字段</span>
            <strong>编辑插件展示字段</strong>
            <span>按选品初筛流程勾选需要展示的字段，配置会保存在当前浏览器。</span>
          </div>
          <div class="ozon-erp-modal-actions">
            <button type="button" data-action="close">关闭</button>
          </div>
        </div>
        <div class="ozon-erp-field-settings-body">
          ${grouped.map((group, groupIndex) => `
            <section class="ozon-erp-field-settings-group" data-field-group="${groupIndex}">
              <div class="ozon-erp-field-settings-title">
                <span>${escapeHtml(group.title)}</span>
                <em>${group.items.length} 项</em>
                <span class="ozon-erp-field-settings-title-actions">
                  <button type="button" data-action="select-group" data-field-group="${groupIndex}">全选</button>
                  <button type="button" data-action="clear-group" data-field-group="${groupIndex}">清空</button>
                </span>
              </div>
              <div class="ozon-erp-field-settings-list">
                ${group.items.map((field) => `
                  <label class="ozon-erp-field-settings-item">
                    <input type="checkbox" value="${escapeHtml(field.key)}" ${selectedKeys.has(field.key) ? 'checked' : ''} />
                    <span>${escapeHtml(field.label)}</span>
                  </label>
                `).join('')}
              </div>
            </section>
          `).join('')}
        </div>
        <div class="ozon-erp-field-settings-footer">
          <span class="ozon-erp-field-settings-counter" data-role="selected-count"></span>
          <div class="ozon-erp-field-settings-footer-actions">
            <button type="button" data-action="select-all">全选</button>
            <button type="button" data-action="select-none">清空</button>
            <button type="button" data-action="reset">恢复默认</button>
            <button type="button" data-action="save" class="primary">保存</button>
          </div>
        </div>
      </div>
    `;
    const close = () => mask.remove();
    const inputs = () => Array.from(mask.querySelectorAll('input[type="checkbox"]'));
    const updateSelectedCount = () => {
      const total = inputs().length;
      const selected = inputs().filter((input) => input.checked).length;
      const counter = mask.querySelector('[data-role="selected-count"]');
      if (counter) counter.textContent = `已选 ${selected} / ${total} 个字段`;
    };
    mask.querySelector('[data-action="close"]')?.addEventListener('click', close);
    mask.querySelector('[data-action="select-all"]')?.addEventListener('click', () => {
      inputs().forEach((input) => { input.checked = true; });
      updateSelectedCount();
    });
    mask.querySelector('[data-action="select-none"]')?.addEventListener('click', () => {
      inputs().forEach((input) => { input.checked = false; });
      updateSelectedCount();
    });
    mask.querySelectorAll('[data-action="select-group"], [data-action="clear-group"]').forEach((button) => {
      button.addEventListener('click', () => {
        const group = mask.querySelector(`.ozon-erp-field-settings-group[data-field-group="${button.dataset.fieldGroup}"]`);
        if (!group) return;
        const checked = button.dataset.action === 'select-group';
        group.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = checked; });
        updateSelectedCount();
      });
    });
    inputs().forEach((input) => input.addEventListener('change', updateSelectedCount));
    mask.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
      saveVisibleFieldKeys(null).then(close).catch((error) => {
        openPreviewModal('字段设置保存失败', { error: error?.message || String(error) });
      });
    });
    mask.querySelector('[data-action="save"]')?.addEventListener('click', () => {
      const keys = inputs().filter((input) => input.checked).map((input) => input.value);
      const noFieldsErrorTitle = '\u5b57\u6bb5\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25';
      const noFieldsErrorText = '\u81f3\u5c11\u4fdd\u7559\u4e00\u4e2a\u5b57\u6bb5\uff0c\u907f\u514d\u9762\u677f\u4e3a\u7a7a\u3002';
      if (!keys.length) {
        openPreviewModal(noFieldsErrorTitle, { error: noFieldsErrorText });
        return;
      }
      saveVisibleFieldKeys(keys).then(close).catch((error) => {
        openPreviewModal('字段设置保存失败', { error: error?.message || String(error) });
      });
    });
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
    root.appendChild(mask);
    updateSelectedCount();
  }

  function groupCardMetricRows(metrics) {
    const groupOrder = new Map([
      ['基础', 10],
      ['核心概览', 20],
      ['保本测算', 30],
      ['流量转化', 40],
      ['推广依赖', 50],
      ['库存物流', 60]
    ]);
    const groups = [];
    for (const item of metrics) {
      const title = item.group || '其他';
      let group = groups.find((entry) => entry.title === title);
      if (!group) {
        group = { title, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups.sort((a, b) => (groupOrder.get(a.title) || 999) - (groupOrder.get(b.title) || 999));
  }

  function resolveCardMetricValueClass(item) {
    const tone = String(item?.tone || 'base').trim();
    const value = String(item?.value || '').trim();
    const classes = [`collect-metric__value--${tone}`];
    if (/^-/.test(value)) {
      classes.push('collect-metric__value--danger');
    }
    if (/%/.test(value) && ['money', 'traffic', 'promo', 'orange', 'red'].includes(tone)) {
      classes.push('collect-badge', `collect-badge--${tone === 'promo' ? 'purple' : tone === 'red' ? 'red' : tone === 'orange' ? 'orange' : 'blue'}`);
    }
    return classes.join(' ');
  }

  function renderCardMetricGroups(metrics) {
    return groupCardMetricRows(metrics).map((group) => `
      <section class="ozon-erp-card-group collect-section">
        <div class="ozon-erp-card-group-title collect-section__title">${escapeHtml(group.title)}</div>
        <div class="ozon-erp-card-metrics collect-grid">
          ${group.items.map((item) => `
            <span class="ozon-erp-card-metric collect-metric${item.tone ? ` is-${item.tone}` : ''}${item.wide ? ' is-wide' : ''}">
              <b class="collect-metric__label">${escapeHtml(item.label)}</b>
              <em class="collect-metric__value ${escapeHtml(resolveCardMetricValueClass(item))}">${escapeHtml(item.value)}</em>
            </span>
          `).join('')}
        </div>
      </section>
    `).join('');
  }

  function renderDecisionSummary(row, metrics = null) {
    if (Array.isArray(metrics)) {
      const hasVisibleDecisionField = ['product_score', 'risk_level', 'risk_reasons', 'recommendations']
        .some((key) => metricByKey(metrics, key));
      if (!hasVisibleDecisionField) return '';
    }
    const computed = row?.ozonProductIntelligence?.computed || {};
    const score = Number(computed.productScore);
    if (!Number.isFinite(score)) return '';
    const riskLevel = String(computed.riskLevel || '').toLowerCase();
    const riskText = formatRiskLevel(riskLevel);
    const reasons = Array.isArray(computed.riskReasons) ? computed.riskReasons.filter(Boolean) : [];
    const recommendations = Array.isArray(computed.recommendations) ? computed.recommendations.filter(Boolean) : [];
    const scoreClass = score >= 78 ? 'is-good' : score >= 60 ? 'is-mid' : 'is-risk';
    const riskClass = riskLevel === 'high' ? 'is-risk' : riskLevel === 'medium' ? 'is-mid' : 'is-good';
    const text = recommendations[0] || '建议加入采集箱观察';
    const defaultReason = '当前为插件初筛结果，建议在采集箱补齐成本、物流和广告数据后再决策。';
    const tooltip = reasons.length ? reasons.join('\n') : defaultReason;
    const tags = buildDecisionTags(reasons, row).slice(0, 3);
    return `
      <div class="ozon-erp-decision ${scoreClass}">
        <div class="ozon-erp-decision-score">
          <span>选品评分</span>
          <strong>${escapeHtml(Math.round(score))}</strong>
        </div>
        <div class="ozon-erp-decision-main">
          <div class="ozon-erp-decision-line">
            <span class="ozon-erp-decision-risk ${riskClass}">${escapeHtml(riskText || '-')}</span>
            <b>${escapeHtml(text)}</b>
          </div>
          <div class="ozon-erp-decision-tags">
            ${tags.map((tag) => `<span title="${escapeHtml(tag.detail || tooltip)}">${escapeHtml(tag.label)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function buildDecisionTags(reasons, row) {
    const product = resolveCardDisplayProduct(row);
    const tags = [];
    const text = Array.isArray(reasons) ? reasons.join('、') : '';
    const adCostRatio = normalizeCardPercent(pickCardValue(product, ['drr']));
    const promoShare = normalizeCardPercent(pickCardValue(product, ['promoRevenueShare']));
    const returnRate = normalizeCardPercent(pickCardValue(product, ['nullableRedemptionRate']));
    if (/广告|推广|付费/.test(text) || metricPercentValue(product, ['drr']) >= 20) {
      tags.push({ label: '广告依赖高', detail: `广告费占比 ${adCostRatio}，建议复核自然流量占比、广告成本和投产。` });
    }
    const estimate = buildBreakevenEstimate(product);
    tags.push({
      label: '成本待核',
      detail: estimate.suggestedCostCny === null ? '缺少售价或佣金数据，暂时无法完整反推保本成本。' : `当前建议采购成本 ${formatCardCny(estimate.suggestedCostCny)} 以内，${estimate.completeness}，仅供初筛。`
    });
    if (/退货|取消/.test(text) || metricPercentValue(product, ['nullableRedemptionRate']) >= 8) {
      tags.push({ label: '退货需关注', detail: `退货率 ${returnRate}，可能影响真实利润和库存周转。` });
    }
    if (metricPercentValue(product, ['promoRevenueShare']) >= 50) {
      tags.push({ label: '促销驱动', detail: `促销销售占比 ${promoShare}，需要确认非促销状态下是否仍有转化。` });
    }
    if (!tags.length) tags.push({ label: '继续复核', detail: '当前未发现明显硬风险，仍需补齐成本和供应链信息。' });
    return tags;
  }

  function metricByKey(metrics, key) {
    return metrics.find((item) => item.key === key) || null;
  }

  function fieldLabelByKey(key) {
    return getDetailCardFieldDefinitions().find((field) => field.key === key)?.label || key;
  }

  function renderMetricCell(metrics, key, fallbackLabel = '') {
    const item = metricByKey(metrics, key);
    if (!item) return '';
    const label = fallbackLabel || item?.label || fieldLabelByKey(key);
    const value = item?.value || '--';
    const className = item ? resolveCardMetricValueClass(item) : 'collect-metric__value--base';
    const tooltip = item?.tooltip ? ` title="${escapeHtml(item.tooltip)}"` : '';
    return `
      <span class="ozon-erp-card-metric collect-metric${item?.tone ? ` is-${item.tone}` : ''}${item?.tooltip ? ' has-tooltip' : ''}"${tooltip}>
        <b class="collect-metric__label">${escapeHtml(label)}</b>
        <em class="collect-metric__value ${escapeHtml(className)}">${escapeHtml(value)}</em>
      </span>
    `;
  }

  function renderMetricSection(title, metrics, keys, groupName = title) {
    const keySet = new Set(keys);
    const orderedKeys = keys.slice();
    metrics.forEach((item) => {
      if (item?.group === groupName && !keySet.has(item.key)) {
        keySet.add(item.key);
        orderedKeys.push(item.key);
      }
    });
    const cells = orderedKeys.map((key) => renderMetricCell(metrics, key)).filter(Boolean);
    if (!cells.length) return '';
    return `
      <section class="ozon-erp-card-group collect-section">
        <div class="ozon-erp-card-group-title collect-section__title">${escapeHtml(title)}</div>
        <div class="ozon-erp-card-metrics collect-grid">
          ${cells.join('')}
        </div>
      </section>
    `;
  }

  function renderBreakevenFeeList(row) {
    const estimate = buildBreakevenEstimate(resolveCardDisplayProduct(row));
    if (estimate.priceCny === null) return '';
    const rows = [
      ['佣金', formatCardCny(estimate.commissionAmountCny || 0)],
      ['国际运费', formatCardCny(estimate.freightAmountCny || 0)],
      ['国内运费', formatCardCny(estimate.domesticShippingCny || 0)],
      ['包装', formatCardCny(estimate.packagingFeeCny || 0)],
      ['尾程+收单', formatCardCny(estimate.finalMileBankFeeCny || 0)],
      ['提现', formatCardCny(estimate.withdrawalFeeCny || 0)],
      ['广告', formatCardCny(estimate.advertisingCostCny || 0)],
      ['退货率', `${(estimate.returnRate * 100).toFixed(1)}%`]
    ];
    const title = estimate.freightDetail
      ? `国际运费：${estimate.freightSource || '-'}，${estimate.freightDetail}`
      : `国际运费：${estimate.freightSource || '-'}`;
    return `
      <div class="ozon-erp-fee-lines" title="${escapeHtml(title)}">
        ${rows.map(([label, value]) => `
          <span>
            <b>${escapeHtml(label)}</b>
            <em>${escapeHtml(value)}</em>
          </span>
        `).join('')}
      </div>
    `;
  }

  function renderMetricGroupExtras(title, metrics, groupName, excludeKeys = []) {
    const exclude = new Set(excludeKeys);
    const keys = metrics
      .filter((item) => item?.group === groupName && !exclude.has(item.key))
      .map((item) => item.key);
    const cells = keys.map((key) => renderMetricCell(metrics, key)).filter(Boolean);
    if (!cells.length) return '';
    return `
      <section class="ozon-erp-card-group collect-section">
        <div class="ozon-erp-card-group-title collect-section__title">${escapeHtml(title)}</div>
        <div class="ozon-erp-card-metrics collect-grid">
          ${cells.join('')}
        </div>
      </section>
    `;
  }

  function renderFunnelPanel(metrics) {
    const entries = [
      ['total_views', '曝光'],
      ['card_views', '浏览'],
      ['click_rate', '点击'],
      ['cart_rate', '加购'],
      ['view_conversion_rate', '成交'],
      ['monthly_sales', '月销']
    ].map(([key, label]) => {
      const metric = metricByKey(metrics, key);
      return metric ? `<span><b>${escapeHtml(metric.value || '--')}</b><em>${escapeHtml(label)}</em></span>` : '';
    }).filter(Boolean);
    const judgementMetric = metricByKey(metrics, 'funnel_judgement');
    if (!entries.length && !judgementMetric) return '';
    const cells = entries.join('<i>→</i>');
    const judgement = metricByKey(metrics, 'funnel_judgement')?.value || '等待更多流量数据';
    return `
      <section class="ozon-erp-card-group collect-section">
        <div class="ozon-erp-card-group-title collect-section__title">转化漏斗</div>
        ${cells ? `<div class="ozon-erp-funnel">${cells}</div>` : ''}
        ${judgementMetric ? `<div class="ozon-erp-funnel-note" title="点击弱优先看主图、标题和价格；加购弱看详情页、评价和价格承接；成交弱看物流、库存、评价和促销竞争。">漏斗判断：${escapeHtml(judgement)}</div>` : ''}
      </section>
    `;
  }

  function renderDetailScreeningPanel(row, metrics) {
    const overviewCells = ['ozon_card_price', 'monthly_sales', 'monthly_revenue', 'sales_rank', 'risk_level']
      .map((key) => renderMetricCell(metrics, key))
      .filter(Boolean)
      .join('');
    return `
      <div class="ozon-erp-screening">
        ${overviewCells ? `<section class="ozon-erp-overview">${overviewCells}</section>` : ''}
        ${renderDecisionSummary(row, metrics)}
        ${renderMetricGroupExtras('智能判断', metrics, '智能判断', ['product_score', 'risk_level'])}
        ${renderMetricGroupExtras('核心概览', metrics, '核心概览', ['ozon_card_price', 'monthly_sales', 'monthly_revenue', 'sales_rank', 'risk_level'])}
        ${renderMetricSection('基础信息', metrics, ['category', 'brand', 'sales_schema', 'created_at', 'create_age_days'], '基础')}
        ${renderMetricSection('保本测算', metrics, ['web_price', 'breakeven_cost_limit', 'suggested_purchase_cost', 'fee_completeness', 'estimated_international_freight', 'rfbs_commission'], '保本测算')}
        ${renderBreakevenFeeList(row)}
        ${renderFunnelPanel(metrics)}
        ${renderMetricSection('推广依赖', metrics, ['promo_dependency', 'ad_cost_ratio', 'promo_revenue_share', 'paid_promotion_days', 'promo_days'], '推广依赖')}
        ${renderMetricSection('库存物流', metrics, ['stock', 'accessibility_days', 'accessibility', 'return_cancel_rate', 'dimensions', 'weight'], '库存物流')}
      </div>
    `;
  }

  function renderWorkbenchStatusBar(row) {
    const pluginStatus = state.pluginStatus || {};
    const sellerStatus = state.sellerStatus || {};
    const erpPending = !state.pluginStatus;
    const sellerPending = !state.sellerStatus;
    const erpOk = !erpPending && pluginStatus.connected !== false && !pluginStatus.error;
    const sellerOk = sellerStatus.hasSellerTab && sellerStatus.bridgeOk;
    const sellerMissing = !sellerPending && !sellerStatus.hasSellerTab;
    const erpText = erpPending ? 'ERP 检查中' : erpOk ? 'ERP 已连接' : 'ERP 未连接';
    const sellerText = sellerPending ? 'Seller 检查中' : sellerOk ? 'Seller 已连接' : sellerMissing ? 'Seller 未打开' : 'Seller 需刷新';
    const erpTitle = pluginStatus.error || pluginStatus.serverTime || (erpPending ? '正在检查 ERP 本地接口状态' : '');
    const sellerTitle = sellerStatus.error || (sellerMissing ? '需要打开并登录 seller.ozon.ru 后才能补充销量、流量、佣金等数据' : sellerPending ? '正在检查 Seller 页面通信状态' : '');
    return `
      <div class="ozon-erp-workbench-status">
        <span class="ozon-erp-source-badge ${erpPending ? 'is-warn' : erpOk ? 'is-ok' : 'is-error'}" title="${escapeHtml(erpTitle)}">${escapeHtml(erpText)}</span>
        <span class="ozon-erp-source-badge ${sellerPending ? 'is-warn' : sellerOk ? 'is-ok' : 'is-warn'}" title="${escapeHtml(sellerTitle)}">${escapeHtml(sellerText)}</span>
        ${state.watchedSkus.has(String(row?.sku || '').trim()) ? '<span class="ozon-erp-source-badge is-ok">已监控</span>' : ''}
        <button type="button" class="ozon-erp-status-link" data-action="refresh-status">刷新状态</button>
        ${sellerPending || sellerOk ? '' : `<button type="button" class="ozon-erp-status-link" data-action="${sellerMissing ? 'open-seller' : 'refresh-seller'}">${sellerMissing ? '打开 Seller' : '刷新 Seller'}</button>`}
      </div>
    `;
  }

  function ensureCardInsertionRoot(card, row, anchor, index = 0) {
    const sku = String(row?.sku || '').trim();
    if (!card || !sku) return null;
    let root = card.querySelector?.('.ozon-erp-card-insertion') || null;
    if (root) {
      if (root.dataset.sku === sku) return root;
      root.remove();
    }

    root = document.createElement('div');
    root.className = 'ozon-erp-card-insertion';
    root.dataset.sku = sku;
    root.dataset.ozonErpInsertion = sku;
    root.style.cssText = 'margin:0;padding:0;';
    const key = `ozon-erp-${index}-${sku}`;
    card.dataset.ozonErpKey = key;

    const productLink = anchor || card.querySelector?.('a[href*="/product/"]') || null;
    const next = productLink?.nextElementSibling || null;
    if (next?.nextElementSibling && typeof card.insertBefore === 'function') {
      card.insertBefore(root, next.nextElementSibling);
    } else if (next?.nextSibling && typeof card.insertBefore === 'function') {
      card.insertBefore(root, next.nextSibling);
    } else {
      card.appendChild(root);
    }
    root.id = `ozon-erp-insertion-${index}-${sku}`;
    return root;
  }

  function runProductPanelAction(action, panel, row, options = {}) {
    if (action === 'fields') {
      openFieldSettingsModal();
      return;
    }
    if (action === 'close-detail') {
      const sku = String(pageSku() || row?.sku || '').trim();
      if (sku) state.closedDetailSkus.add(sku);
      document.getElementById?.('ozon-erp-detail-insertion')?.remove();
      return;
    }
    if (action === 'collapse-detail') {
      const sku = String(pageSku() || row?.sku || '').trim();
      if (!sku) return;
      if (state.collapsedDetailSkus.has(sku)) {
        state.collapsedDetailSkus.delete(sku);
      } else {
        state.collapsedDetailSkus.add(sku);
      }
      renderProductDataPanel(panel, row, options);
      return;
    }
    if (action === 'open-seller') {
      openSellerDashboard();
      return;
    }
    if (action === 'refresh-seller') {
      refreshSellerDashboard().then(() => refreshWorkbenchStatuses()).catch((error) => {
        openPreviewModal('Seller 刷新失败', { error: error?.message || String(error) });
      });
      return;
    }
    if (action === 'refresh-status') {
      refreshWorkbenchStatuses();
      return;
    }
    if (action === 'watch' || action === 'unwatch') {
      const sku = String(pageSku() || row?.sku || '').trim();
      setLocalWatchStatus(sku, action === 'watch').then(() => {
        renderProductDataPanel(panel, state.detailUiRow?.sku === sku ? state.detailUiRow : row, options);
      }).catch((error) => {
        openPreviewModal(action === 'watch' ? '加入监控失败' : '取消监控失败', {
          error: error?.message || String(error),
          sku,
          scope: 'local-plugin-storage'
        });
      });
      return;
    }
    if (action === 'collect') {
      const sku = String(pageSku() || row.sku || '').trim();
      if (sku) {
        state.collectLoadingSkus.add(sku);
        renderProductDataPanel(panel, row, options);
      }
      addCurrentPreviewToCollectorBox(row, { openCollectorBox: false }).then(() => {
        if (sku) state.manualCollectedSkus.add(sku);
        const cacheData = sku ? state.lookupCacheBySku.get(sku)?.data : null;
        row.erpLookup = buildLookupStatus({
          success: true,
          data: cacheData || {
            found: true,
            needsRefresh: false,
            collectDate: todayDateText(),
            product: row
          }
        });
        mergeCollectedProductIntoRow(row, row.erpLookup?.product);
        renderProductDataPanel(panel, row, options);
      }).catch((error) => {
        openPreviewModal('加入采集箱失败', {
          error: error?.message || String(error),
          sku: sku || pageSku() || row.sku
        });
      }).finally(() => {
        if (sku) {
          state.collectLoadingSkus.delete(sku);
          renderProductDataPanel(panel, row, options);
        }
      });
    }
  }

  function bindProductPanelActions(panel, row, options = {}) {
    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        runProductPanelAction(button.dataset.action, panel, row, options);
      });
    });
  }

  async function addCurrentPreviewToCollectorBox(row = null, options = {}) {
    const sku = String(pageSku() || row?.sku || '').trim();
    const cached = sku ? state.lookupCacheBySku.get(sku)?.data : null;
    const product = {
      ...(cached?.product && typeof cached.product === 'object' ? cached.product : {}),
      ...(state.detailUiRow?.sku === sku && typeof state.detailUiRow === 'object' ? state.detailUiRow : {}),
      ...(row && typeof row === 'object' ? row : {})
    };
    const requestContext = await resolveLocalPluginRequestContext();
    if (sku && product && Object.keys(product).length > 0) {
      const payload = buildFastCollectorBoxPayload(sku, product);
      const saved = await syncCollectedProductToCollectorBox(payload, requestContext);
      const cacheData = refreshCollectorBoxCacheAfterSync(sku, payload, 'fast_collect');
      renderDetailProductPanel(buildDetailDisplayRow(sku, '已采集，正在后台补齐详情', null, cacheData));
      scheduleFullCollectorBoxBackfill(sku, requestContext);
      if (options.openCollectorBox !== false) {
        await openCollectorBox(sku);
      }
      return saved;
    }
    return await runStandaloneDetailEditFeature();
  }

  async function ensureCurrentProductInCollectorBox(row = null) {
    const sku = String(pageSku() || row?.sku || '').trim();
    const cached = sku ? state.lookupCacheBySku.get(sku)?.data : null;
    if (cached?.found && cached.needsRefresh === false) return { sku, cacheData: cached };
    await addCurrentPreviewToCollectorBox(row, { openCollectorBox: false });
    return { sku, cacheData: state.lookupCacheBySku.get(sku)?.data || null };
  }

  async function postCollectorBoxAction(sku, actionPath, body = {}) {
    const requestContext = await resolveLocalPluginRequestContext();
    const response = await localPluginFetch(`${resolveLocalPluginApiBaseUrlFor(requestContext.erpBaseUrl)}/collector-box/${encodeURIComponent(sku)}/${actionPath}`, {
      method: 'POST',
      timeoutMs: 30000,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }, requestContext);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {}
    if (!response.ok || json?.success === false) {
      throw new Error(normalizeLocalPluginErrorMessage(json?.error || json?.message || text || `ERP 动作失败：HTTP ${response.status}`, 'ERP 动作失败'));
    }
    return json?.data || json || {};
  }

  function normalizeCollectorActionCacheData(sku, collectorProduct = {}, previous = null) {
    const product = collectorProduct?.product && typeof collectorProduct.product === 'object'
      ? collectorProduct.product
      : previous?.product || {};
    return {
      ...(previous && typeof previous === 'object' ? previous : {}),
      found: true,
      needsRefresh: false,
      reason: 'fresh',
      sku: String(sku || collectorProduct?.sku || previous?.sku || '').trim(),
      collectDate: collectorProduct?.collect_date || collectorProduct?.collectDate || previous?.collectDate || new Date().toISOString().slice(0, 10),
      collectedAt: collectorProduct?.collected_at || collectorProduct?.collectedAt || previous?.collectedAt || '',
      status: collectorProduct?.status || previous?.status || 'collected',
      selectionProductId: collectorProduct?.selection_product_id || collectorProduct?.selectionProductId || previous?.selectionProductId || null,
      listingTemplateId: collectorProduct?.listing_template_id || collectorProduct?.listingTemplateId || previous?.listingTemplateId || null,
      product
    };
  }

  async function setLocalWatchStatus(sku, watched) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) throw new Error('缺少 SKU，无法设置监控');
    if (watched) {
      state.watchedSkus.add(normalizedSku);
    } else {
      state.watchedSkus.delete(normalizedSku);
    }
    await chrome.storage.local.set({ [WATCHED_SKUS_STORAGE_KEY]: Array.from(state.watchedSkus) });
    if (state.detailUiRow?.sku === normalizedSku) {
      state.detailUiRow = buildDetailDisplayRow(
        normalizedSku,
        state.detailUiRow.erpLookup?.statusText || '已更新监控状态',
        state.detailUiRow.ozonErpDetail,
        state.lookupCacheBySku.get(normalizedSku)?.data || null
      );
    }
  }

  function renderProductDataPanel(panel, row, options = {}) {
    if (!panel || !row?.sku) return;
    const lookup = row.erpLookup || {};
    const statusText = lookup.statusText || '查询中';
    const statusClass = lookup.status || 'pending';
    const collectionRoute = lookup.collectionRoute && typeof lookup.collectionRoute === 'object' ? lookup.collectionRoute : null;
    const routeDuration = Number(collectionRoute?.durationMs || 0) > 0
      ? `${(Number(collectionRoute.durationMs) / 1000).toFixed(1)}秒`
      : '';
    const routeIsPool = collectionRoute?.mode === 'pool';
    const routeText = routeIsPool
      ? [`号池 ${collectionRoute.workerCount || 1}`, collectionRoute.shopName || collectionRoute.companyId, routeDuration].filter(Boolean).join(' · ')
      : collectionRoute?.mode === 'browser_fallback'
        ? [`浏览器回退`, collectionRoute.workerCount ? `号池 ${collectionRoute.workerCount}` : '', collectionRoute.status ? `HTTP ${collectionRoute.status}` : '', routeDuration].filter(Boolean).join(' · ')
        : '';
    const routeTitle = collectionRoute?.warning || (routeIsPool ? `本次由 ${collectionRoute.shopName || collectionRoute.companyId || '号池店铺'} 完成采集` : '');
    const routeHtml = routeText
      ? `<div class="ozon-erp-collection-route ${routeIsPool ? 'is-pool' : 'is-fallback'}" title="${escapeHtml(routeTitle)}">${escapeHtml(routeText)}</div>`
      : '';
    const metrics = buildCardMetricRows(row);
    const isDetail = options.detail === true;
    const bodyHtml = renderDetailScreeningPanel(row, metrics);
    const collectSku = String(pageSku() || row.sku || '').trim();
    const detailCollapsed = isDetail && collectSku && state.collapsedDetailSkus.has(collectSku);
    panel.dataset.collapsed = detailCollapsed ? 'true' : 'false';
    const collectRunning = isDetail && collectSku && state.collectLoadingSkus.has(collectSku);
    const collectDone = isDetail && collectSku && state.manualCollectedSkus.has(collectSku);
    const collectLabel = collectDone ? '已采集' : collectRunning ? '加入中...' : '加入采集箱';
    const isWatched = state.watchedSkus.has(collectSku) || row?.ozonProductIntelligence?.erp?.isWatched;
    const watchLabel = isWatched ? '取消监控' : '加入监控';
    const watchAction = isWatched ? 'unwatch' : 'watch';
    const actionsHtml = isDetail
      ? `<div class="ozon-erp-card-actions">
          <button type="button" class="ozon-erp-btn ozon-erp-btn-secondary" data-action="fields">编辑显示字段</button>
          <button type="button" class="ozon-erp-btn ozon-erp-btn-collect ${collectRunning ? 'is-loading' : ''}${collectDone ? ' is-done' : ''}" data-action="collect" ${collectRunning || collectDone ? 'disabled' : ''}>${escapeHtml(collectLabel)}</button>
          <button type="button" class="ozon-erp-btn ozon-erp-btn-secondary ${isWatched ? 'is-active' : ''}" data-action="${watchAction}">${escapeHtml(watchLabel)}</button>
        </div>`
      : '';
    const statusBarHtml = isDetail ? renderWorkbenchStatusBar(row) : '';
    const detailToolsHtml = isDetail
      ? `<div class="ozon-erp-title-tools">
          <button type="button" class="ozon-erp-icon-btn" data-action="collapse-detail" title="${detailCollapsed ? '展开面板' : '折叠面板'}" aria-label="${detailCollapsed ? '展开面板' : '折叠面板'}">${detailCollapsed ? '+' : '-'}</button>
          <button type="button" class="ozon-erp-icon-btn" data-action="close-detail" title="关闭面板" aria-label="关闭面板">×</button>
        </div>`
      : '';
    const logoUrl = chrome?.runtime?.getURL ? chrome.runtime.getURL('assets/logo-32.png') : '';
    panel.innerHTML = `
      <div class="ozon-erp-card-title collect-panel__header">
        <strong class="collect-panel__title">${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="" class="collect-panel__logo">` : ''}<span>爆单ERP</span></strong>
        <span class="collect-panel__status">${escapeHtml(statusText)}</span>
        ${detailToolsHtml}
      </div>
      ${routeHtml}
      ${detailCollapsed ? '' : `<div class="ozon-erp-card-groups collect-panel__body">${bodyHtml}</div>`}
      ${detailCollapsed ? '' : actionsHtml}
      ${detailCollapsed ? '' : statusBarHtml}
    `;
    panel.dataset.status = statusClass;
    bindProductPanelActions(panel, row, options);
  }

  function renderCardPanel(card, row, anchor = null, index = 0) {
    if (!state.settings.injectCards || !card || !row?.sku) return;
    if (card.closest('#ozon-erp-collector-root')) return;
    const root = ensureCardInsertionRoot(card, row, anchor, index);
    if (!root) return;
    let panel = root.querySelector('.ozon-erp-card-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ozon-erp-card-panel collect-panel';
      panel.dataset.sku = row.sku;
      panel.dataset.ozonErpWidget = row.sku;
      root.appendChild(panel);
    }
    renderProductDataPanel(panel, row);
  }

  function findDetailInsertTarget() {
    const selectors = [
      '[data-widget="webPrice"]',
      '[data-widget^="webPrice-"]',
      '[data-widget="webStickyProducts"] [data-widget*="Price"]',
      '[data-widget="webSale"]',
      '[data-widget^="webSale-"]',
      '[data-widget="webProductHeading"]'
    ];
    for (const selector of selectors) {
      const node = Array.from(document.querySelectorAll?.(selector) || [])
        .find((item) => {
          const rect = item.getBoundingClientRect?.();
          return rect && rect.width > 120 && rect.height > 20;
        });
      if (node) return node;
    }
    return null;
  }

  function ensureDetailInsertionRoot() {
    const sku = String(pageSku() || state.detailSku || '').trim();
    if (!sku) return null;
    let root = document.getElementById?.('ozon-erp-detail-insertion') || null;
    if (root) {
      if (root.dataset.sku === sku) return root;
      root.remove();
    }
    root = document.createElement('div');
    root.className = 'ozon-erp-detail-insertion ozon-erp-card-insertion';
    root.id = 'ozon-erp-detail-insertion';
    root.dataset.sku = sku;
    root.dataset.ozonErpInsertion = sku;
    root.style.cssText = 'margin:10px 0 12px;padding:0;width:100%;';
    const target = findDetailInsertTarget();
    if (!target?.parentElement?.insertBefore) return null;
    target.parentElement.insertBefore(root, target.nextSibling || null);
    return root;
  }

  function buildDetailDisplayRow(sku, statusText, detail = null, cacheData = null) {
    const normalizedSku = String(sku || '').trim();
    const lookupProduct = cacheData?.product && typeof cacheData.product === 'object'
      ? cacheData.product
      : {};
    const detailProduct = detail?.productDetail && typeof detail.productDetail === 'object'
      ? detail.productDetail
      : {};
    const product = {
      ...lookupProduct,
      sku: normalizedSku,
      product_id: normalizedSku,
      productTitle: detailProduct.title || lookupProduct.productTitle || lookupProduct.name || lookupProduct.title || '',
      title: detailProduct.title || lookupProduct.title || lookupProduct.productTitle || '',
      name: lookupProduct.name || detailProduct.title || lookupProduct.productTitle || '',
      price: detailProduct.cardPrice ?? detailProduct.price ?? lookupProduct.cardPrice ?? lookupProduct.price ?? lookupProduct.productPrice ?? '',
      webPrice: detailProduct.webPrice ?? detailProduct.price ?? lookupProduct.webPrice ?? lookupProduct.price ?? '',
      productPrice: detailProduct.cardPrice ?? detailProduct.price ?? lookupProduct.productPrice ?? lookupProduct.price ?? '',
      sell_price: detailProduct.cardPrice ?? detailProduct.price ?? lookupProduct.sell_price ?? lookupProduct.price ?? '',
      cardPrice: detailProduct.cardPrice ?? detailProduct.price ?? lookupProduct.cardPrice ?? lookupProduct.price ?? '',
      originalPrice: detailProduct.originalPrice ?? lookupProduct.originalPrice ?? '',
      priceCurrency: 'CNY',
      currency: 'CNY',
      productImage: lookupProduct.productImage || lookupProduct.mainImage || detailProduct.coverImage || (Array.isArray(detailProduct.images) ? detailProduct.images[0] : ''),
      mainImage: lookupProduct.mainImage || lookupProduct.productImage || detailProduct.coverImage || (Array.isArray(detailProduct.images) ? detailProduct.images[0] : ''),
      images: Array.isArray(lookupProduct.images) && lookupProduct.images.length > 0
        ? lookupProduct.images
        : Array.isArray(detailProduct.images) ? detailProduct.images : []
    };
    const lookup = cacheData
      ? buildLookupStatus({ success: true, data: cacheData })
      : { status: 'pending', statusText: statusText || '查询中', needsRefresh: true };
    if (statusText) lookup.statusText = statusText;
    return {
      ...product,
      sku: normalizedSku,
      erpLookup: lookup,
      ozonErpDetail: detail || null,
      ozonProductIntelligence: typeof dataAggregator.buildProductIntelligence === 'function'
        ? dataAggregator.buildProductIntelligence({
            sku: normalizedSku,
            row: product,
            detail,
            cacheData,
            isWatched: state.watchedSkus.has(normalizedSku),
            pageType: 'ozon_product_detail'
          })
        : null
    };
  }

  function renderDetailProductPanel(row) {
    if (!state.settings.injectCards || !row?.sku) return;
    if (state.closedDetailSkus.has(String(row.sku || '').trim())) return;
    const root = ensureDetailInsertionRoot();
    state.detailUiRow = row;
    if (!root) return;
    let panel = root.querySelector('.ozon-erp-card-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ozon-erp-card-panel ozon-erp-detail-card-panel collect-panel';
      panel.dataset.sku = row.sku;
      panel.dataset.ozonErpWidget = row.sku;
      root.appendChild(panel);
    }
    renderProductDataPanel(panel, row, { detail: true });
  }

  function rerenderDetailProductPanelIfNeeded() {
    if (!pageSku() || !state.detailUiRow) return;
    if (document.getElementById?.('ozon-erp-detail-insertion')?.querySelector?.('.ozon-erp-card-panel')) return;
    renderDetailProductPanel(state.detailUiRow);
  }

  function scheduleDetailPanelRestore() {
    if (state.detailPanelRestoreTimer || !state.detailUiRow || !findDetailInsertTarget()) return;
    state.detailPanelRestoreTimer = setTimeout(() => {
      state.detailPanelRestoreTimer = null;
      rerenderDetailProductPanelIfNeeded();
    }, 300);
  }

  function applyDetailAutoCollectResult(sku, response, previousCacheData = null) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku || pageSku() !== normalizedSku) return;
    const result = Array.isArray(response?.results)
      ? response.results.find((item) => String(item?.sku || '').trim() === normalizedSku)
      : null;
    if (!result?.success) return;
    const collectDate = result.collectDate || (() => {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    })();
    const product = {
      ...(previousCacheData?.product && typeof previousCacheData.product === 'object' ? previousCacheData.product : {}),
      ...(result.product && typeof result.product === 'object' ? result.product : {})
    };
    const cacheData = {
      found: true,
      needsRefresh: false,
      reason: 'fresh',
      sku: normalizedSku,
      collectDate,
      product
    };
    state.lookupCacheBySku.set(normalizedSku, { success: true, data: cacheData });
    renderDetailProductPanel(buildDetailDisplayRow(normalizedSku, '已采集', null, cacheData));
  }

  function summarizeListLookup(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const summary = {
      total: list.length,
      fresh: 0,
      stale: 0,
      missing: 0,
      error: 0,
      pending: 0
    };
    for (const row of list) {
      const status = row?.erpLookup?.status || 'pending';
      if (summary[status] === undefined) summary[status] = 0;
      summary[status] += 1;
    }
    return summary;
  }

  function buildLookupStatus(result) {
    if (!result?.success) {
      return {
        status: 'error',
        statusText: result?.message || result?.error || '查询失败'
      };
    }
    const data = result.data || {};
    if (data.found && data.needsRefresh === false) {
      return {
        status: 'fresh',
        statusText: '已采集',
        collectDate: data.collectDate || '',
        needsRefresh: false,
        collectorStatus: data.status || '',
        selectionProductId: data.selectionProductId || data.selection_product_id || '',
        listingTemplateId: data.listingTemplateId || data.listing_template_id || '',
        product: data.product || null
      };
    }
    if (data.found && data.needsRefresh) {
      return {
        status: 'stale',
        statusText: '需要补采',
        collectDate: data.collectDate || '',
        needsRefresh: true,
        collectorStatus: data.status || '',
        selectionProductId: data.selectionProductId || data.selection_product_id || '',
        listingTemplateId: data.listingTemplateId || data.listing_template_id || '',
        product: data.product || null
      };
    }
    return {
      status: 'missing',
      statusText: '未采集',
      collectDate: '',
      needsRefresh: true,
      product: null
    };
  }

  function getCachedLookupStatus(sku) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku || !state.lookupCacheBySku.has(normalizedSku)) return null;
    const cached = state.lookupCacheBySku.get(normalizedSku);
    return buildLookupStatus({
      success: cached?.success !== false,
      data: cached?.data || null,
      message: cached?.error || ''
    });
  }

  async function lookupListRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return list;
    const pendingSkus = Array.from(
      new Set(
        list
          .map((row) => String(row?.sku || '').trim())
          .filter((sku) => sku && !state.lookupCacheBySku.has(sku))
      )
    );
    if (pendingSkus.length === 0) {
      list.forEach((row) => {
        const sku = String(row?.sku || '').trim();
        row.erpLookup = buildLookupStatus({
          success: state.lookupCacheBySku.get(sku)?.success !== false,
          data: state.lookupCacheBySku.get(sku)?.data || null
        });
        mergeCollectedProductIntoRow(row, row.erpLookup?.product);
      });
      return list;
    }
    const requestContext = await resolveLocalPluginRequestContext();
    const response = await sendRuntimeMessageCompat({
      type: 'OZON_ERP_COLLECTED_PRODUCTS_LOOKUP_BATCH',
      skus: pendingSkus,
      syncContext: requestContext
    });
    const bySku = new Map();
    if (Array.isArray(response?.results)) {
      response.results.forEach((item) => {
        const sku = String(item?.sku || '').trim();
        if (!sku) return;
        bySku.set(sku, item);
        state.lookupCacheBySku.set(sku, { success: item?.success !== false, data: item?.data || null, error: item?.message || item?.error || '' });
      });
    }
    list.forEach((row) => {
      const sku = String(row.sku || '').trim();
      const cached = state.lookupCacheBySku.get(sku);
      row.erpLookup = buildLookupStatus(
        bySku.get(sku) || {
          success: cached?.success !== false,
          data: cached?.data || null,
          message: cached?.error || ''
        }
      );
      mergeCollectedProductIntoRow(row, row.erpLookup?.product);
    });
    return list;
  }

  function hasBaseProductImage(item) {
    return Boolean(item?.productImage || item?.mainImage || item?.image || (Array.isArray(item?.images) && item.images.length > 0));
  }

  function mergeOzonEntrypointBaseProduct(item, detail) {
    if (!item || !detail || typeof detail !== 'object') return item;
    const images = Array.isArray(detail.images) ? detail.images.filter(Boolean) : [];
    const price = detail.cardPrice ?? detail.price ?? '';
    item.price = price;
    item.webPrice = detail.webPrice ?? detail.price ?? '';
    item.productPrice = price;
    item.sell_price = price;
    item.cardPrice = price;
    item.originalPrice = detail.originalPrice ?? item.originalPrice ?? '';
    item.priceCurrency = 'CNY';
    item.currency = 'CNY';
    if (!item.productTitle && !item.name && detail.title) {
      item.productTitle = detail.title;
      item.name = detail.title;
      item.title = detail.title;
    }
    if (!hasBaseProductImage(item) && (detail.coverImage || images.length > 0)) {
      item.productImage = detail.coverImage || images[0] || '';
      item.mainImage = detail.coverImage || images[0] || '';
      item.images = images.length > 0 ? images : [detail.coverImage].filter(Boolean);
    }
    return item;
  }

  async function enrichBaseProductsFromOzonEntrypoint(items) {
    const list = Array.isArray(items) ? items : [];
    if (typeof collector.fetchProductDetail !== 'function') return list;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, list.length || 1) }, async () => {
      while (cursor < list.length) {
        const item = list[cursor++];
        if (!item?.sku || item.ozonEntrypointPriceLoaded) continue;
        try {
          const detail = await collector.fetchProductDetail(item.sku, { includeVariants: false });
          mergeOzonEntrypointBaseProduct(item, detail);
        } catch (error) {
          console.warn('[爆单ERP] Ozon entrypoint 基础数据补采失败', item.sku, error?.message || error);
        }
      }
    }));
    return list;
  }

  async function autoCollectCollectedProductSkus(items, reason = 'auto_scan', options = {}) {
    const sourceItems = Array.isArray(items) ? items : [];
    const baseProducts = sourceItems
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        sku: String(item.sku || '').trim(),
        product_id: String(item.product_id || item.productId || item.sku || '').trim(),
        productTitle: item.productTitle || item.name || item.title || '',
        name: item.name || item.productTitle || item.title || '',
        price: item.cardPrice ?? item.price ?? item.productPrice ?? '',
        webPrice: item.webPrice ?? item.price ?? '',
        productPrice: item.cardPrice ?? item.productPrice ?? item.price ?? '',
        sell_price: item.sell_price ?? item.cardPrice ?? item.price ?? item.productPrice ?? '',
        cardPrice: item.cardPrice ?? item.price ?? item.productPrice ?? '',
        originalPrice: item.originalPrice ?? '',
        priceCurrency: 'CNY',
        currency: 'CNY',
        ozonEntrypointPriceLoaded: item.ozonEntrypointPriceLoaded === true,
        productImage: item.productImage || item.mainImage || item.image || (Array.isArray(item.images) ? item.images[0] : ''),
        mainImage: item.mainImage || item.productImage || item.image || (Array.isArray(item.images) ? item.images[0] : ''),
        images: Array.isArray(item.images) ? item.images : [],
        productLink: item.productLink || item.productUrl || item.url || '',
        productUrl: item.productUrl || item.productLink || item.url || ''
      }))
      .filter((item) => item.sku);
    await enrichBaseProductsFromOzonEntrypoint(baseProducts);
    const baseBySku = new Map(baseProducts.map((item) => [item.sku, item]));
    const now = Date.now();
    const previewTtlMs = Number(options.previewTtlMs || 5 * 60 * 1000);
    const targets = Array.from(
      new Set(
        sourceItems
          .map((item) => String((item && typeof item === 'object' ? item.sku : item) || '').trim())
          .filter(Boolean)
      )
    ).filter((sku) => {
      if (state.autoCollectingSkus.has(sku)) return false;
      if (options.force === true) return true;
      const fetchedAt = Number(state.previewFetchedAtBySku.get(sku) || 0);
      return !fetchedAt || now - fetchedAt > previewTtlMs;
    });
    if (targets.length === 0) return null;
    targets.forEach((sku) => {
      state.autoCollectingSkus.add(sku);
      state.autoCollectAttemptedSkus.add(sku);
      state.previewFetchedAtBySku.set(sku, now);
    });
    const requestContext = await resolveLocalPluginRequestContext();
    try {
      const response = await sendRuntimeMessageCompat({
        type: 'OZON_ERP_AUTO_COLLECT_LIST_SKUS',
        skus: targets,
        baseProducts: targets.map((sku) => baseBySku.get(sku)).filter(Boolean),
        reason,
        concurrency: Number(options.concurrency || 12),
        forceCollect: true,
        syncContext: requestContext
      });
      if (!response?.success) {
        console.warn('[爆单ERP] 自动采集已采集商品数据失败', response?.message || response?.error || response);
      }
      return response;
    } finally {
      targets.forEach((sku) => state.autoCollectingSkus.delete(sku));
    }
  }

  function todayDateText() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function mergeCollectedProductIntoRow(row, product = {}) {
    if (!row || !product || typeof product !== 'object') return;
    if (product.productTitle || product.name || product.title) {
      row.productTitle = product.productTitle || product.name || product.title;
      row.name = product.name || row.productTitle;
      row.title = product.title || row.productTitle;
    }
    if (product.price !== undefined || product.productPrice !== undefined || product.sell_price !== undefined || product.cardPrice !== undefined) {
      const price = product.cardPrice ?? product.price ?? product.productPrice ?? product.sell_price ?? '';
      row.price = price;
      row.productPrice = product.cardPrice ?? product.productPrice ?? price;
      row.sell_price = product.sell_price ?? price;
      row.cardPrice = product.cardPrice ?? price;
    }
    if (product.productImage || product.mainImage || (Array.isArray(product.images) && product.images.length > 0)) {
      row.productImage = product.productImage || product.mainImage || product.images?.[0] || '';
      row.mainImage = product.mainImage || row.productImage;
      row.images = Array.isArray(product.images) ? product.images : [row.productImage].filter(Boolean);
    }
  }

  function applyAutoCollectResultToRows(rows, result) {
    const sku = String(result?.sku || '').trim();
    if (!sku) return null;
    const list = Array.isArray(rows) ? rows : [];
    const row = list.find((item) => String(item?.sku || '').trim() === sku);
    if (!row) return null;
    if (result && result.success === undefined) {
      row.erpLookup = {
        ...(row.erpLookup || {}),
        status: 'pending',
        statusText: '查询中',
        needsRefresh: true
      };
      return row;
    }
    if (result?.success) {
      const product = {
        ...(row.erpLookup?.product && typeof row.erpLookup.product === 'object' ? row.erpLookup.product : {}),
        ...(result.product && typeof result.product === 'object' ? result.product : {})
      };
      const collectDate = result.collectDate || todayDateText();
      row.erpLookup = {
        status: 'fresh',
        statusText: row.erpLookup?.status === 'stale' ? '已补采' : '已采集',
        collectDate,
        needsRefresh: false,
        product,
        collectionRoute: result.collectionRoute || null
      };
      mergeCollectedProductIntoRow(row, product);
      state.lookupCacheBySku.set(sku, {
        success: true,
        data: {
          found: true,
          needsRefresh: false,
          reason: 'fresh',
          sku,
          collectDate,
          product
        }
      });
      return row;
    }
    row.erpLookup = {
      ...(row.erpLookup || {}),
      status: 'error',
      statusText: result?.error || result?.message || '采集失败',
      needsRefresh: true,
      collectionRoute: result?.collectionRoute || row.erpLookup?.collectionRoute || null
    };
    return row;
  }

  function renderListRowPanelsBySku(sku) {
    if (!state.settings.injectCards) return;
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) return;
    const row = state.listRows.find((item) => String(item?.sku || '').trim() === normalizedSku);
    if (!row) return;
    let index = 0;
    for (const anchor of document.querySelectorAll('a[href*="/product/"]')) {
      const anchorSku = collector.extractOzonSku(anchor.href);
      if (String(anchorSku || '').trim() === normalizedSku) {
        renderCardPanel(findProductCard(anchor), row, anchor, index);
      }
      index += 1;
    }
  }

  function handleAutoCollectProgress(progress) {
    const result = progress && typeof progress === 'object' ? progress : null;
    const sku = String(result?.sku || '').trim();
    if (!sku) return;
    const row = applyAutoCollectResultToRows(state.listRows, result);
    if (row) renderListRowPanelsBySku(sku);
    if (pageSku() === sku && result?.success) {
      applyDetailAutoCollectResult(sku, { results: [result] }, state.lookupCacheBySku.get(sku)?.data || null);
    }
  }

  function getListAutoCollectCandidates(rows, options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const includeMissing = options.includeMissing === true;
    return list.filter((row) => {
        if (!row?.sku) return false;
        const status = String(row.erpLookup?.status || '').trim();
        return status === 'stale' || (includeMissing && status === 'missing');
      });
  }

  async function autoCollectRowsNeedingRefresh(rows, reason = 'auto_scan', options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const includeMissing = options.includeMissing === true;
    const limit = Math.max(0, Number(options.limit || LIST_AUTO_REFRESH_LIMIT));
    const candidates = getListAutoCollectCandidates(list, { includeMissing });
    const targets = candidates.slice(0, limit || undefined);
    if (targets.length === 0) {
      return {
        success: true,
        results: [],
        autoCollectMeta: {
          eligibleCount: candidates.length,
          requestedCount: 0,
          remainingCount: candidates.length,
          includeMissing,
          limit
        }
      };
    }
    targets.forEach((row) => {
      row.erpLookup = {
        ...(row.erpLookup || {}),
        status: 'pending',
        statusText: '查询中',
        needsRefresh: true
      };
    });
    const bySku = new Map(list.map((row) => [String(row?.sku || ''), row]).filter(([sku]) => sku));
    if (state.settings.injectCards) renderListCardPanels(bySku, LIST_SCAN_LIMIT);
    const response = await autoCollectCollectedProductSkus(targets, reason, {
      previewTtlMs: 5 * 60 * 1000,
      concurrency: Math.min(4, targets.length || 1)
    });
    if (Array.isArray(response?.results) && response.results.length > 0) {
      for (const result of response.results) {
        applyAutoCollectResultToRows(list, result);
      }
    }
    const remainingCount = getListAutoCollectCandidates(list, { includeMissing }).length;
    return {
      ...(response || {}),
      autoCollectMeta: {
        eligibleCount: candidates.length,
        requestedCount: targets.length,
        remainingCount,
        includeMissing,
        limit
      }
    };
  }


  openListStatusModal = function openListStatusModalFixed(autoCollectMeta = state.lastListAutoCollectMeta) {
    const summary = summarizeListLookup(state.listRows);
    const remainingCount = Number(autoCollectMeta?.remainingCount || 0);
    const nextBatchCount = Math.min(LIST_MANUAL_CONTINUE_COLLECT_LIMIT, remainingCount);
    openPreviewModal('\u5217\u8868\u9875 ERP \u72b6\u6001', {
      feature: 'erp-cache-auto-scan',
      summary,
      autoCollect: autoCollectMeta || null,
      listRows: state.listRows,
      collectedAt: new Date().toISOString()
    }, {
      extraActions: remainingCount > 0
        ? [{
            action: 'continue-list-autocollect',
            label: `\u8fd8\u6709 ${remainingCount} \u4e2a\uff0c\u70b9\u51fb\u7ee7\u7eed\u8865\u91c7 ${nextBatchCount} \u4e2a`,
            className: 'primary'
          }]
        : [],
      onAction: async (action, context) => {
        if (action !== 'continue-list-autocollect') return;
        context.button.disabled = true;
        context.button.textContent = '\u8865\u91c7\u4e2d...';
        try {
          const result = await autoCollectRowsNeedingRefresh(state.listRows, 'list_preview_continue', {
            includeMissing: true,
            limit: LIST_MANUAL_CONTINUE_COLLECT_LIMIT
          });
          state.lastListAutoCollectMeta = result?.autoCollectMeta || null;
          const bySku = new Map(state.listRows.map((row) => [String(row?.sku || ''), row]).filter(([sku]) => sku));
          renderListCardPanels(bySku, LIST_SCAN_LIMIT_MANUAL);
          openListStatusModal(state.lastListAutoCollectMeta);
        } catch (error) {
          openPreviewModal('\u5217\u8868\u9875\u7ee7\u7eed\u8865\u91c7\u5931\u8d25', {
            error: error?.message || String(error),
            autoCollect: state.lastListAutoCollectMeta,
            listRows: state.listRows
          });
        }
      }
    });
  };

  async function scanListCards(showPanel = false) {
    if (!isOzonFront() || pageSku()) return [];
    if (state.isScanning) {
      state.pendingListMutation = true;
      return state.listRows;
    }
    const now = Date.now();
    const hadPendingMutation = state.pendingListMutation;
    if (!showPanel && !hadPendingMutation && state.listRows.length > 0 && now - state.lastScanAt < 2000) return state.listRows;

    try {
      state.isScanning = true;
      state.pendingListMutation = false;
      state.lastScanAt = now;
      const scanLimit = showPanel ? LIST_SCAN_LIMIT_MANUAL : LIST_SCAN_LIMIT;
      const previousBySku = new Map(state.listRows.map((row) => [String(row?.sku || '').trim(), row]).filter(([sku]) => sku));
      const rows = collector.collectListSkuSpecs(scanLimit);
      const bySku = new Map(rows.map((row) => [String(row.sku), row]));
      state.listRows = Array.from(bySku.values());
      enrichListRowsFromCards(state.listRows, bySku, scanLimit);
      state.listRows.forEach((row) => {
        const sku = String(row?.sku || '').trim();
        const cachedLookup = getCachedLookupStatus(sku);
        row.erpLookup = cachedLookup || previousBySku.get(sku)?.erpLookup || { status: 'pending', statusText: '查询中' };
        if (row.erpLookup?.status === 'missing') {
          row.erpLookup = {
            ...row.erpLookup,
            status: 'pending',
            statusText: '查询中'
          };
        }
        mergeCollectedProductIntoRow(row, row.erpLookup?.product);
      });

      if (state.settings.injectCards || showPanel) renderListCardPanels(bySku, scanLimit);
      await lookupListRows(state.listRows);
      if (state.settings.injectCards || showPanel) renderListCardPanels(bySku, scanLimit);
      const autoCollectResult = await autoCollectRowsNeedingRefresh(state.listRows, 'list_preview', {
        includeMissing: true,
        limit: showPanel ? 24 : LIST_AUTO_REFRESH_LIMIT
      });
      state.lastListAutoCollectMeta = autoCollectResult?.autoCollectMeta || null;
      if (state.settings.injectCards || showPanel) renderListCardPanels(bySku, scanLimit);
    } finally {
      state.isScanning = false;
      if (state.pendingListMutation && !pageSku() && isListLikePage()) {
        scheduleListScan(false);
      }
    }
    if (showPanel) {
      openListStatusModal(state.lastListAutoCollectMeta);
    }
    return state.listRows;
  }

  function renderListCardPanels(bySku, scanLimit) {
    let count = 0;
    for (const anchor of document.querySelectorAll('a[href*="/product/"]')) {
      if (count >= scanLimit) break;
      const index = count;
      count += 1;
      const sku = collector.extractOzonSku(anchor.href);
      const row = sku ? bySku.get(String(sku)) : null;
      if (row) renderCardPanel(findProductCard(anchor), row, anchor, index);
    }
  }

  function scheduleListScan(showPanel = false) {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanListCards(showPanel).catch((error) => {
        console.warn('[爆单ERP] 自动扫描失败', error);
      });
    }, showPanel ? 80 : 800);
  }

  function clearRouteTimers() {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
      state.scanTimer = null;
    }
    if (state.detailPanelRestoreTimer) {
      clearTimeout(state.detailPanelRestoreTimer);
      state.detailPanelRestoreTimer = null;
    }
  }

  function cleanupForRouteChange(nextSku) {
    clearRouteTimers();
    state.pendingListMutation = false;
    state.isScanning = false;
    state.listRows = [];
    state.autoCollectingSkus.clear();
    const normalizedNextSku = String(nextSku || '').trim();
    if (!normalizedNextSku || normalizedNextSku !== state.detailSku) {
      if (state.detailSku) {
        state.closedDetailSkus.delete(state.detailSku);
        state.collapsedDetailSkus.delete(state.detailSku);
      }
      state.detailTask = null;
      state.detailUiRow = null;
      state.detailStatus = 'idle';
      document.getElementById?.('ozon-erp-detail-insertion')?.remove();
    }
  }

  function stopFrontController() {
    clearRouteTimers();
    if (state.routeTimer) {
      clearInterval(state.routeTimer);
      state.routeTimer = null;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function nodeContainsProductCard(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.nodeType && node.nodeType !== 1) return false;
    const className = String(node.className || '');
    if (className.split(/\s+/g).includes('tile-root')) return true;
    if (typeof node.matches === 'function' && (node.matches('.tile-root') || node.matches('a[href*="/product/"]'))) return true;
    if (String(node.href || '').includes('/product/')) return true;
    return Boolean(node.querySelector?.('.tile-root, a[href*="/product/"]'));
  }

  function hasProductCardMutation(mutations) {
    return Array.from(mutations || []).some((mutation) => {
      if (!mutation?.addedNodes?.length) return false;
      return Array.from(mutation.addedNodes).some((node) => nodeContainsProductCard(node));
    });
  }

  async function runStandaloneDetailEditFeature() {
    const sku = pageSku();
    if (!sku) return null;
    state.detailSku = sku;
    state.detailStatus = 'running';
    const result = await collector.runDetailAutoFeature({ concurrency: 4 });
    window.__ozonErpLastDetailCollect = result;
    const saved = await ensureCollectedSaved(result);
    result.savedCollectionId = saved.collectionId;
    result.collectionId = saved.collectionId;
    scheduleSellerFallbackBackfill(result, { persist: true });
    state.detailStatus = 'success';
    renderDetailPanel('已保存到 ERP 采集箱', result);
    return result;
  }

  async function runDetailFeature(force = false, showModal = false, options = {}) {
    const sku = pageSku();
    if (!sku) return null;
    const skipCacheLookup = options.skipCacheLookup === true;
    const existing = getSavedDetailForCurrentSku();
    if (force) clearSavedDetailForCurrentSku();
    if (!force && existing && canReuseCollectedDetail(existing)) {
      state.detailSku = sku;
      state.detailStatus = 'success';
      renderDetailPanel('已存在采集数据', existing);
      if (showModal) {
        openPreviewModal('已存在采集数据', {
          ...existing,
          sku,
          collectionId: existing.savedCollectionId || existing.collectionId,
          message: '本次不重新采集，直接复用已采集数据。'
        }, { publish: true });
      }
      return existing;
    }
    if (state.detailStatus === 'running' && state.detailTask) return state.detailTask;
    if (!force && state.detailSku === sku && state.detailTask) return state.detailTask;

    state.detailSku = sku;
    state.detailStatus = 'running';
    renderDetailPanel(skipCacheLookup ? '正在重新采集详情数据' : '正在查询ERP已采集数据', null);
    state.detailTask = (async () => {
      if (!skipCacheLookup) {
        const cacheData = await lookupCollectedProductForCurrentSku(sku);
        if (cacheData?.found && cacheData.needsRefresh === false) {
          const cachedDetail = buildCachedCollectedDetail(cacheData, sku);
          window.__ozonErpLastDetailCollect = cachedDetail;
          state.detailStatus = 'success';
          renderDetailPanel('已使用ERP已采集数据，本次无需补采', cachedDetail);
          if (showModal) {
            openPreviewModal('已使用ERP已采集数据', {
              ...cachedDetail,
              message: '采集日期与今天一致，本次直接复用已采集商品数据。'
            }, { publish: true });
          }
          return cachedDetail;
        }

        if (cacheData?.found && cacheData.needsRefresh) {
          renderDetailPanel('ERP已有历史数据，采集日期不同，正在补采', null);
        } else {
          renderDetailPanel('ERP未找到可用数据，详情采集中', null);
        }
      } else {
        renderDetailPanel('正在重新抓取详情数据', null);
      }

      return await collector.runDetailAutoFeature({ concurrency: 4 })
        .then(async (result) => {
          const variantCount = result?.followEditPayload?.rows?.length || result?.variants?.length || 1;
          window.__ozonErpLastDetailCollect = result;
          return ensureCollectedSaved(result).then(({ collectionId }) => {
            state.detailStatus = 'success';
            result.savedCollectionId = collectionId;
            result.collectionId = collectionId;
            scheduleSellerFallbackBackfill(result, { persist: true });
            renderDetailPanel(`采集完成：${variantCount} 个变体，已加入采集箱`, result);
            return result;
          });
        })
        .catch((error) => {
          state.detailStatus = 'error';
          state.detailTask = null;
          renderDetailPanel(`采集失败：${error?.message || error}`, getSavedDetailForCurrentSku() || null);
          if (showModal) {
            openPreviewModal('采集或保存失败', {
              error: error?.message || String(error),
              stages: window.__ozonErpLastDetailCollect?.stages || []
            });
          }
          throw error;
        });
    })();
    return await state.detailTask;
  }

  async function handleRoute() {
    await loadSettings();
    const key = `${location.hostname}${location.pathname}${location.search}`;
    if (key === state.routeKey) {
      if (pageSku() && state.detailUiRow && !document.getElementById?.('ozon-erp-detail-insertion')) {
        scheduleDetailPanelRestore();
      }
      return;
    }
    const nextSku = pageSku();
    cleanupForRouteChange(nextSku);
    state.routeKey = key;
    state.routeVersion += 1;
    if (nextSku) {
      const currentDetail = getSavedDetailForCurrentSku();
      state.detailStatus = currentDetail && canReuseCollectedDetail(currentDetail) ? 'success' : state.detailStatus === 'running' ? 'running' : 'idle';
      await refreshDetailCacheStatus(nextSku, currentDetail && canReuseCollectedDetail(currentDetail) ? currentDetail : null);
      refreshWorkbenchStatuses({ rerender: true }).catch(() => {});
    } else if (isListLikePage()) {
      scheduleListScan(false);
    }
  }

  function startFrontController() {
    stopFrontController();
    handleRoute();
    state.observer = new MutationObserver((mutations) => {
      if (pageSku()) {
        if (state.detailUiRow && !document.getElementById?.('ozon-erp-detail-insertion') && Array.from(mutations || []).some((mutation) => mutation?.removedNodes?.length || mutation?.addedNodes?.length)) {
          scheduleDetailPanelRestore();
        }
        return;
      }
      if (isListLikePage() && hasProductCardMutation(mutations)) {
        state.pendingListMutation = true;
        scheduleListScan(false);
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    state.routeTimer = setInterval(handleRoute, 1000);
    window.addEventListener?.('pagehide', stopFrontController, { once: true });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'OZON_ERP_AUTO_COLLECT_LIST_PROGRESS') {
      handleAutoCollectProgress(message.progress);
      sendResponse?.({ success: true });
      return false;
    }
    if (message?.type === 'OZON_ERP_COLLECT_LIST_PAYLOAD_FROM_DETAIL') {
      collectListPayloadFromDetail()
        .then((payload) => sendResponse({ success: true, payload, url: location.href }))
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error), url: location.href }));
      return true;
    }
    if (message?.type === 'OZON_ERP_MANUAL_COLLECT_DETAIL') {
      runDetailFeature(true, false)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === 'OZON_ERP_SCAN_LIST') {
      Promise.resolve(scanListCards(true))
        .then((rows) => sendResponse({ success: true, data: rows }))
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error), url: location.href }));
      return true;
    }
    if (message?.type === 'OZON_ERP_EXPORT_STATE') {
      const detail = window.__ozonErpLastDetailCollect || null;
      const payload = {
        url: location.href,
        sku: pageSku(),
        listRows: state.listRows,
        detail,
        productIntelligence: state.detailUiRow?.ozonProductIntelligence || null,
        exportedAt: new Date().toISOString()
      };
      openPreviewModal('当前页面状态预览', payload);
      sendResponse({
        success: true,
        data: payload
      });
      return true;
    }
    return false;
  });

  if (isOzonFront()) startFrontController();
})();

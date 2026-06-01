(function initPivotErpRelayPage() {
  'use strict';

  if (window.__PIVOT_ERP_RELAY_PAGE_INSTALLED__) return;
  window.__PIVOT_ERP_RELAY_PAGE_INSTALLED__ = true;

  const EXECUTE_TYPE = 'PIVOT_ERP_ANALYTICS_EXECUTE_REQUEST';
  const EXECUTE_RESULT_TYPE = 'PIVOT_ERP_ANALYTICS_EXECUTE_RESULT';
  const TARGET_PATHS = [
    '/api/site/seller-analytics/charts/v3/table/totals',
    '/api/site/seller-analytics/charts/v3/table/by_sku',
    '/api/site/seller-analytics/charts/v3/abc'
  ];
  const SOURCE_LABELS = {
    overview: '数据概览',
    all_metrics: '所有指标',
    funnel: '销售漏斗',
    hot: '热销榜单',
    search: '搜索',
    abc: 'ABC',
    need_promotion: '需要推广',
    card_quality: '卡片质量',
    seasonality: '季节性'
  };

  function isSellerAnalyticsPage() {
    return /^https:\/\/seller\.ozon\.ru\/app\/analytics(?:[/?#]|$)/i.test(window.location.href);
  }

  function normalizeTargetUrl(url) {
    try {
      return new URL(String(url || ''), window.location.href);
    } catch (error) {
      return null;
    }
  }

  function shouldCapture(url) {
    const parsed = normalizeTargetUrl(url);
    return parsed && parsed.origin === 'https://seller.ozon.ru' && TARGET_PATHS.some((path) => parsed.pathname.startsWith(path));
  }

  function toAbsoluteTargetUrl(url) {
    const parsed = normalizeTargetUrl(url);
    return parsed ? parsed.toString() : String(url || '');
  }

  function getCompanyId() {
    try {
      const cached = window.localStorage?.getItem('ozon_company_id');
      if (cached) return cached;
    } catch (error) {}

    const match = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    const value = match ? decodeURIComponent(match[1]) : '';
    if (value) {
      try {
        window.localStorage?.setItem('ozon_company_id', value);
      } catch (error) {}
    }
    return value;
  }

  function metricSetFromRequestBody(body) {
    const metrics = Array.isArray(body?.metrics) ? body.metrics : [];
    return new Set(metrics.map((item) => String(item || '').replace(/_sort$/i, '').replace(/_dynamics$/i, '').toLowerCase()).filter(Boolean));
  }

  function onlyMetrics(set, names) {
    const allowed = new Set(names);
    for (const item of set) {
      if (!allowed.has(item)) return false;
    }
    return true;
  }

  function inferSourceKeyFromRequestBody(body) {
    const set = metricSetFromRequestBody(body);
    if (set.size === 0) return null;
    const has = (name) => set.has(name);
    if (has('delivered_units') || has('conv_hits_to_cart_to_order') || has('total_hits_to_cart') || has('conv_total_views_to_cart')) return 'all_metrics';
    if (has('price_index') || has('drr') || has('stockout_days') || has('recommended_supply') || has('discount_share_of_total_gmv')) return 'abc';
    if (has('cancelled_units_by_order_date') || has('returned_units_by_order_date')) return 'overview';
    if (has('search_views') && has('pdp_views') && has('hits_pdp_to_cart') && has('revenue')) return 'funnel';
    if (has('search_position') && has('total_views') && has('pdp_views') && has('conv_pdp_views_to_cart') && has('ordered_units') && !has('revenue')) return 'need_promotion';
    if (has('pdp_views') && has('conv_pdp_views_to_cart') && has('ordered_units') && has('revenue') && !has('search_views')) return 'card_quality';
    if (has('search_position') && has('search_views') && has('ordered_units') && onlyMetrics(set, ['search_position', 'search_views', 'ordered_units'])) return 'search';
    if (has('revenue') && has('ordered_units') && onlyMetrics(set, ['revenue', 'ordered_units'])) return 'hot';
    return null;
  }

  function inferSourceContext(requestBody, request) {
    const key = request?.source_key || inferSourceKeyFromRequestBody(requestBody);
    if (!key) return null;
    return {
      label: request?.source_label || SOURCE_LABELS[key],
      key,
      group: 'erp_collect_plan',
      metrics: Array.isArray(requestBody?.metrics) ? requestBody.metrics : [],
      collection_run_id: request?.run_id || null,
      collection_request_id: request?.request_id || null,
      endpoint_type: request?.endpoint_type || null,
      page_index: request?.page_index || 0,
      inferredFrom: 'erp_collect_plan',
      capturedAt: new Date().toISOString(),
      pageUrl: window.location.href
    };
  }

  function headersToObject(headers) {
    const result = {};
    try {
      new Headers(headers || {}).forEach((value, key) => {
        result[key] = value;
      });
    } catch (error) {}
    return result;
  }

  function buildRequestHeaders(inputHeaders) {
    const canonicalNames = {
      accept: 'Accept',
      'accept-language': 'Accept-Language',
      'content-type': 'Content-Type',
      'x-o3-app-name': 'X-O3-App-Name',
      'x-o3-company-id': 'X-O3-Company-Id',
      'x-o3-language': 'X-O3-Language',
      'x-o3-page-type': 'X-O3-Page-Type'
    };
    const blocked = new Set([
      'cookie',
      'cookie2',
      'host',
      'origin',
      'referer',
      'content-length',
      'connection',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user'
    ]);
    const headers = {};
    try {
      new Headers(inputHeaders || {}).forEach((value, key) => {
        const normalizedKey = String(key || '').toLowerCase();
        if (!normalizedKey || blocked.has(normalizedKey)) return;
        if (canonicalNames[normalizedKey]) {
          headers[canonicalNames[normalizedKey]] = value;
          return;
        }
        headers[key] = value;
      });
    } catch (error) {}
    if (!headers['X-O3-Company-Id']) {
      const companyId = getCompanyId();
      if (companyId) headers['X-O3-Company-Id'] = companyId;
    }
    return headers;
  }

  async function executeRequest(request) {
    if (!isSellerAnalyticsPage()) throw new Error('请先打开 seller.ozon.ru 分析页面');
    const requestUrl = toAbsoluteTargetUrl(request?.request_url);
    if (!shouldCapture(requestUrl)) throw new Error('不允许采集该接口');
    const method = String(request?.request_method || 'POST').toUpperCase();
    const requestBody = request?.request_body || null;
    const headers = buildRequestHeaders(request?.request_headers);
    const response = await fetch(requestUrl, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(requestBody || {})
    });
    const text = await response.text();
    let responseBody = text;
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch (error) {}
    return {
      success: response.ok,
      page_url: window.location.href,
      request_url: requestUrl,
      request_method: method,
      request_headers: headers,
      request_body: requestBody,
      source_button_label: request?.source_label || inferSourceContext(requestBody, request)?.label || null,
      source_button_key: request?.source_key || inferSourceContext(requestBody, request)?.key || null,
      source_context: inferSourceContext(requestBody, request),
      response_status: response.status,
      response_headers: headersToObject(response.headers),
      response_body: responseBody,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== EXECUTE_TYPE) return;
    const requestId = event.data.requestId;
    executeRequest(event.data.request)
      .then((payload) => {
        window.postMessage({ type: EXECUTE_RESULT_TYPE, requestId, payload }, '*');
      })
      .catch((error) => {
        window.postMessage({
          type: EXECUTE_RESULT_TYPE,
          requestId,
          payload: {
            success: false,
            page_url: window.location.href,
            error: error?.message || String(error)
          }
        }, '*');
      });
  });
})();

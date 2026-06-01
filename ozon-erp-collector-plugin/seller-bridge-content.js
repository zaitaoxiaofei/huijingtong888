(function initOzonErpSellerBridge() {
  'use strict';

  if (window.__ozonErpSellerBridgeLoaded) return;
  window.__ozonErpSellerBridgeLoaded = true;

  function getCompanyId() {
    const cached = localStorage.getItem('ozon_company_id');
    if (cached) return cached;
    const match = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    const value = match ? decodeURIComponent(match[1]) : '';
    if (value) localStorage.setItem('ozon_company_id', value);
    return value;
  }

  function clearCompanyId() {
    localStorage.removeItem('ozon_company_id');
  }

  function buildSellerRequest({ sku, apiType = 'sales', variantId }) {
    const companyId = getCompanyId();
    if (!companyId) {
      throw new Error('获取 Ozon 公司 ID 失败，请确认 seller.ozon.ru 已登录');
    }

    if (apiType === 'variant') {
      return {
        url: 'https://seller.ozon.ru/api/v1/search-variant-model',
        language: 'RU',
        body: { name: String(sku || ''), limit: '50' }
      };
    }

    if (apiType === 'variant_v2') {
      return {
        url: 'https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id',
        language: 'RU',
        body: {
          company_id: companyId,
          variant_id: variantId,
          source: 'SOURCE_UI_COPY_MERGED'
        }
      };
    }

    if (apiType === 'search-sku-base') {
      return {
        url: 'https://seller.ozon.ru/api/v1/search',
        language: 'RU',
        body: {
          company_id: companyId,
          need_total: true,
          filter: {
            children_nodes: {
              children_nodes: [{ input_leaf: { sku: { values: [String(sku || '')] } } }],
              operator: 'AND'
            }
          },
          pagination: { limit: '50' },
          is_copy_allowed: false
        }
      };
    }

    return {
      url: 'https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3',
      language: 'zh-Hans',
      body: {
        limit: '50',
        offset: '0',
        filter: {
          stock: 'any_stock',
          period: 'monthly',
          categories: [],
          sku: String(sku || '')
        },
        sort: { key: 'sum_gmv_desc' }
      }
    };
  }

  async function runSellerRequest(message) {
    const companyId = getCompanyId();
    const request = buildSellerRequest(message);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-o3-company-id': companyId,
          'x-o3-language': request.language
        },
        body: JSON.stringify(request.body),
        credentials: 'include',
        signal: controller.signal
      });
      if (!response.ok) {
        clearCompanyId();
        throw new Error(`seller.ozon.ru 请求失败：HTTP ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('seller.ozon.ru 请求超时，请确认 seller 登录状态或稍后重试');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    return await response.json();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING_TEST') {
      sendResponse({ pong: true });
      return true;
    }

    if (message?.type === 'OZON_SKU_API_REQUEST') {
      runSellerRequest(message)
        .then((data) => {
          sendResponse({
            success: true,
            data,
            sku: message.sku,
            requestId: message.requestId
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error?.message || String(error),
            sku: message.sku,
            requestId: message.requestId
          });
        });
      return true;
    }

    return false;
  });
})();

(function initOzonErpSellerBridge() {
  'use strict';

  if (window.__ozonErpSellerBridgeLoaded) return;
  window.__ozonErpSellerBridgeLoaded = true;

  const IMAGE_UPLOAD_URL = 'https://api.seller.ozon.ru/api/images/synchronous/validate_raw';
  const VIDEO_UPLOAD_URL = 'https://api.seller.ozon.ru/api/media-storage/upload-file';
  const FBP_PAGE_RE = /\/app\/fbp-supply\/create-order\/\d+/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function setNativeInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  async function waitFor(resolveValue, timeoutMs = 12000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = resolveValue();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  function findFbpSearchInput() {
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea')].filter((input) => {
      if (!visible(input) || input.disabled || input.readOnly) return false;
      const type = String(input.getAttribute('type') || 'text').toLowerCase();
      return !['number', 'checkbox', 'radio', 'button', 'submit'].includes(type);
    });
    const hinted = inputs.find((input) => {
      if (!visible(input)) return false;
      let context = input.parentElement;
      for (let depth = 0; context && depth < 4; depth += 1, context = context.parentElement) {
        const hint = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''} ${context.textContent || ''}`.toLowerCase();
        if (hint.includes('sku') || hint.includes('货号') || hint.includes('名称') || hint.includes('артикул')) return true;
      }
      const hint = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
      return hint.includes('sku') || hint.includes('货号') || hint.includes('名称') || hint.includes('артикул');
    });
    if (hinted) return hinted;
    return inputs
      .filter((input) => input.getBoundingClientRect().width >= 240)
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0] || null;
  }

  function ancestorWithSku(element, sku, maxDepth = 7) {
    let node = element;
    for (let depth = 0; node && depth < maxDepth; depth += 1, node = node.parentElement) {
      if (String(node.textContent || '').includes(sku)) return node;
    }
    return null;
  }

  function findAddButtonForSku(sku) {
    const skuElements = [...document.querySelectorAll('div,span,p,a')]
      .filter((element) => visible(element) && String(element.textContent || '').includes(sku))
      .sort((left, right) => String(left.textContent || '').length - String(right.textContent || '').length);
    for (const skuElement of skuElements.slice(0, 8)) {
      let container = skuElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const buttons = [...container.querySelectorAll('button')].filter(visible);
        const explicit = buttons.find((button) => {
          const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.title || ''}`.trim().toLowerCase();
          return label === '+' || /添加|добав|add/.test(label);
        });
        if (explicit) return explicit;
        if (buttons.length === 1 && String(container.textContent || '').length < 800) return buttons[0];
      }
    }
    return null;
  }

  function findQuantityInputForSku(sku) {
    const searchInput = findFbpSearchInput();
    const inputs = [...document.querySelectorAll('input')].filter((input) => visible(input) && input !== searchInput && !input.disabled);
    for (const input of inputs) {
      const row = input.closest('tr') || ancestorWithSku(input, sku);
      if (row && String(row.textContent || '').includes(sku)) return input;
    }
    return null;
  }

  function renderFbpProgress(summary, results = []) {
    let panel = document.getElementById('ozon-erp-fbp-fill-progress');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'ozon-erp-fbp-fill-progress';
      Object.assign(panel.style, {
        position: 'fixed', right: '20px', top: '88px', zIndex: '2147483647', width: '340px',
        maxHeight: '60vh', overflow: 'auto', padding: '14px', borderRadius: '10px',
        background: '#fff', color: '#172033', boxShadow: '0 8px 30px rgba(15,23,42,.22)',
        font: '13px/1.5 Arial, sans-serif', whiteSpace: 'pre-wrap'
      });
      document.documentElement.appendChild(panel);
    }
    const detail = results.slice(-12).map((item) => `${item.success ? '✓' : '×'} ${item.sku} ${item.message || ''}`);
    panel.textContent = [summary, ...detail].filter(Boolean).join('\n');
  }

  async function fillSingleFbpItem(item) {
    const sku = String(item?.sku || '').trim();
    const quantity = Math.max(1, Math.round(Number(item?.quantity || 0)));
    if (!sku) return { success: false, sku, message: 'SKU为空' };

    let quantityInput = findQuantityInputForSku(sku);
    if (!quantityInput) {
      const searchInput = await waitFor(findFbpSearchInput, 10000);
      if (!searchInput) return { success: false, sku, message: '未找到SKU搜索框' };
      searchInput.focus();
      setNativeInputValue(searchInput, sku);
      const addButton = await waitFor(() => findAddButtonForSku(sku), 15000);
      if (!addButton) return { success: false, sku, message: '未找到精确匹配商品或加号按钮' };
      addButton.click();
      quantityInput = await waitFor(() => findQuantityInputForSku(sku), 15000);
      if (!quantityInput) return { success: false, sku, message: '商品已点击添加，但未找到数量输入框' };
      await sleep(700);
    }

    quantityInput.focus();
    setNativeInputValue(quantityInput, quantity);
    await sleep(350);
    const actualInput = findQuantityInputForSku(sku) || quantityInput;
    const actual = Math.round(Number(actualInput.value || 0));
    if (actual !== quantity) return { success: false, sku, quantity, actual, message: `数量回填失败，页面显示${actual}` };
    return { success: true, sku, quantity, message: `已填写${quantity}` };
  }

  async function runFbpFill(message) {
    if (!FBP_PAGE_RE.test(location.pathname)) {
      return { success: false, error: 'FBP_PAGE_REQUIRED', message: '请先打开Ozon FBP申请的“商品和货位”页面' };
    }
    const items = Array.isArray(message?.payload?.items) ? message.payload.items : [];
    const normalized = items
      .map((item) => ({ sku: String(item?.sku || '').trim(), quantity: Math.max(1, Math.round(Number(item?.quantity || 0))) }))
      .filter((item) => item.sku && item.quantity > 0);
    if (!normalized.length) return { success: false, error: 'FBP_ITEMS_REQUIRED', message: '备货单没有可填写的SKU和数量' };

    const results = [];
    for (let index = 0; index < normalized.length; index += 1) {
      renderFbpProgress(`爆单ERP正在填写：${index + 1}/${normalized.length}`, results);
      const result = await fillSingleFbpItem(normalized[index]).catch((error) => ({
        success: false,
        sku: normalized[index].sku,
        message: error?.message || String(error)
      }));
      results.push(result);
      await sleep(800);
    }
    const successCount = results.filter((item) => item.success).length;
    const failCount = results.length - successCount;
    renderFbpProgress(`填写完成：成功${successCount}，失败${failCount}\n请人工填写货位数量并检查后继续。`, results);
    return {
      success: failCount === 0,
      partial: successCount > 0 && failCount > 0,
      total: results.length,
      successCount,
      failCount,
      results,
      message: `填写完成：成功${successCount}，失败${failCount}。请人工填写货位数量并检查后继续。`
    };
  }

  function getCompanyId() {
    const values = document.cookie.split(';')
      .map((item) => item.trim().match(/^sc_company_id=(.*)$/))
      .filter(Boolean)
      .map((match) => decodeURIComponent(match[1] || '').trim())
      .filter(Boolean);
    const uniqueValues = [...new Set(values)];
    return uniqueValues.length === 1 ? uniqueValues[0] : '';
  }

  function syncSellerAuthBinding() {
    chrome.runtime.sendMessage({
      type: 'OZON_ERP_SELLER_AUTH_SYNC',
      companyId: getCompanyId(),
      visible: document.visibilityState === 'visible',
      url: location.href
    }).catch(() => {});
  }

  function clearCompanyId() {
    localStorage.removeItem('ozon_company_id');
  }

  function parseDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) throw new Error('Invalid media data URL');
    const mimeType = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || '';
    const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { bytes, mimeType };
  }

  function buildMediaUploadHeaders(companyId) {
    return {
      'x-o3-app-name': 'seller-ui',
      'x-o3-company-id': companyId,
      'x-o3-language': 'zh-Hans',
      'x-o3-page-type': 'seller',
      'x-o3-request-source': 'seller'
    };
  }

  function buildSellerMediaUploadError(response, responseText = '') {
    if (response?.status === 401 || response?.status === 403) {
      return 'Ozon Seller upload authorization failed. Please log in to seller.ozon.ru and retry.';
    }
    const statusText = String(response?.statusText || '').trim();
    const text = String(responseText || '').trim();
    return `HTTP ${response?.status || 0}: ${statusText || text.slice(0, 120)}`;
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

  async function runMediaUploadRequest(message) {
    const companyId = getCompanyId();
    if (!companyId) {
      throw new Error('Failed to get Ozon company ID. Please make sure seller.ozon.ru is logged in.');
    }

    const parsed = parseDataUrl(message.dataUrl);
    const mediaType = String(message.mediaType || message.kind || 'image').trim().toLowerCase() === 'video' ? 'video' : 'image';
    const fallbackFileName = mediaType === 'video' ? 'video.mp4' : 'image.png';
    const fileName = String(message.fileName || fallbackFileName).trim() || fallbackFileName;
    const mimeType = String(message.mimeType || parsed.mimeType || (mediaType === 'video' ? 'video/mp4' : 'image/png')).trim();
    const file = new File([parsed.bytes], fileName, { type: mimeType });
    const formData = new FormData();
    const fields = [];
    const uploadUrl = mediaType === 'video' ? VIDEO_UPLOAD_URL : IMAGE_UPLOAD_URL;

    if (mediaType === 'video') {
      formData.append('file_name', fileName);
      formData.append('tmp', 'true');
      formData.append('body', file, fileName);
      fields.push('file_name', 'tmp', 'body');
    } else {
      formData.append('image', file, fileName);
      fields.push('image');
    }

    const response = await fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: buildMediaUploadHeaders(companyId),
      body: formData
    });
    const responseText = await response.text();
    let data = null;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch (error) {}
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      clearCompanyId();
    }
    const url = data?.url || '';
    return {
      success: response.ok,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      mediaType,
      url,
      name: data?.name || fileName,
      data,
      responseText,
      request: {
        url: uploadUrl,
        method: 'POST',
        mediaType,
        fields,
        fileName,
        mimeType
      },
      error: response.ok ? null : buildSellerMediaUploadError(response, responseText),
      message: response.ok ? '' : buildSellerMediaUploadError(response, responseText)
    };
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

    if (message?.type === 'OZON_ERP_MEDIA_UPLOAD') {
      runMediaUploadRequest(message)
        .then((data) => {
          sendResponse({
            ...data,
            requestId: message.requestId
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error?.message || String(error),
            requestId: message.requestId
          });
        });
      return true;
    }

    if (message?.type === 'OZON_ERP_FBP_FILL') {
      runFbpFill(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
      return true;
    }

    return false;
  });

  syncSellerAuthBinding();
  window.setInterval(syncSellerAuthBinding, 3000);
})();

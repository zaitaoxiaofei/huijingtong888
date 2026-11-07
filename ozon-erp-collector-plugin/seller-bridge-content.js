(function initOzonErpSellerBridge() {
  'use strict';

  if (window.__ozonErpSellerBridgeLoaded) return;
  window.__ozonErpSellerBridgeLoaded = true;

  const IMAGE_UPLOAD_URL = 'https://api.seller.ozon.ru/api/images/synchronous/validate_raw';
  const VIDEO_UPLOAD_URL = 'https://api.seller.ozon.ru/api/media-storage/upload-file';
  const FBP_PAGE_RE = /\/app\/fbp-supply\/create-order\/\d+/i;
  const FBP_SEARCH_RESULT_TIMEOUT_MS = 4000;
  const FBP_ADDED_ROW_TIMEOUT_MS = 5000;
  const FBP_QUANTITY_CONFIRM_TIMEOUT_MS = 1500;
  const FBP_FINAL_VERIFY_DELAY_MS = 600;

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
    if (typeof input.blur === 'function') input.blur();
    else input.dispatchEvent(new Event('blur', { bubbles: true }));
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

  function hasExactSku(element, sku) {
    const target = String(sku || '').trim().toLowerCase();
    if (!target) return false;
    const text = String(element?.textContent || '').toLowerCase();
    if (/^\d+$/.test(target)) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\D)${escaped}(?=\\D|$)`).test(text);
    }
    const tokens = text.match(/[a-zа-яё0-9_-]+/gi) || [];
    return tokens.includes(target);
  }

  function findVisibleSkuElements(sku) {
    return [...document.querySelectorAll('div,span,p,a,td')]
      .filter((element) => visible(element) && hasExactSku(element, sku))
      .sort((left, right) => String(left.textContent || '').length - String(right.textContent || '').length);
  }

  function hasExactFbpSkuIdentity(element, sku) {
    const target = String(sku || '').trim().toLowerCase();
    if (!target) return false;
    const text = String(element?.textContent || '').trim().toLowerCase();
    if (text === target) return true;
    if (!/^\d+$/.test(target)) return hasExactSku(element, target);
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escaped}(?=\\D|$)`).test(text)) return true;
    return new RegExp(`(^|[^a-zа-яё0-9_-])ozn\\s*${escaped}(?=[^0-9]|$)`, 'i').test(text);
  }

  function findVisibleSkuIdentityElements(sku) {
    return [...document.querySelectorAll('div,span,p,a,td')]
      .filter((element) => visible(element) && hasExactFbpSkuIdentity(element, sku))
      .sort((left, right) => String(left.textContent || '').length - String(right.textContent || '').length);
  }

  function isFbpAddButton(button, skuElement, container, searchInput) {
    const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.title || ''}`.trim().toLowerCase();
    const explicitlyAdd = /添加|добав|add/.test(label);
    if (!explicitlyAdd && label && label !== '+') return false;

    const editableInputs = [...container.querySelectorAll('input')].filter((input) => {
      if (input === searchInput || input.disabled || input.readOnly) return false;
      return !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(String(input.getAttribute('type') || 'text').toLowerCase());
    });
    if (editableInputs.length) return false;

    const buttonRect = button.getBoundingClientRect();
    const skuRect = skuElement.getBoundingClientRect();
    if (buttonRect.width <= 0 || buttonRect.width > 72 || buttonRect.height <= 0 || buttonRect.height > 72) return false;
    if (buttonRect.left < skuRect.right - 8) return false;
    const verticalDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (skuRect.top + skuRect.height / 2));
    if (verticalDistance > 56) return false;
    if (explicitlyAdd) return true;

    const iconHint = `${button.getAttribute('data-testid') || ''} ${button.getAttribute('data-icon') || ''} ${button.className || ''}`.toLowerCase();
    return label === '+' || /(^|[-_\s])(plus|add)([-_\s]|$)/.test(iconHint) || Boolean(button.querySelector('svg'));
  }

  function findFbpClickableElements(root = document) {
    const candidates = new Set(root.querySelectorAll('button,[role="button"],[tabindex="0"]'));
    for (const svg of root.querySelectorAll('svg')) {
      let element = svg.parentElement;
      for (let depth = 0; element && depth < 4; depth += 1, element = element.parentElement) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.width <= 72 && rect.height > 0 && rect.height <= 72) candidates.add(element);
      }
    }
    return [...candidates];
  }

  function findAddButtonForSkuElement(skuElement, sku, searchInput) {
    let container = skuElement;
    for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
      if (!hasExactSku(container, sku)) continue;
      const buttons = findFbpClickableElements(container)
        .filter((button) => visible(button) && !button.disabled);
      const addButton = buttons.find((button) => isFbpAddButton(button, skuElement, container, searchInput));
      if (addButton) return addButton;
    }
    const skuRect = skuElement.getBoundingClientRect();
    return findFbpClickableElements(document)
      .filter((button) => visible(button) && !button.disabled)
      .filter((button) => isFbpAddButton(button, skuElement, button.parentElement || button, searchInput))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { button, distance: Math.abs((rect.top + rect.height / 2) - (skuRect.top + skuRect.height / 2)) };
      })
      .sort((left, right) => left.distance - right.distance)[0]?.button || null;
  }

  function findAddButtonForSku(sku) {
    const searchInput = findFbpSearchInput();
    const skuElements = findVisibleSkuIdentityElements(sku);
    for (const skuElement of skuElements.slice(0, 8)) {
      const addButton = findAddButtonForSkuElement(skuElement, sku, searchInput);
      if (addButton) return addButton;
    }
    return null;
  }

  function isSameFbpQuantityRow(skuElement, input) {
    const skuRect = skuElement.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const verticalDistance = Math.abs((inputRect.top + inputRect.height / 2) - (skuRect.top + skuRect.height / 2));
    if (verticalDistance > 48 || inputRect.left < skuRect.right - 8) return false;

    let sharedContainer = skuElement;
    for (let depth = 0; sharedContainer && depth < 10; depth += 1, sharedContainer = sharedContainer.parentElement) {
      if (!sharedContainer.contains(input)) continue;
      const sharedRect = sharedContainer.getBoundingClientRect();
      if (sharedRect.height <= 0 || sharedRect.height > 220) return false;
      return true;
    }
    return false;
  }

  function findQuantityInputForSku(sku) {
    const searchInput = findFbpSearchInput();
    const skuElements = findVisibleSkuIdentityElements(sku);
    for (const skuElement of skuElements.slice(0, 12)) {
      if (findAddButtonForSkuElement(skuElement, sku, searchInput)) continue;
      let container = skuElement.closest('tr') || skuElement;
      for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
        if (!hasExactSku(container, sku)) continue;
        const inputs = [...container.querySelectorAll('input')].filter((input) => {
          if (!visible(input) || input === searchInput || input.disabled || input.readOnly) return false;
          const type = String(input.getAttribute('type') || 'text').toLowerCase();
          return !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type);
        }).filter((input) => isSameFbpQuantityRow(skuElement, input));
        const quantityInput = inputs.find((input) => {
          const hint = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('inputmode') || ''} ${input.getAttribute('role') || ''}`.toLowerCase();
          return String(input.getAttribute('type') || '').toLowerCase() === 'number' || /数量|quantity|колич|numeric|decimal|spinbutton/.test(hint);
        });
        if (quantityInput) return quantityInput;
        if (inputs.length === 1) return inputs[0];
      }
    }
    return null;
  }

  function failureClipboardText(results = []) {
    return results
      .filter((item) => !item.success)
      .map((item) => `${item.sku}\t${item.quantity}\t${item.offerId || ''}\t${item.message || '填写失败'}`)
      .join('\n');
  }

  async function copyFbpFailureText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {}
    const textarea = document.createElement('textarea');
    textarea.value = text;
    Object.assign(textarea.style, { position: 'fixed', left: '-9999px', top: '-9999px' });
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {}
    textarea.remove();
    return copied;
  }

  function renderFbpProgress(summary, results = [], { complete = false } = {}) {
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
    const failed = results.filter((item) => !item.success);
    const detail = complete
      ? failed.map((item) => `× ${item.sku} × ${item.quantity}：${item.message || '填写失败'}`)
      : results.slice(-8).map((item) => `${item.success ? '✓' : '×'} ${item.sku} ${item.message || ''}`);
    panel.textContent = [summary, complete && failed.length ? '以下项目请手工搜索并补数量：' : '', ...detail].filter(Boolean).join('\n');
    if (complete && failed.length) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '复制失败清单';
      Object.assign(button.style, {
        display: 'block', width: '100%', marginTop: '10px', padding: '8px 12px', border: '0', borderRadius: '7px',
        background: '#1677ff', color: '#fff', cursor: 'pointer', fontWeight: '600'
      });
      button.addEventListener('click', async () => {
        const copied = await copyFbpFailureText(failureClipboardText(failed));
        button.textContent = copied ? '失败清单已复制' : '复制失败，请手工选择上方文字';
      });
      panel.appendChild(button);
    }
  }

  async function fillSingleFbpItem(item) {
    const startedAt = Date.now();
    const sku = String(item?.sku || '').trim();
    const offerId = String(item?.offerId || '').trim();
    const quantity = Math.max(1, Math.round(Number(item?.quantity || 0)));
    if (!sku) return { success: false, sku, offerId, quantity, message: 'SKU为空', durationMs: Date.now() - startedAt };

    let quantityInput = findQuantityInputForSku(sku);
    if (!quantityInput) {
      const searchInput = await waitFor(findFbpSearchInput, 10000);
      if (!searchInput) return { success: false, sku, offerId, quantity, message: '未找到SKU搜索框', durationMs: Date.now() - startedAt };
      const searchTerms = [...new Set([sku, offerId].filter(Boolean))];
      let sawExactSearchResult = false;
      let addAttempted = false;
      for (const searchTerm of searchTerms) {
        const currentSearchInput = findFbpSearchInput() || searchInput;
        currentSearchInput.focus();
        setNativeInputValue(currentSearchInput, '');
        await sleep(80);
        setNativeInputValue(currentSearchInput, searchTerm);
        const outcome = await waitFor(() => {
          const addButton = findAddButtonForSku(sku);
          if (addButton) return { addButton };
          const existingInput = findQuantityInputForSku(sku);
          if (existingInput) return { quantityInput: existingInput };
          return null;
        }, FBP_SEARCH_RESULT_TIMEOUT_MS, 100);
        if (outcome?.quantityInput) {
          quantityInput = outcome.quantityInput;
          break;
        }
        if (outcome?.addButton) {
          sawExactSearchResult = true;
          addAttempted = true;
          outcome.addButton.click();
          quantityInput = await waitFor(() => findQuantityInputForSku(sku), FBP_ADDED_ROW_TIMEOUT_MS, 100);
          break;
        }
        sawExactSearchResult = findVisibleSkuElements(sku).length > 0;
        if (sawExactSearchResult) break;
      }
      if (!quantityInput) {
        const message = addAttempted
          ? '已找到商品并点击添加，但未出现对应数量输入框'
          : (sawExactSearchResult ? '已搜索到商品，但未识别到右侧添加按钮' : '使用Ozon SKU和商家货号均未搜索到精确商品');
        return { success: false, sku, offerId, quantity, message, durationMs: Date.now() - startedAt };
      }
    }

    let confirmedInput = null;
    for (let attempt = 0; attempt < 2 && !confirmedInput; attempt += 1) {
      quantityInput.focus();
      setNativeInputValue(quantityInput, quantity);
      confirmedInput = await waitFor(() => {
        const currentInput = findQuantityInputForSku(sku) || quantityInput;
        return Math.round(Number(currentInput.value || 0)) === quantity ? currentInput : null;
      }, FBP_QUANTITY_CONFIRM_TIMEOUT_MS, 80);
    }
    const actualInput = confirmedInput || findQuantityInputForSku(sku) || quantityInput;
    const actual = Math.round(Number(actualInput.value || 0));
    if (actual !== quantity) return { success: false, sku, offerId, quantity, actual, message: `数量回填失败，页面显示${actual}`, durationMs: Date.now() - startedAt };
    return { success: true, sku, offerId, quantity, message: `已填写${quantity}`, durationMs: Date.now() - startedAt };
  }

  async function verifySettledFbpResults(results) {
    await sleep(FBP_FINAL_VERIFY_DELAY_MS);
    const verified = results.map((result) => ({ ...result }));
    const ownerByInput = new Map();
    const duplicatedIndexes = new Set();

    for (let index = 0; index < verified.length; index += 1) {
      const result = verified[index];
      if (!result.success) continue;
      const input = findQuantityInputForSku(result.sku);
      if (!input) {
        result.success = false;
        result.message = '页面终检失败：未找到该SKU自己的商品数量行，未计入成功';
        continue;
      }
      const actual = Math.round(Number(input.value || 0));
      if (actual !== result.quantity) {
        result.success = false;
        result.actual = actual;
        result.message = `页面终检失败：该SKU页面数量为${actual}，目标数量为${result.quantity}`;
        continue;
      }
      if (ownerByInput.has(input)) {
        duplicatedIndexes.add(ownerByInput.get(input));
        duplicatedIndexes.add(index);
      } else {
        ownerByInput.set(input, index);
      }
    }

    for (const index of duplicatedIndexes) {
      verified[index].success = false;
      verified[index].message = '页面终检失败：多个SKU命中了同一个数量框，已阻止假成功';
    }
    return verified;
  }

  async function runFbpFill(message) {
    if (!FBP_PAGE_RE.test(location.pathname)) {
      return { success: false, error: 'FBP_PAGE_REQUIRED', message: '请先打开Ozon FBP申请的“商品和货位”页面' };
    }
    const expectedCompanyId = String(message?.payload?.ozonCompanyId || '').trim();
    const currentCompanyId = getCompanyId();
    if (!expectedCompanyId) {
      return { success: false, error: 'FBP_TARGET_COMPANY_REQUIRED', message: 'ERP店铺缺少Ozon Client ID，已阻止自动填写' };
    }
    if (!currentCompanyId || currentCompanyId !== expectedCompanyId) {
      return { success: false, error: 'FBP_COMPANY_MISMATCH', expectedCompanyId, currentCompanyId, message: `当前Ozon店铺与备货单店铺不一致，已阻止自动填写（目标 ${expectedCompanyId}，当前 ${currentCompanyId || '无法识别'}）` };
    }
    const items = Array.isArray(message?.payload?.items) ? message.payload.items : [];
    const normalized = items
      .map((item) => ({ sku: String(item?.sku || '').trim(), offerId: String(item?.offerId || '').trim(), quantity: Math.max(1, Math.round(Number(item?.quantity || 0))) }))
      .filter((item) => item.sku && item.quantity > 0);
    if (!normalized.length) return { success: false, error: 'FBP_ITEMS_REQUIRED', message: '备货单没有可填写的SKU和数量' };

    const startedAt = Date.now();
    let results = [];
    for (let index = 0; index < normalized.length; index += 1) {
      renderFbpProgress(`爆单ERP正在填写：${index + 1}/${normalized.length}`, results);
      const result = await fillSingleFbpItem(normalized[index]).catch((error) => ({
        success: false,
        sku: normalized[index].sku,
        offerId: normalized[index].offerId,
        quantity: normalized[index].quantity,
        message: error?.message || String(error)
      }));
      results.push(result);
      await sleep(120);
    }
    const finalSearchInput = findFbpSearchInput();
    if (finalSearchInput) {
      setNativeInputValue(finalSearchInput, '');
      await sleep(120);
    }
    results = await verifySettledFbpResults(results);
    const successCount = results.filter((item) => item.success).length;
    const failCount = results.length - successCount;
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    renderFbpProgress(`填写完成：成功${successCount}，失败${failCount}，耗时${durationSeconds}秒。${failCount ? '\n成功项目已保留，不需要重复填写。' : ''}`, results, { complete: true });
    return {
      success: failCount === 0,
      partial: successCount > 0 && failCount > 0,
      total: results.length,
      successCount,
      failCount,
      durationSeconds,
      results,
      failedItems: results.filter((item) => !item.success),
      message: `填写完成：成功${successCount}，失败${failCount}，耗时${durationSeconds}秒。${failCount ? '失败项目已单独整理，可复制后手工补录。' : '请检查货位数量后继续。'}`
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

    if (message?.type === 'OZON_ERP_FBP_CONTEXT') {
      sendResponse({ success: true, companyId: getCompanyId(), url: location.href });
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

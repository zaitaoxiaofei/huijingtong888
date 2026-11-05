(function initCollectorBrowserPool(global) {
  const INSTANCE_KEY = 'ozon-erp-collector-browser-instance';
  const SALES_KEYS = new Set(['soldCount', 'soldSum', 'soldSumRub', 'soldSumCny', 'gmvSum', 'salesDynamics', 'salesUpdateDate']);

  function create(deps) {
    const chrome = deps.chrome;
    const workers = new Map();
    const activeCompanies = new Set();
    let instancePromise;
    let tickPromise;
    let timer;
    let lastScan = 0;
    let idleDelay = 2500;
    let previewCount = 0;
    let stopped = true;

    function contextKey(context) {
      return JSON.stringify([context.erpBaseUrl, context.tenantId, context.token]);
    }

    async function bounded(promise, ms = 15000) {
      let deadline;
      try {
        return await Promise.race([promise, new Promise((resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Collector browser operation timed out')), ms);
        })]);
      } finally {
        clearTimeout(deadline);
      }
    }

    function instanceId() {
      if (!instancePromise) instancePromise = (async () => {
        const stored = await chrome.storage.local.get(INSTANCE_KEY);
        if (stored[INSTANCE_KEY]) return String(stored[INSTANCE_KEY]);
        const id = global.crypto.randomUUID();
        await chrome.storage.local.set({ [INSTANCE_KEY]: id });
        return id;
      })().catch((error) => { instancePromise = null; throw error; });
      return instancePromise;
    }

    async function api(context, path, body, timeoutMs = 15000) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (deps.fetch || global.fetch)(`${context.erpBaseUrl}/api/local-plugin/collector-browser-pool${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'x-tenant-id': context.tenantId || 'admin',
            'x-local-plugin-token': context.token || ''
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
        const json = await response.json().catch((error) => {
          if (error?.name === 'AbortError') throw error;
          const invalid = new Error('Collector browser service response invalid');
          if (response.status >= 400 && response.status < 500) invalid.status = response.status;
          throw invalid;
        });
        if (!response.ok || json?.success === false) {
          const error = new Error('Collector browser service request rejected');
          error.status = response.status;
          error.code = json?.code || '';
          throw error;
        }
        return json?.data?.batch_id ? json.data : json;
      } catch (error) {
        if (error?.name === 'AbortError') {
          const timeout = new Error('Collector browser service timed out');
          timeout.code = 'COLLECTOR_BROWSER_TIMEOUT';
          throw timeout;
        }
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    }

    async function identity(tab, storeId) {
      const unavailable = { companyId: '', code: 'STORE_IDENTITY_UNAVAILABLE' };
      try {
      const url = new URL(tab.url || '');
      if (url.origin !== 'https://seller.ozon.ru') return unavailable;
      const results = await bounded(chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => {
          if (location.origin !== 'https://seller.ozon.ru') return '';
          const ids = [...new Set(document.cookie.split(';').map((part) => part.trim().match(/^sc_company_id=(.*)$/))
            .filter(Boolean).map((match) => decodeURIComponent(match[1]).trim()).filter(Boolean))];
          return ids.length === 1 ? ids[0] : '';
        }
      }));
      const pageId = String(results?.[0]?.result || '').trim();
      const cookies = await bounded(chrome.cookies.getAll({ url: tab.url, ...(storeId ? { storeId } : {}) }));
      const cookieIds = [...new Set(cookies.filter((cookie) => cookie.name === 'sc_company_id').map((cookie) => String(cookie.value || '').trim()).filter(Boolean))];
      if (!pageId || !cookieIds.length) return unavailable;
      if (cookieIds.length !== 1 || cookieIds[0] !== pageId) return { companyId: '', code: 'STORE_CONTEXT_MISMATCH' };
      return { companyId: pageId, code: '' };
      } catch (error) {
        return unavailable;
      }
    }

    async function scan(context) {
      const [tabs, stores, instance] = await bounded(Promise.all([
        chrome.tabs.query({ url: 'https://seller.ozon.ru/*' }),
        chrome.cookies.getAllCookieStores(), instanceId()
      ]));
      const current = new Set();
      for (const tab of tabs) {
        try {
          const storeId = String(stores.find((store) => store.tabIds?.includes(tab.id))?.id || '');
          if (!storeId) continue;
          const companyId = (await identity(tab, storeId)).companyId;
          if (!companyId) continue;
          const workerId = `${instance}_${storeId}_${companyId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
          current.add(workerId);
          const previous = workers.get(workerId);
          const sameContext = previous && contextKey(previous.context) === contextKey(context);
          workers.set(workerId, Object.assign(sameContext ? previous : {}, { id: workerId, tab, storeId, companyId, context }));
        } catch (error) {}
      }
      for (const id of workers.keys()) if (!current.has(id)) workers.delete(id);
    }

    async function assertIdentity(worker, task) {
      const live = await identity(worker.tab, worker.storeId);
      if (live.code || String(task.company_id) !== worker.companyId || live.companyId !== worker.companyId) {
        const code = live.code || 'STORE_CONTEXT_MISMATCH';
        const error = new Error(code);
        error.code = code;
        error.status = 409;
        throw error;
      }
    }

    async function execute(registeredWorker, task, releaseTab = () => {}) {
      const worker = { ...registeredWorker, tab: { ...registeredWorker.tab }, context: { ...registeredWorker.context } };
      const companyKey = `${worker.context.erpBaseUrl}:${worker.context.tenantId}:${worker.companyId}`;
      if (activeCompanies.has(companyKey)) { releaseTab(); return; }
      activeCompanies.add(companyKey);
      const expiresAt = Date.parse(task.lease_expires_at || '');
      const report = async (phase, fields = {}, warnings = [], error = '', status = 0) => {
        if (phase !== 'failed' && (!Number.isFinite(expiresAt) || Date.now() >= expiresAt)) {
          const expired = new Error('COLLECTOR_BROWSER_LEASE_EXPIRED');
          expired.status = 409;
          throw expired;
        }
        return api(worker.context, '/results', {
          worker_id: worker.id, company_id: worker.companyId, task_id: task.task_id,
          lease_token: task.lease_token, sku: task.sku, phase, fields, warnings, error, status
        });
      };
      try {
        if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw Object.assign(new Error('COLLECTOR_BROWSER_LEASE_EXPIRED'), { status: 409 });
        await assertIdentity(worker, task);
        const sellerResult = await deps.collectFields(task.sku, {
          request: async (sku, apiType, variantId) => {
            if (Date.now() >= expiresAt) throw Object.assign(new Error('COLLECTOR_BROWSER_LEASE_EXPIRED'), { status: 409 });
            await assertIdentity(worker, task);
            const result = await bounded(deps.requestInTab(worker.tab, { sku, apiType, variantId, expectedCompanyId: worker.companyId }), 20000);
            if (!result?.success) {
              const error = new Error(['STORE_CONTEXT_MISMATCH', 'STORE_IDENTITY_UNAVAILABLE'].includes(result?.code) ? result.code : 'Seller browser request rejected');
              error.status = Number(result?.status || 0);
              error.code = result?.code || '';
              throw error;
            }
            await assertIdentity(worker, task);
            return result.data;
          },
          throwOnRequestError: true,
          onSales: async (result) => {
            await assertIdentity(worker, task);
            const fields = Object.fromEntries(Object.entries(result.fields).filter(([key]) => SALES_KEYS.has(key)));
            await report('sales', fields, []);
          }
        });
        await assertIdentity(worker, task);
        const payload = deps.buildPayload(task.sku, sellerResult);
        if (!Object.keys(sellerResult.fields || {}).length) throw new Error('Seller returned no product fields');
        await report('complete', deps.buildDisplay(payload), sellerResult.warnings || []);
      } catch (error) {
        const status = Number(error?.status || 0);
        if ([401, 403, 429].includes(status)) registeredWorker.cooldownUntil = Date.now() + 60000;
        const identityCode = ['STORE_CONTEXT_MISMATCH', 'STORE_IDENTITY_UNAVAILABLE'].find((code) => error?.code === code || error?.message === code);
        const code = identityCode || (/COLLECTOR_BROWSER_LEASE/.test(error?.code || error?.message || '')
          ? 'COLLECTOR_BROWSER_LEASE_REJECTED' : 'COLLECTOR_BROWSER_TASK_FAILED');
        await report('failed', {}, [], code, status).catch(() => {});
      } finally {
        activeCompanies.delete(companyKey);
        releaseTab();
      }
    }

    async function tick() {
      if (tickPromise) return tickPromise;
      tickPromise = (async () => {
        const context = await deps.getContext();
        if (!lastScan || Date.now() - lastScan >= 15000) { await scan(context); lastScan = Date.now(); }
        let claimed = false;
        for (const worker of workers.values()) {
          if (contextKey(worker.context) !== contextKey(context) || Date.now() < Number(worker.cooldownUntil || 0)) continue;
          const companyKey = `${context.erpBaseUrl}:${context.tenantId}:${worker.companyId}`;
          try {
            await assertIdentity(worker, { company_id: worker.companyId });
            if (!worker.heartbeatAt || Date.now() - worker.heartbeatAt >= 15000) {
              await api(context, '/heartbeat', {
                worker_id: worker.id, company_id: worker.companyId, observed_company_id: '',
                cookie_company_id: worker.companyId, page_company_id: worker.companyId,
                identity_source: 'page_cookie', plugin_version: chrome.runtime.getManifest().version
              });
              worker.heartbeatAt = Date.now();
            }
            if (activeCompanies.has(companyKey)) continue;
            let releaseTab = deps.coordination ? deps.coordination.tryAcquireCollectorTab(worker.tab.id) : () => {};
            if (!releaseTab) continue;
            try {
              const response = await api(context, '/claim', { worker_id: worker.id, company_id: worker.companyId });
              if (response.task) {
                claimed = true;
                void execute(worker, response.task, releaseTab);
                releaseTab = null;
              }
            } finally {
              releaseTab?.();
            }
          } catch (error) {
            if ([401, 403, 409, 429].includes(Number(error?.status))) worker.cooldownUntil = Date.now() + 60000;
          }
        }
        idleDelay = claimed || previewCount ? 2500 : Math.min(30000, idleDelay * 2);
      })().catch(() => {}).finally(() => { tickPromise = null; });
      return tickPromise;
    }

    function schedule(delay = idleDelay) {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void tick().finally(() => schedule()); }, delay);
    }

    async function preview(skus, baseBySku, tabId) {
      const context = await bounded(deps.getContext()).catch(() => null);
      if (!context) return null;
      const safelyRejected = (error) => [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(Number(error?.status));
      const unknownSubmission = async () => {
        const results = [];
        for (const sku of skus) {
          const result = { sku, success: false, error: '商品取数任务提交状态未知，请稍后重试' };
          results.push(result);
          await deps.emit(tabId, result);
        }
        return { results, fallbackSkus: [] };
      };
      let batch;
      try {
        batch = await api(context, '/batches', { skus });
      } catch (error) {
        if (error?.status !== 409 || error?.code !== 'COLLECTOR_BROWSER_POOL_UNAVAILABLE') return safelyRejected(error) ? null : unknownSubmission();
        // No batch was accepted. Give this browser one bounded registration pass
        // before falling back; never replay a batch with an unknown outcome.
        await bounded(tick()).catch(() => {});
        try { batch = await api(context, '/batches', { skus }); } catch (retryError) { return safelyRejected(retryError) ? null : unknownSubmission(); }
      }
      if (!batch?.batch_id) return unknownSubmission();
      const complete = new Map();
      let revision = 0;
      previewCount++;
      schedule(0);
      const deadline = Date.now() + 300000;
      try {
        while (true) {
          for (const item of batch.results || []) {
            if (!skus.includes(String(item.sku)) || complete.has(String(item.sku))) continue;
            const sku = String(item.sku);
            const route = { mode: 'browser_pool', companyId: item.source_company_id || '', shopId: item.source_shop_id || '', shopName: item.source_shop_name || '' };
            if (item.success && item.partial) {
              const product = Object.fromEntries(Object.entries(item.product || {}).filter(([key]) => SALES_KEYS.has(key)));
              await deps.emit(tabId, { sku, success: true, partial: true, stage: 'sales', previewOnly: true, product, collectionRoute: route });
            } else if (item.success) {
              const payload = deps.buildPayload(sku, { fields: item.product || {}, raw: {}, warnings: item.warnings || [] }, baseBySku.get(sku));
              const result = { sku, success: true, previewOnly: true, imported: false, product: deps.buildDisplay(payload), collectionRoute: route };
              complete.set(sku, result);
              await deps.emit(tabId, result);
            }
          }
          revision = Math.max(revision, Number(batch.revision || 0));
          if (['complete', 'failed'].includes(batch.status)) break;
          if (Date.now() >= deadline) throw new Error('COLLECTOR_BROWSER_BATCH_TIMEOUT');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          batch = await api(context, `/batches/${encodeURIComponent(batch.batch_id)}?after=${revision}`);
        }
        return { results: [...complete.values()], fallbackSkus: skus.filter((sku) => !complete.has(sku)) };
      } catch (error) {
        const results = [...complete.values()];
        for (const sku of skus) if (!complete.has(sku)) {
          const result = { sku, success: false, error: '浏览器取数任务状态暂不可用，请稍后重试' };
          results.push(result);
          await deps.emit(tabId, result);
        }
        return { results, fallbackSkus: [] };
      } finally {
        previewCount--;
      }
    }

    return {
      start() { stopped = false; schedule(0); },
      stop() { stopped = true; clearTimeout(timer); },
      wake() { lastScan = 0; schedule(0); },
      tick, preview, instanceId
    };
  }

  global.OzonCollectorBrowserPool = { create };
})(globalThis);

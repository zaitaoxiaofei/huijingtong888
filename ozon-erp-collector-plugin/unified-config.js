(function initUnifiedConfig(global) {
  if (global.OzonUnifiedConfig?.get) return;
  const BASE = 'https://erp.hjt888.xyz';
  const TOKEN = 'ozon-erp-local-plugin-token';
  const BASE_KEY = 'ozon-erp-base-url';
  const TENANT = 'ozon-erp-tenant-id';
  const TENANT_BASE = 'ozon-erp-tenant-base-url';
  const CONNECTION = 'ozon-erp-unified-connection-v1';

  function create({ chrome, fetchImpl = global.fetch, baseUrl = BASE, timeoutMs = 6000, clock = Date.now }) {
    let attached = false;
    let generation = 0;
    let inFlight = null;
    let lastAttempt = -Infinity;
    let writes = Promise.resolve();
    const normalizeBase = (value) => String(value || '').trim().replace(/\/+$/, '');
    const fingerprint = async (token) => Array.from(new Uint8Array(await global.crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(token)
    )), byte => byte.toString(16).padStart(2, '0')).join('');

    function persist(epoch, patch) {
      const pending = writes.catch(() => {}).then(async () => {
        if (generation !== epoch) return false;
        await chrome.storage.local.set(patch);
        return true;
      });
      writes = pending;
      return pending;
    }

    async function read() {
      const stored = await chrome.storage.local.get([TOKEN, BASE_KEY, CONNECTION]);
      const scopeMismatch = Boolean(stored[BASE_KEY] && normalizeBase(stored[BASE_KEY]) !== normalizeBase(baseUrl));
      const token = scopeMismatch ? '' : String(stored[TOKEN] || '').trim();
      const keyHash = token ? await fingerprint(token) : '';
      const cached = stored[CONNECTION]?.keyHash === keyHash && stored[CONNECTION]?.baseUrl === baseUrl
        ? stored[CONNECTION] : null;
      return { token, keyHash, cached, scopeMismatch };
    }

    function snapshot(state) {
      return {
        configured: Boolean(state.token),
        connected: Boolean(state.token && state.cached?.connected),
        tenantId: state.cached?.tenantId || '',
        checking: Boolean(state.token && inFlight?.keyHash === state.keyHash),
        requiresKeyEntry: state.scopeMismatch,
        lastError: state.scopeMismatch ? '原连接属于其他 ERP 地址，请填写当前服务的企业密钥'
          : state.cached?.lastError || (state.token ? '' : '请填写企业密钥')
      };
    }

    async function refresh(force = false) {
      const state = await read();
      if (!state.token) return snapshot(state);
      if (inFlight?.keyHash === state.keyHash) return inFlight.promise;
      if (!force && clock() - lastAttempt < 30000) return snapshot(state);
      lastAttempt = clock();
      const epoch = generation;
      const flight = { keyHash: state.keyHash };
      inFlight = flight;
      flight.promise = (async () => {
        const controller = new AbortController();
        let timer;
        let connection;
        try {
          const request = (async () => {
            const response = await fetchImpl(`${baseUrl}/api/local-plugin/plugin/status?plugin_version=${encodeURIComponent(chrome.runtime.getManifest().version)}`, {
              headers: { Accept: 'application/json', 'x-local-plugin-token': state.token },
              signal: controller.signal
            });
            if (!response.ok) throw Object.assign(new Error('Connection rejected'), { status: response.status });
            const body = await response.json();
            const data = body.data || body;
            if (body.success === false || data.connected !== true || data.app !== 'ozon-erp' || !String(data.tenantId || '').trim()) {
              throw new Error('Invalid connection response');
            }
            return String(data.tenantId).trim();
          })();
          const tenantId = await Promise.race([request, new Promise((resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Connection timed out')); }, timeoutMs);
          })]);
          connection = { connected: true, tenantId, lastError: '' };
        } catch (error) {
          connection = {
            connected: false,
            tenantId: state.cached?.tenantId || '',
            lastError: [401, 403].includes(Number(error?.status))
              ? '密钥无效或企业已停用，请从 ERP 企业管理重新复制有效密钥'
              : '密钥已保存，暂时无法连接 ERP，请稍后重试'
          };
        } finally {
          clearTimeout(timer);
        }
        const current = await read();
        if (generation === epoch && current.keyHash === state.keyHash && current.token) {
          const cached = { ...connection, keyHash: state.keyHash, baseUrl, checkedAt: clock() };
          await persist(epoch, {
            [BASE_KEY]: baseUrl, [CONNECTION]: cached,
            [TENANT]: connection.tenantId, [TENANT_BASE]: baseUrl
          });
          return snapshot(await read());
        }
        return snapshot(current);
      })().finally(() => { if (inFlight === flight) inFlight = null; });
      return flight.promise;
    }

    async function get() {
      const state = await read();
      return { erpBaseUrl: baseUrl, tenantId: state.cached?.tenantId || 'admin', localPluginToken: state.token };
    }

    async function connection() {
      const state = await read();
      if (state.token && (!state.cached || clock() - state.cached.checkedAt > 60000)) void refresh().catch(() => {});
      return snapshot(state);
    }

    async function saveKey(value) {
      const token = String(value || '').trim();
      if (!/^ozp_[A-Za-z0-9_-]{40,80}$/.test(token)) throw new Error('请粘贴 ERP 企业管理中 ozp_ 开头的完整企业密钥');
      const epoch = ++generation;
      lastAttempt = -Infinity;
      const keyHash = await fingerprint(token);
      const cached = { keyHash, baseUrl, connected: false, tenantId: '', lastError: '', checkedAt: 0 };
      const saved = await persist(epoch, {
        [TOKEN]: token, [BASE_KEY]: baseUrl, [CONNECTION]: cached, [TENANT]: '', [TENANT_BASE]: baseUrl
      });
      if (!saved || epoch !== generation) return connection();
      // A saved key is a local acknowledgement. Network verification must not
      // keep the popup in the saving state or supply the enterprise selector.
      void refresh(true).catch(() => {});
      return { configured: true, connected: false, tenantId: '', checking: true, lastError: '' };
    }

    function trustedPopup(sender) {
      const extensionUrl = chrome.runtime.getURL?.('') || `chrome-extension://${chrome.runtime.id}/`;
      return sender?.id === chrome.runtime.id && String(sender.url || '').startsWith(extensionUrl) && !sender.tab;
    }

    function attach() {
      if (attached) return;
      attached = true;
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!['OZON_UNIFIED_GET_CONNECTION', 'OZON_UNIFIED_SAVE_KEY'].includes(message?.type)) return false;
        if (!trustedPopup(sender)) {
          sendResponse({ success: false, error: '请从插件弹窗配置连接' });
          return false;
        }
        const pending = message.type === 'OZON_UNIFIED_SAVE_KEY' ? saveKey(message.key) : connection();
        pending.then(value => sendResponse({ success: true, connection: value }))
          .catch(error => sendResponse({ success: false, error: error.message || '无法保存插件连接设置' }));
        return true;
      });
      void connection().catch(() => {});
    }

    return { get, saveKey, connection, refresh, attach };
  }

  global.OzonUnifiedConfig = { create };
  if (global.chrome?.storage?.local && global.chrome?.runtime?.onMessage) {
    const instance = create({ chrome: global.chrome });
    Object.assign(global.OzonUnifiedConfig, instance);
    instance.attach();
  }
})(globalThis);

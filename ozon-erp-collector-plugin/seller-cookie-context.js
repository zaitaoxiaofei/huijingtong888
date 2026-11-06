(function initSellerCookieContext(global) {
  function create(chrome) {
    async function read(tab, { pageCompanyId = '', storeId = '' } = {}) {
      const unavailable = (code) => ({ cookies: [], companyId: '', storeId: '', code });
      let url;
      try { url = new URL(tab?.url || ''); } catch (error) { return unavailable('STORE_IDENTITY_UNAVAILABLE'); }
      if (!tab?.id || url.origin !== 'https://seller.ozon.ru' || !chrome?.cookies?.getAll) {
        return unavailable('STORE_IDENTITY_UNAVAILABLE');
      }
      try {
        const stores = await chrome.cookies.getAllCookieStores();
        const actualStore = stores.find((store) => store.tabIds?.includes(tab.id));
        if (!actualStore || (storeId && String(actualStore.id) !== String(storeId))) {
          return unavailable('COOKIE_STORE_UNAVAILABLE');
        }
        storeId = String(actualStore.id);
        const query = { url: url.href, storeId };
        const unpartitioned = await chrome.cookies.getAll(query);
        let partitioned = [];
        let partitionCode = '';
        if (chrome.cookies.getPartitionKey) {
          try {
            const details = await chrome.cookies.getPartitionKey({ tabId: tab.id, frameId: 0 });
            const key = details?.partitionKey;
            // An empty key selects every partition. Only use the real top-frame key.
            if (typeof key?.topLevelSite === 'string' && key.topLevelSite) {
              const partitionKey = { topLevelSite: key.topLevelSite };
              if (typeof key.hasCrossSiteAncestor === 'boolean') partitionKey.hasCrossSiteAncestor = key.hasCrossSiteAncestor;
              partitioned = await chrome.cookies.getAll({ ...query, partitionKey });
            }
          } catch (error) {
            // Optional partition APIs may exist but reject in supported browsers.
            // Preserve ordinary cookies; page/store checks still apply below.
            partitionCode = 'COOKIE_PARTITION_UNAVAILABLE';
          }
        }
        const seen = new Set();
        const cookies = [...unpartitioned, ...partitioned].filter((cookie) => {
          if (!cookie?.name) return false;
          const identity = JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.storeId,
            cookie.partitionKey?.topLevelSite || '', cookie.partitionKey?.hasCrossSiteAncestor, cookie.value]);
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        }).sort((a, b) => String(b.path || '/').length - String(a.path || '/').length);
        const ids = [...new Set(cookies.filter((cookie) => ['sc_company_id', 'company_id', 'seller_company_id'].includes(cookie.name))
          .map((cookie) => String(cookie.value || '').trim()).filter(Boolean))];
        const companyId = ids.length === 1 ? ids[0] : '';
        if (ids.length > 1 || (companyId && pageCompanyId && companyId !== String(pageCompanyId).trim())) {
          return unavailable('STORE_CONTEXT_MISMATCH');
        }
        return { cookies, companyId, storeId, code: '', diagnosticCode: partitionCode || (companyId ? '' : 'COOKIE_COMPANY_ID_MISSING') };
      } catch (error) {
        return unavailable(/permission|cannot access|not allowed|host access|denied/i.test(String(error?.message || ''))
          ? 'SELLER_TAB_PERMISSION_DENIED' : 'STORE_IDENTITY_UNAVAILABLE');
      }
    }
    return { read };
  }
  global.OzonSellerCookieContext = { create, ...(global.chrome ? create(global.chrome) : {}) };
})(globalThis);

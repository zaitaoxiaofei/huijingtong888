(function initOzonErpContentCore(global) {
  'use strict';

  if (global.OzonErpContentCore) return;

  function isOzonFrontLocation(locationLike = global.location) {
    return /(^|\.)ozon\.(ru|kz|by)$/i.test(String(locationLike?.hostname || ''));
  }

  function extractSkuFromUrl(url, collector = global.OzonErpCollector) {
    if (collector && typeof collector.extractOzonSku === 'function') {
      return collector.extractOzonSku(url);
    }
    const match = String(url || '').match(/\/product\/(?:[^/?#]+-)?(\d+)(?:[/?#]|$)/i);
    return match ? match[1] : '';
  }

  function getCurrentPageSku(locationLike = global.location, collector = global.OzonErpCollector) {
    return extractSkuFromUrl(locationLike?.href || '', collector);
  }

  function getPageType(locationLike = global.location, collector = global.OzonErpCollector) {
    if (!isOzonFrontLocation(locationLike)) return 'non_ozon';
    return getCurrentPageSku(locationLike, collector) ? 'ozon_product_detail' : 'ozon_list';
  }

  function isListLikePage(locationLike = global.location, collector = global.OzonErpCollector) {
    return getPageType(locationLike, collector) === 'ozon_list';
  }

  global.OzonErpContentCore = {
    isOzonFrontLocation,
    extractSkuFromUrl,
    getCurrentPageSku,
    getPageType,
    isListLikePage
  };
})(window);

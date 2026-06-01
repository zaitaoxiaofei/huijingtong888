(function initOzonErpDataAggregator(global) {
  'use strict';

  if (global.OzonErpDataAggregator) return;

  function pick(source, keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const value = source?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).replace(/\s+/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function addScore(score, amount) {
    return clamp(score + amount, 0, 100);
  }

  function buildLocalDecision(computedInput = {}) {
    const monthlySales = computedInput.monthlySales;
    const monthlyRevenue = computedInput.monthlyRevenueRub;
    const salesDynamics = numberOrNull(computedInput.salesDynamics);
    const adCostRatio = computedInput.adCostRatio;
    const returnCancelRate = computedInput.returnCancelRate;
    const clickRate = computedInput.clickRate;
    const cartRate = computedInput.cartRate;
    const conversionRate = computedInput.conversionRate;
    const stock = computedInput.stock;
    const price = computedInput.price;
    const sellerCount = computedInput.sellerCount;
    const paidPromotionDays = computedInput.paidPromotionDays;
    let score = 50;
    const riskReasons = [];
    const recommendations = [];

    if (monthlySales != null) {
      if (monthlySales >= 300) score = addScore(score, 18);
      else if (monthlySales >= 100) score = addScore(score, 12);
      else if (monthlySales >= 30) score = addScore(score, 6);
      else if (monthlySales < 10) {
        score = addScore(score, -10);
        riskReasons.push('月销量偏低');
      }
    }

    if (monthlyRevenue != null) {
      if (monthlyRevenue >= 500000) score = addScore(score, 10);
      else if (monthlyRevenue >= 100000) score = addScore(score, 6);
    }

    if (salesDynamics != null) {
      if (salesDynamics >= 20) score = addScore(score, 8);
      else if (salesDynamics <= -20) {
        score = addScore(score, -10);
        riskReasons.push('销售趋势下滑');
      }
    }

    if (adCostRatio != null) {
      if (adCostRatio > 20) {
        score = addScore(score, -16);
        riskReasons.push('广告费占比过高');
      } else if (adCostRatio > 10) {
        score = addScore(score, -8);
        riskReasons.push('广告压力偏高');
      } else if (adCostRatio <= 5) {
        score = addScore(score, 6);
      }
    }

    if (returnCancelRate != null) {
      if (returnCancelRate >= 35) {
        score = addScore(score, -18);
        riskReasons.push('退货取消率较高');
      } else if (returnCancelRate >= 20) {
        score = addScore(score, -8);
        riskReasons.push('退货风险需复核');
      } else if (returnCancelRate <= 10) {
        score = addScore(score, 5);
      }
    }

    if (clickRate != null && clickRate >= 8) score = addScore(score, 5);
    if (cartRate != null && cartRate >= 2) score = addScore(score, 5);
    if (conversionRate != null && conversionRate >= 1) score = addScore(score, 5);

    if (stock != null) {
      if (stock <= 0) {
        score = addScore(score, -12);
        riskReasons.push('疑似缺货');
      } else if (stock < 20) {
        riskReasons.push('库存偏低，需观察供给稳定性');
      }
    }

    if (sellerCount != null && sellerCount >= 8) {
      score = addScore(score, -8);
      riskReasons.push('跟卖竞争较多');
    }

    if (paidPromotionDays != null && paidPromotionDays >= 25 && adCostRatio != null && adCostRatio > 10) {
      riskReasons.push('长期付费推广依赖明显');
    }

    if (price != null && price < 200) {
      riskReasons.push('低客单价，需重点测算保本成本');
    }

    if (score >= 78) {
      recommendations.push('建议加入采集箱复核');
      recommendations.push('补齐成本后再进入选品池');
    } else if (score >= 60) {
      recommendations.push('建议加入采集箱观察');
      recommendations.push('重点复核广告、退货和物流成本');
    } else {
      recommendations.push('暂不建议直接上架');
      recommendations.push('先加入监控或寻找同类更优商品');
    }

    const riskLevel = score >= 78
      ? 'low'
      : score >= 60
        ? 'medium'
        : 'high';

    return {
      productScore: Math.round(score),
      riskLevel,
      riskReasons,
      recommendations
    };
  }

  function buildProductIntelligence(input = {}) {
    const row = input.row && typeof input.row === 'object' ? input.row : {};
    const detail = input.detail && typeof input.detail === 'object' ? input.detail : {};
    const cacheData = input.cacheData && typeof input.cacheData === 'object' ? input.cacheData : {};
    const cacheProduct = cacheData.product && typeof cacheData.product === 'object' ? cacheData.product : {};
    const productDetail = detail.productDetail && typeof detail.productDetail === 'object' ? detail.productDetail : {};
    const product = { ...row, ...cacheProduct, ...productDetail };
    const sku = String(input.sku || product.sku || product.product_id || product.productId || '').trim();
    const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
    const mainImage = product.mainImage || product.productImage || product.coverImage || images[0] || '';

    const monthlySales = numberOrNull(pick(product, ['soldCount']));
    const monthlyRevenueRub = numberOrNull(pick(product, ['soldSumRub', 'soldSum', 'gmvSum']));
    const salesDynamics = product.salesDynamics || '';
    const adCostRatio = numberOrNull(pick(product, ['drr']));
    const paidPromotionDays = numberOrNull(pick(product, ['daysWithTrafarets']));
    const clickRate = numberOrNull(pick(product, ['custom_click_rate']));
    const cartRate = numberOrNull(pick(product, ['convToCart', 'pdpToCartConversion', 'convToCartPdp']));
    const conversionRate = numberOrNull(pick(product, ['convViewToOrder']));
    const returnCancelRate = numberOrNull(pick(product, ['nullableRedemptionRate']));
    const stock = numberOrNull(pick(product, ['availableStock', 'available_stock', 'stock']));
    const price = numberOrNull(pick(product, ['cardPrice', 'price', 'productPrice', 'sell_price']));
    const sellerCount = numberOrNull(pick(product, ['sellerCount', 'sellersCount']));
    const localDecision = buildLocalDecision({
      monthlySales,
      monthlyRevenueRub,
      salesDynamics,
      adCostRatio,
      returnCancelRate,
      clickRate,
      cartRate,
      conversionRate,
      stock,
      price,
      sellerCount,
      paidPromotionDays
    });

    return {
      identity: {
        ozonSku: sku,
        url: product.productUrl || product.productLink || global.location?.href || '',
        marketplace: 'ozon',
        pageType: input.pageType || ''
      },
      basic: {
        title: product.productTitle || product.title || product.name || '',
        brand: product.brand || '',
        category: {
          id: product.category_id || product.categoryId || '',
          name: product.category || product.categoryName || ''
        },
        seller: {
          id: product.sellerId || product.seller_id || '',
          name: product.sellerName || product.seller_name || ''
        },
        images: mainImage ? [mainImage, ...images.filter((url) => url !== mainImage)] : images,
        rating: numberOrNull(pick(product, ['rating', 'score'])),
        reviewCount: numberOrNull(pick(product, ['reviewCount', 'reviewsCount', 'commentsCount']))
      },
      price: {
        currentRub: price,
        originalRub: numberOrNull(pick(product, ['originalPrice'])),
        ozonCardRub: numberOrNull(pick(product, ['cardPrice'])),
        currency: product.priceCurrency || product.currency || 'RUB',
        priceHistoryStatus: ''
      },
      sales: {
        monthlySales,
        monthlyRevenueRub,
        dailySales: numberOrNull(pick(product, ['dailySales'])),
        dailyRevenueRub: numberOrNull(pick(product, ['dailyRevenueRub'])),
        salesDynamics
      },
      traffic: {
        cardViews: numberOrNull(pick(product, ['qtyViewPdp'])),
        searchViews: numberOrNull(pick(product, ['sessionCountSearch'])),
        clickRate,
        cartRate,
        searchCartRate: numberOrNull(pick(product, ['convToCartSearch'])),
        conversionRate
      },
      ads: {
        adCostRatio,
        paidPromotionDays,
        promoDays: numberOrNull(pick(product, ['daysInPromo'])),
        promoDiscount: numberOrNull(pick(product, ['discount'])),
        promoRevenueShare: numberOrNull(pick(product, ['promoRevenueShare']))
      },
      logistics: {
        salesSchema: product.salesSchema || product.sales_schema || '',
        lengthMm: numberOrNull(pick(product, ['lengthMm', 'depth'])),
        widthMm: numberOrNull(pick(product, ['widthMm', 'width'])),
        heightMm: numberOrNull(pick(product, ['heightMm', 'height'])),
        weightG: numberOrNull(pick(product, ['weight_g', 'custom_weight'])),
        returnCancelRate
      },
      competition: {
        sellerCount,
        minPriceRub: numberOrNull(pick(product, ['minPrice', 'min_price'])),
        maxPriceRub: numberOrNull(pick(product, ['maxPrice', 'max_price'])),
        buyboxSeller: product.buyboxSeller || '',
        hasOzonSeller: Boolean(product.hasOzonSeller),
        competitorList: Array.isArray(product.competitorList) ? product.competitorList : []
      },
      erp: {
        isCollected: cacheData.found === true || row.erpLookup?.status === 'fresh',
        isInSelectionPool: Boolean(product.isInSelectionPool),
        hasListingDraft: Boolean(product.hasListingDraft),
        isWatched: Boolean(input.isWatched || product.isWatched),
        localSku: product.localSku || '',
        selectionStatus: product.selectionStatus || '',
        ownerUserId: product.ownerUserId || ''
      },
      computed: {
        productScore: product.productScore ?? localDecision.productScore,
        profitEstimate: product.profitEstimate || null,
        riskLevel: product.riskLevel || localDecision.riskLevel,
        riskReasons: Array.isArray(product.riskReasons) && product.riskReasons.length > 0 ? product.riskReasons : localDecision.riskReasons,
        recommendations: Array.isArray(product.recommendations) && product.recommendations.length > 0 ? product.recommendations : localDecision.recommendations
      },
      sourceStatus: {
        ozonEntrypointStatus: productDetail ? 'ok' : 'empty',
        sellerBridgeStatus: detail.sellerFallback?.success === false ? 'error' : detail.sellerFallback ? 'ok' : 'empty',
        erpStatus: cacheData.found === true ? 'ok' : row.erpLookup?.status || 'pending',
        lastFetchedAt: new Date().toISOString(),
        errors: [detail.sellerFallback?.error, cacheData.message, row.erpLookup?.message].filter(Boolean)
      }
    };
  }

  global.OzonErpDataAggregator = {
    buildProductIntelligence
  };
})(window);

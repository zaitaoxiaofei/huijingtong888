(function initOzonErpFieldRegistry(global) {
  'use strict';

  if (global.OzonErpFieldRegistry) return;

  const DETAIL_CARD_FIELDS = [
    { key: 'category', group: '基础', label: '类目', paths: ['category'], wide: true, tone: 'base' },
    { key: 'brand', group: '基础', label: '品牌', paths: ['brand'], tone: 'base' },
    { key: 'sales_schema', group: '基础', label: '发货模式', paths: ['salesSchema'], resolver: 'salesSchema', tone: 'base' },
    { key: 'created_at', group: '基础', label: '上架时间', resolver: 'createdAt', tone: 'base' },
    { key: 'create_age_days', group: '基础', label: '天数', resolver: 'createAgeDays', tone: 'base', optional: true },
    { key: 'sku', group: '基础', label: 'SKU', resolver: 'sku', copy: true, tone: 'base', optional: true },
    { key: 'seller_name', group: '基础', label: '卖家', paths: ['sellerName'], tone: 'base', optional: true },

    { key: 'ozon_card_price', group: '核心概览', label: 'Ozon卡价', resolver: 'cardPrice', tone: 'money' },
    { key: 'monthly_sales', group: '核心概览', label: '月销量', paths: ['soldCount'], tone: 'sales' },
    { key: 'monthly_revenue', group: '核心概览', label: '月销售额', resolver: 'monthlyRevenue', tone: 'sales' },
    { key: 'sales_rank', group: '核心概览', label: '销售排名', paths: ['bin'], tone: 'sales', optional: true },
    { key: 'web_price', group: '保本测算', label: '当前售价(RMB)', resolver: 'cardPriceCny', tone: 'money' },
    { key: 'breakeven_cost_limit', group: '保本测算', label: '保本成本上限(RMB)', resolver: 'breakevenCostLimit', tone: 'money', optional: true },
    { key: 'suggested_purchase_cost', group: '保本测算', label: '建议采购成本(RMB)', resolver: 'suggestedPurchaseCost', tone: 'money', optional: true },
    { key: 'fee_completeness', group: '保本测算', label: '费用完整度', resolver: 'feeCompleteness', tone: 'base', optional: true },
    { key: 'estimated_international_freight', group: '保本测算', label: '国际运费估算', resolver: 'estimatedInternationalFreight', tone: 'money', optional: true },
    { key: 'rfbs_commission', group: '保本测算', label: 'rFBS佣金', resolver: 'commission:rfbs', tone: 'money', optional: true },
    { key: 'fbs_commission', group: '保本测算', label: 'FBS佣金', resolver: 'commission:fbs', tone: 'money', optional: true },
    { key: 'fbo_commission', group: '保本测算', label: 'FBO佣金', resolver: 'commission:fbo', tone: 'money', optional: true },
    { key: 'original_price', group: '保本测算', label: '划线价', resolver: 'originalPrice', tone: 'money', optional: true },
    { key: 'currency', group: '保本测算', label: '币种', paths: ['priceCurrency', 'currency'], tone: 'money', optional: true },
    { key: 'sales_dynamics', group: '核心概览', label: '月周转动态', paths: ['salesDynamics'], tone: 'sales', optional: true },
    { key: 'price_index', group: '保本测算', label: '价格指数', paths: ['priceIndex', 'price_index'], tone: 'money', optional: true },

    { key: 'session_count', group: '流量转化', label: '会话数', paths: ['sessionCount'], tone: 'traffic', optional: true },
    { key: 'card_views', group: '流量转化', label: '商品卡浏览量', paths: ['qtyViewPdp'], tone: 'traffic' },
    { key: 'total_views', group: '流量转化', label: '总浏览量', paths: ['views', 'hitsView', 'hits_view'], tone: 'traffic' },
    { key: 'click_rate', group: '流量转化', label: '商品点击率', resolver: 'percent:custom_click_rate', tone: 'orange' },
    { key: 'cart_rate', group: '流量转化', label: '加购率', resolver: 'percent:convToCart', tone: 'traffic', optional: true },
    { key: 'pdp_cart_rate', group: '流量转化', label: 'PDP加购率', resolver: 'percent:pdpToCartConversion,convToCartPdp', tone: 'traffic' },
    { key: 'view_conversion_rate', group: '流量转化', label: '成交转化率', resolver: 'percent:convViewToOrder', tone: 'traffic' },
    { key: 'funnel_judgement', group: '流量转化', label: '漏斗判断', resolver: 'funnelJudgement', tone: 'base', optional: true, wide: true },
    { key: 'search_views', group: '流量转化', label: '搜索目录浏览量', paths: ['sessionCountSearch'], tone: 'traffic' },
    { key: 'search_cart_rate', group: '流量转化', label: '搜索目录加购率', resolver: 'percent:convToCartSearch', tone: 'traffic' },

    { key: 'promo_dependency', group: '推广依赖', label: '推广类型', resolver: 'promoDependency', tone: 'promo', optional: true },
    { key: 'ad_cost_ratio', group: '推广依赖', label: '广告费占比', resolver: 'percent:drr', tone: 'promo' },
    { key: 'promo_revenue_share', group: '推广依赖', label: '促销销售占比', resolver: 'percent:promoRevenueShare', tone: 'promo', optional: true },
    { key: 'paid_promotion_days', group: '推广依赖', label: '付费推广天数', paths: ['daysWithTrafarets'], tone: 'promo' },
    { key: 'promo_days', group: '推广依赖', label: '促销天数', paths: ['daysInPromo'], tone: 'promo' },
    { key: 'promo_discount', group: '推广依赖', label: '促销折扣', resolver: 'percent:discount', tone: 'promo', optional: true },

    { key: 'dimensions', group: '库存物流', label: '长 宽 高', resolver: 'unit:custom_volume,real_dimensions:mm', tone: 'logistics' },
    { key: 'weight', group: '库存物流', label: '重量', resolver: 'unit:custom_weight,weight_g:g', tone: 'logistics' },
    { key: 'volume', group: '库存物流', label: '体积', paths: ['volume'], tone: 'logistics', optional: true },
    { key: 'stock', group: '库存物流', label: '库存', paths: ['availableStock', 'available_stock', 'stock'], tone: 'logistics' },
    { key: 'accessibility', group: '库存物流', label: '可购率', resolver: 'percent:accessibility', tone: 'logistics', optional: true },
    { key: 'accessibility_days', group: '库存物流', label: '可购天数', paths: ['accessibilityByDays'], tone: 'logistics', optional: true },
    { key: 'return_cancel_rate', group: '库存物流', label: '退货率', resolver: 'percent:nullableRedemptionRate', tone: 'red' },

    { key: 'product_score', group: '智能判断', label: '选品评分', resolver: 'intelligence:computed.productScore', tone: 'score', optional: true },
    { key: 'risk_level', group: '智能判断', label: '风险等级', resolver: 'riskLevel', tone: 'risk', optional: true },
    { key: 'risk_reasons', group: '智能判断', label: '风险原因', resolver: 'intelligenceList:computed.riskReasons', tone: 'risk', optional: true, wide: true },
    { key: 'recommendations', group: '智能判断', label: '建议动作', resolver: 'intelligenceList:computed.recommendations', tone: 'score', optional: true, wide: true }
  ];

  const DEFAULT_DETAIL_CARD_VISIBLE_KEYS = [
    'ozon_card_price',
    'monthly_sales',
    'monthly_revenue',
    'sales_rank',
    'risk_level',
    'category',
    'brand',
    'sales_schema',
    'created_at',
    'create_age_days',
    'web_price',
    'breakeven_cost_limit',
    'suggested_purchase_cost',
    'fee_completeness',
    'estimated_international_freight',
    'rfbs_commission',
    'total_views',
    'card_views',
    'click_rate',
    'cart_rate',
    'view_conversion_rate',
    'funnel_judgement',
    'promo_dependency',
    'ad_cost_ratio',
    'promo_revenue_share',
    'stock',
    'accessibility_days',
    'return_cancel_rate',
    'dimensions',
    'weight'
  ];

  function getDetailCardFields() {
    return DETAIL_CARD_FIELDS.map((field) => ({ ...field }));
  }

  function getDefaultDetailCardVisibleKeys() {
    return DEFAULT_DETAIL_CARD_VISIBLE_KEYS.slice();
  }

  global.OzonErpFieldRegistry = {
    getDetailCardFields,
    getDefaultDetailCardVisibleKeys
  };
})(window);

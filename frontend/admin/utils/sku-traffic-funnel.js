// These are same-period count ratios, not user cohorts or advertising attribution.
export function trafficFunnelMetrics(source={}){
 const value=key=>source.available===false||source[key]===null||source[key]===undefined||!Number.isFinite(Number(source[key]))?null:Number(source[key]);
 const total=value('total_views'),search=value('search_views'),visits=value('pdp_views'),carts=value('total_hits_to_cart'),orders=value('ordered_units');
 return {...source,other_views:total!==null&&search!==null&&total>=search?total-search:null,
  pdp_cart_rate:visits!==null&&visits>0&&carts!==null?carts/visits*100:null,
  cart_order_rate:carts!==null&&carts>0&&orders!==null?orders/carts*100:null};
}
export const TRAFFIC_FUNNEL_HELP={
 total_views:'所选区间的总展示次数。',
 search_views:'搜索及目录中的曝光次数。',
 other_views:'总曝光 − 搜索/目录曝光，按当前口径也包含详情页访问等其他展示。不能据此区分自然流量和广告流量；任一数据缺失或差值为负时不计算。',
 pdp_views:'按 Ozon 商品详情页访问次数展示“点击”，不是广告点击数，也不是去重人数。',
 detail_view_rate:'点击次数 ÷ 总曝光。此处为点击率，不是广告 CTR。',
 total_hits_to_cart:'全部入口的加购总次数，包含从搜索等入口直接加购。',
 pdp_cart_rate:'总加购次数 ÷ 点击次数。属于次数比，可能超过100%；不是只统计点击后的加购转化率。',
 ordered_units:'按下单商品件数追踪，不是订单笔数，也不等于最终成交或签收件数。',
 pdp_order_rate:'下单件数 ÷ 点击次数，按件数与访问次数计算。',
 cart_order_rate:'下单件数 ÷ 总加购次数，按件数与加购次数计算。',
 search_share:'搜索/目录曝光 ÷ 总曝光。'
};

export const TRAFFIC_FUNNEL_STAGES=[
 {key:'total_views',title:'曝光',unit:'次',query:'exposure_trend',defaultMetric:'total_views',color:'#4c9bff',options:['total_views','search_views','other_views','search_share'],items:[['search_views','搜索曝光','count'],['other_views','其他曝光','count'],['search_share','搜索占比','rate']]},
 {key:'pdp_views',title:'点击',unit:'次',query:'click_trend',defaultMetric:'detail_view_rate',color:'#27b99c',options:['pdp_views','detail_view_rate','total_hits_to_cart','pdp_cart_rate'],items:[['detail_view_rate','点击率','rate'],['total_hits_to_cart','加购次数','count'],['pdp_cart_rate','加购率','rate']]},
 {key:'ordered_units',title:'下单',unit:'件',query:'order_trend',defaultMetric:'pdp_order_rate',color:'#eeb44c',options:['ordered_units','pdp_order_rate','cart_order_rate'],items:[['pdp_order_rate','下单率','rate'],['cart_order_rate','加购转化率','rate']]}
];

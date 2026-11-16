import {trafficDate,shiftTrafficDate} from '../../../src/shared/sku-traffic-daily.js';
export function dailyCollectionContext(query={}) {
 const shopId=String(query.shop_id||''),date=trafficDate(query.date);
 if(query.traffic_daily!=='1'||! /^[1-9]\d*$/.test(shopId)||!date)return null;
 const rangeDays=Number(query.traffic_range_days);
 return [1,7,15,30].includes(rangeDays)?{shopId,date,rangeDays,from:shiftTrafficDate(date,1-rangeDays)}:{shopId,date};
}
export function monitorReturnQuery(query={}) {
 const result={};
 for(const key of ['shops','query','search_by','range_days','sort_key','sort_order','view','tag','tags','group_by','date','exact','filters','page','pageSize','scroll_top','trend_metric','exposure_trend','click_trend','order_trend']){
  const value=query['monitor_'+key];if(typeof value==='string'&&value.length<=4096)result[key]=value;
 }
 return result;
}
export function dailyCollectionRoute(shopId,date,monitor={}) {
 return {name:'seller-analytics',query:{traffic_daily:'1',shop_id:String(shopId),date,...Object.fromEntries(Object.entries(monitor).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>['monitor_'+k,String(v)]))}};
}
export function supportsTrafficPartitions(version,unified=true){
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(version||''));if(!match)return false;
 const parts=match.slice(1).map(Number),minimum=unified?[1,5,7]:[1,0,47];
 for(let i=0;i<3;i++){if(parts[i]!==minimum[i])return parts[i]>minimum[i];}return true;
}

export function monitorContextQuery(monitor={}) {
 return Object.fromEntries(Object.entries(monitor).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>['monitor_'+key,String(value)]));
}
export function intervalCollectionRoute(shopId,date,rangeDays,monitor={}) {
 const route=dailyCollectionRoute(shopId,date,monitor);
 route.query.traffic_range_days=String(rangeDays);
 route.query.traffic_auto='1';
 return route;
}
export function preferredMonitorShops(shops,saved) {
 const valid=(Array.isArray(saved)?saved:[]).map(String).filter(id=>shops.some(shop=>String(shop.id)===id));
 if(valid.length)return valid;
 const main=shops.find(shop=>/^(ruvibe|reviver|reviber) mart$/i.test(shop.name?.trim()))||shops.find(shop=>/主店/.test(shop.name))||shops[0];
 return main?[String(main.id)]:[];
}
export function monitorPreferenceKey(tenantId) {
 return `sku-traffic-monitor.${String(tenantId||'unknown').replace(/[^a-zA-Z0-9_-]/g,'')}`;
}

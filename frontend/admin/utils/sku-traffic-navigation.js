import {trafficDate} from '../../../src/shared/sku-traffic-daily.js';
export function dailyCollectionContext(query={}) {
 const shopId=String(query.shop_id||''),date=trafficDate(query.date);
 return query.traffic_daily==='1'&&/^[1-9]\d*$/.test(shopId)&&date?{shopId,date}:null;
}
export function monitorReturnQuery(query={}) {
 const result={};
 for(const key of ['shops','query','search_by','range_days','sort_key','sort_order','view','tag','group_by','date','exact','filters','page','pageSize']){
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

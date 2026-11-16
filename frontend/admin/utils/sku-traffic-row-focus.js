// The list compares adjacent calendar days, never silently bridges missing dates.
export const TRAFFIC_FOCUS_METRICS=[
 {key:'total_views',label:'总曝光',unit:'',rate:false},
 {key:'pdp_views',label:'点击',unit:'',rate:false},
 {key:'ordered_units',label:'下单件数',unit:'',rate:false},
 {key:'other_views',label:'其他曝光',unit:'',rate:false},
 {key:'search_views',label:'搜索曝光',unit:'',rate:false},
 {key:'total_hits_to_cart',label:'加购次数',unit:'',rate:false},
 {key:'search_share',label:'搜索曝光占比',unit:'%',rate:true},
 {key:'detail_view_rate',label:'点击率',unit:'%',rate:true},
 {key:'pdp_cart_rate',label:'加购率',unit:'%',rate:true},
 {key:'cart_order_rate',label:'加购转化率',unit:'%',rate:true},
 {key:'pdp_order_rate',label:'下单率',unit:'%',rate:true}
];
export function trafficRowFocus(series,key){
 const metric=TRAFFIC_FOCUS_METRICS.find(item=>item.key===key)||TRAFFIC_FOCUS_METRICS[0];
 const last=series?.at(-1),previous=series?.at(-2);
 const value=day=>day?.available&&day[metric.key]!==null&&day[metric.key]!==undefined&&Number.isFinite(Number(day[metric.key]))?Number(day[metric.key]):null;
 const current=value(last),before=value(previous);
 const adjacent=last&&previous&&Date.parse(last.date_key+'T00:00:00Z')-Date.parse(previous.date_key+'T00:00:00Z')===86400000;
 let comparison=null;
 if(adjacent&&current!==null&&before!==null){
  const change=current-before;
  comparison={direction:change>0?'up':change<0?'down':'flat',change,
   value:metric.rate?change:before===0?change:change/before*100,
   unit:metric.rate?'个百分点':before===0?'':'%',
   from:previous.date_key,to:last.date_key};
 }
 return {date:last?.date_key||'',available:!!last?.available,value:current,comparison};
}

export function trafficComparisonText(change){
 if(!change)return '';
 if(change.direction==='flat')return '与前日持平';
 const digits=change.unit==='个百分点'?2:1,magnitude=Math.abs(change.value),minimum=10**-digits;
 const value=magnitude<minimum?`<${minimum}`:magnitude.toLocaleString(undefined,{maximumFractionDigits:digits});
 return `较前日 ${change.direction==='up'?'↑':'↓'} ${value}${change.unit}`;
}

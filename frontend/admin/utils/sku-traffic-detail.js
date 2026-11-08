export function dailyMetricChange(series, key) {
 const observed=series.filter(day=>day.available&&day[key]!==null&&day[key]!==undefined&&Number.isFinite(Number(day[key])));
 if(observed.length<2)return null;
 const first=observed[0],last=observed.at(-1),change=Number(last[key])-Number(first[key]);
 return {from:first.date_key,to:last.date_key,first:Number(first[key]),last:Number(last[key]),change,percent:Number(first[key])===0?null:change/Number(first[key])*100};
}

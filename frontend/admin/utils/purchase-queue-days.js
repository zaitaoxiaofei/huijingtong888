import {shanghaiDateKey} from './shanghai-date.js';

export function purchaseQueueDays(days, {status='open', selectedDay='', startDate='', endDate='', now=new Date()}={}) {
  const indexed=new Map((days||[]).map(day=>[day.date,day]));
  const today=shanghaiDateKey(now);
  const anchor=new Date(`${today}T00:00:00+08:00`);
  for(let offset=0;offset<7;offset++){
    const date=shanghaiDateKey(new Date(anchor.getTime()-offset*86400000));
    if((!startDate||date>=startDate)&&(!endDate||date<=endDate)&&!indexed.has(date))indexed.set(date,{date});
  }
  if(/^\d{4}-\d{2}-\d{2}$/.test(selectedDay)&&!indexed.has(selectedDay))indexed.set(selectedDay,{date:selectedDay});
  return [...indexed.values()].sort((a,b)=>b.date.localeCompare(a.date)).map(day=>({...day,count:Number(day[status]||0)}));
}

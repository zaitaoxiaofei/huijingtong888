import {shanghaiDateKey} from './shanghai-date.js';

export function purchaseQueueDayAge(date, now=new Date()) {
  const today=shanghaiDateKey(now);
  return Math.floor((Date.parse(`${today}T00:00:00+08:00`)-Date.parse(`${date}T00:00:00+08:00`))/86400000);
}

export function purchaseQueueBadgeTone(count, overdue=false) {
  return count<=0?'empty':overdue?'overdue':'recent';
}

export function purchaseQueueDays(days, {status='open', startDate='', endDate='', now=new Date()}={}) {
  return (days||[]).filter(day=>Number(day[status])>0&&(!startDate||day.date>=startDate)&&(!endDate||day.date<=endDate))
    .sort((a,b)=>a.date.localeCompare(b.date))
    .map(day=>{const [year,month,date]=day.date.split('-');return {...day,count:Number(day[status]),ageDays:purchaseQueueDayAge(day.date,now),monthLabel:`${year}年${Number(month)}月`,dayLabel:`${Number(date)}号`};});
}

export function purchaseQueueDayGroups(days) {
  const groups=new Map();
  for(const day of days){
    const month=day.date.substring(0,7);
    if(!groups.has(month))groups.set(month,{month,monthLabel:day.monthLabel,days:[]});
    groups.get(month).days.push(day);
  }
  return [...groups.values()];
}

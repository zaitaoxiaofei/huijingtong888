import { shanghaiDateKey } from '../shanghai-time.js';

function invalid(message) { throw Object.assign(new Error(message), {status:400,statusCode:400,code:'OGL_OFFICIAL_DATE_INVALID'}); }
export function oglBeijingDay(value) {
  const day=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||shanghaiDateKey(`${day}T00:00:00+08:00`)!==day)invalid('请选择有效的北京日期（YYYY-MM-DD）');
  return day;
}
export function oglOfficialDateRange(query={},now=new Date()) {
  const single=query.date??query.departure_date;
  const end=oglBeijingDay(query.date_to||query.dateTo||single||shanghaiDateKey(now));
  const start=oglBeijingDay(query.date_from||query.dateFrom||single||shanghaiDateKey(new Date(Date.parse(`${end}T00:00:00+08:00`)-6*86400000)));
  const days=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
  if(days<1||days>31)invalid('请选择起止顺序正确且不超过 31 天的北京日期范围');
  return {date_from:start,date_to:end,days:Array.from({length:days},(_value,index)=>shanghaiDateKey(new Date(Date.parse(`${start}T00:00:00+08:00`)+index*86400000)))};
}
export function oglOfficialCreatedAt(value) {
  const text=String(value||'').trim();
  // A calendar date has no known clock time. Never invent midnight for it.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)&&Number.isFinite(Date.parse(text))?text:null;
}

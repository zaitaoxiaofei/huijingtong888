const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&!Number.isNaN(Date.parse(value))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
export function billingCalendarRange(year,month='') {
 const y=String(year),m=Number(month);
 if(!/^20\d{2}$/.test(y))throw new Error('请选择有效年份');
 if(month===''||month==null)return [`${y}-01-01`,`${y}-12-31`];
 if(!Number.isInteger(m)||m<1||m>12)throw new Error('请选择有效月份');
 const key=`${y}-${String(m).padStart(2,'0')}`;
 return [`${key}-01`,`${key}-${new Date(Date.UTC(Number(y),m,0)).getUTCDate()}`];
}
// Explicit dates take precedence; a year alone means the whole year.
export function billingDateRange(query={},today) {
 if(validDate(query.from)&&validDate(query.to)&&query.from<=query.to)return [String(query.from),String(query.to)];
 const hasYear=/^20\d{2}$/.test(String(query.year||'')),year=hasYear?String(query.year):today.slice(0,4);
 const requested=query.month||query.selectedMonth;
 if(hasYear&&!requested)return billingCalendarRange(year);
 const month=Number(requested||today.slice(5,7));
 return billingCalendarRange(year,Number.isInteger(month)&&month>=1&&month<=12?month:Number(today.slice(5,7)));
}
export function billingCalendarSelection(range) {
 const [from,to]=range||[];
 if(!validDate(from)||!validDate(to)||from>to)return {year:'',month:''};
 const year=from.slice(0,4);
 if(billingCalendarRange(year).join()===range.join())return {year,month:''};
 const month=String(Number(from.slice(5,7)));
 if(billingCalendarRange(year,month).join()===range.join())return {year,month};
 return {year:'',month:''};
}

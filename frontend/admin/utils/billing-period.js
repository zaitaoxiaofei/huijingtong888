// Route month changes must work when the billing page is kept alive in a tab.
export function billingDateRange(query = {}, today) {
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&!Number.isNaN(Date.parse(value))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  if(validDate(query.from)&&validDate(query.to)&&query.from<=query.to)return [String(query.from),String(query.to)];
  const year=/^\d{4}$/.test(String(query.year||''))?String(query.year):today.slice(0,4);
  const requested=Number(query.month||query.selectedMonth||today.slice(5,7));
  const month=Number.isInteger(requested)&&requested>=1&&requested<=12?requested:Number(today.slice(5,7));
  const key=`${year}-${String(month).padStart(2,'0')}`;
  const last=new Date(Date.UTC(Number(year),month,0)).getUTCDate();
  return [`${key}-01`,key===today.slice(0,7)?today:`${key}-${last}`];
}

// Only provider transaction IDs identify a transaction. Equal dates/amounts do not.
export function deduplicateFinanceCash(rows){
 const cash=[],duplicates=[],conflicts=[],seen=new Map();
 const fields=['date','currency','amount','fee','listed_bank_currency','listed_bank_amount'];
 for(const row of rows){
  const ref=String(row.reference||'').trim();
  if(!['entry','withdrawal'].includes(row.type)||!ref||['—','-','undefined','null'].includes(ref)){cash.push({...row,sources:[row]});continue;}
  const key=`${row.type}:${row.currency}:${ref}`;
  const old=seen.get(key);if(!old){const item={...row,sources:[row]};seen.set(key,item);cash.push(item);continue;}
  old.sources.push(row);
  if(fields.some(f=>old[f]!=null&&row[f]!=null&&String(old[f])!==String(row[f]))){conflicts.push({key,reference:ref,sources:old.sources,note:'同交易号的日期、金额或手续费冲突，请核对原件；该币种合计未核定'});continue;}
  for(const f of fields)if(old[f]==null&&row[f]!=null)old[f]=row[f];
  duplicates.push({key,reference:ref,sources:[old.sources[0],row]});
 }
 return {cash,duplicates,conflicts};
}

// Index only the already authorized snapshot; preserve the original query row
// order, duplicate-ID handling and child/parent matching semantics.
export function billingEvidenceIndex({financeRows,siblings,archives}) {
 const finance=new Map(),parents=new Map(),fx=new Map();
 const add=(map,key,row,index)=>{const rows=map.get(key)||[];rows.push({row,index});map.set(key,rows);};
 const key=(shop,value)=>JSON.stringify([Number(shop),String(value)]);
 financeRows.forEach((row,index)=>add(finance,key(row.shop_id,row.posting_number),row,index));
 siblings.forEach((row,index)=>{
  const keys=new Set([row.order_number]);const parts=String(row.posting_number).split('-');
  for(let i=1;i<parts.length;i++)keys.add(parts.slice(0,i).join('-'));
  for(const parent of keys)if(parent!=null)add(parents,key(row.shop_id,parent),row,index);
 });
 archives.forEach((row,index)=>add(fx,String(row.id),row,index));
 const collect=(map,keys)=>[...new Map(keys.flatMap(k=>map.get(k)||[]).map(entry=>[entry.index,entry])).values()].sort((a,b)=>a.index-b.index).map(entry=>entry.row);
 return {finance:(shop,numbers)=>collect(finance,[...new Set(numbers)].map(number=>key(shop,number))),siblings:(shop,parent)=>(parents.get(key(shop,parent))||[]).map(entry=>entry.row),archives:ids=>collect(fx,ids.map(String))};
}

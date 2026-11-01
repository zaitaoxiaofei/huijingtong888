const validId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
export function orderSelectionSummary(selected,pageRows=[]){
 const ids=new Set([...selected].map(Number).filter(validId)),page=new Set(pageRows.map(row=>Number(row.id)));
 const current=[...ids].filter(id=>page.has(id)).length;
 return{total:ids.size,current,other:ids.size-current};
}
export function orderPrintPlan(rows,pageIds=[],includePrinted=false){
 const current=new Set(pageIds.map(Number)),seen=new Set(),orders=[];
 for(const row of rows){const id=Number(row.id);if(!validId(id)||seen.has(id))continue;seen.add(id);
  const printed=Boolean(row.printed_at||row.label_printed_at||row.shipping_label_printed_at||row.printedState||row.isPrinted);
  const eligible=row.availableActions?.print===true;
  orders.push({...row,id,printed,onPage:current.has(id),included:eligible&&(!printed||includePrinted),eligible});
 }
 return{orders,ids:orders.filter(row=>row.included).map(row=>row.id),printed:orders.filter(row=>row.printed).length,excluded:orders.filter(row=>!row.eligible).length,...orderSelectionSummary(new Set(orders.map(row=>row.id)),pageIds.map(id=>({id})))};
}
export function removePrintedSelection(selected,result){
 if(result?.printed!==true||result?.failed)return new Set(selected);
 const failed=new Set((result.failures||[]).map(row=>Number(row.order_id??row.id)));
 const printed=new Set((result.printed_ids||[]).map(Number).filter(id=>validId(id)&&!failed.has(id)));
 return new Set([...selected].filter(id=>!printed.has(Number(id))));
}

export function currentPagePreparePlan(rows=[]){
 const eligible=rows.filter(row=>row.availableActions?.prepare===true&&!row.availableActions?.showSplitPrepare);
 return{ids:[...new Set(eligible.map(row=>Number(row.id)).filter(validId))],skipped:rows.length-eligible.length};
}

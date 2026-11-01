// Call only with a successful, complete /v4/product/info/stocks response.
// A returned, classified FBS/RFBS-only SKU explicitly has no FBP row; an omitted
// SKU, unknown warehouse type or failed/cached response proves nothing.
export function confirmedFbpZeroSnapshots(rows=[]){
 const groups=new Map();
 for(const row of rows){const sku=String(row.ozon_sku||'');if(!/^[1-9]\d*$/.test(sku))continue;if(!groups.has(sku))groups.set(sku,[]);groups.get(sku).push(row);}
 return [...groups.values()].filter(group=>group.every(row=>row.stock_type==='fbs_virtual')).map(group=>({
  ozon_sku:String(group[0].ozon_sku),ozon_product_id:String(group[0].ozon_product_id||''),offer_id:String(group[0].offer_id||''),
  warehouse_id:'flow-confirmed-zero',warehouse_name:'FBP',stock_type:'fbp_real',present:0,available:0,reserved:0,
  raw_json:JSON.stringify({source:'v4/product/info/stocks',confirmed_absent_type:'fbp_real',observed_type:'fbs_virtual'})
 }));
}

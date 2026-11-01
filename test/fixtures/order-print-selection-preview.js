import {startPagedWorkspacePreview} from './paged-workspace-preview.js';
import {PDFDocument} from 'pdf-lib';
export async function startOrderPrintSelectionPreview(){
 const calls=[],printed=new Set([2]),pdf=await PDFDocument.create();pdf.addPage([100,150]);const bytes=await pdf.save();
 const orders=Array.from({length:40},(_,i)=>({id:i+1,posting_number:'PRINT-ORDER-'+(i+1),shop_id:1,shop_name:'验证店铺',status:'awaiting_deliver',ordered_at:'2026-11-01T01:00:00Z',revenue:50,item_count:1,product_names:'验证订单商品',skus:'SKU-'+i,sku_quantities:'SKU-'+i+':1',fulfillment_type_key:'fbs',fulfillment_type_label:'FBS',logistics_carrier_label:'OGL'}));
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){const page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('pageSize')||20);send({rows:orders.slice((page-1)*size,page*size).map(row=>({...row,printed_at:printed.has(row.id)?'2026-11-01 01:00:00':null})),total:40,page,pageSize:size,counts:{all:40,awaiting_deliver:40}});return true;}
  if(['/api/orders/package-label','/api/orders/package-label-printed','/api/orders/package-label-print-failed'].includes(url.pathname)){
   let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const data=JSON.parse(body||'{}');calls.push({path:url.pathname,body:data});
    if(url.pathname.endsWith('/package-label')){res.setHeader('Content-Type','application/pdf');res.setHeader('X-Ozon-Label-Printed-Ids',encodeURIComponent(JSON.stringify(data.order_ids)));return res.end(Buffer.from(bytes));}
    if(url.pathname.endsWith('/package-label-printed')){for(const id of data.order_ids)printed.add(Number(id));return send({ok:true,print_batch_id:'test-batch'});}
    printed.delete(1);send({ok:true});
   });return true;
  }
  return false;
 }});return{server,calls};
}

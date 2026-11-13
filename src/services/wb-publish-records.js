import {wbListingVariants} from '../shared/wb-listing-variants.js';
import {findWbCard} from './wb-find-card.js';
import {saveWbProductCard,wbProductView} from './wb-product-workspace.js';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const id=value=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<=0)throw fail('请选择有效的 WB 上架记录。',400);return number;};
const nonempty=value=>Array.isArray(value)?value.length>0:value!==null&&value!==undefined&&String(value).trim()!=='';
const numeric=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;

export function wbListingCompleteness(row,payload={}){
 const card=row.card||{},sizes=card.sizes||[],dimensions=card.dimensions||{};
 const checks=[nonempty(card.title)&&String(card.title).length<=60,nonempty(card.vendorCode)&&String(card.vendorCode).length<=72,
  Array.isArray(row.images)&&row.images.length>0,
  ...['length','width','height','weightBrutto'].map(key=>Number(dimensions[key])>0),
  sizes.length>0&&sizes.every(size=>Number.isInteger(Number(size.price))&&Number(size.price)>0),
  sizes.length>0&&sizes.every(size=>nonempty(size.skus))];
 for(const attribute of payload.attributes_schema||[])if(attribute.required&&!attribute.existNamedField&&Number(attribute.charcType)!==0)checks.push(nonempty(card.characteristics?.find(value=>Number(value.id)===Number(attribute.charcID))?.value));
 return Math.round(checks.filter(Boolean).length/checks.length*100);
}

export function wbPublishRecordView(job,cards=[]){
 const payload=parse(job.payload_json||job.payload),state=parse(job.state_json||job.state),variants=wbListingVariants(payload);
 const products=variants.map((variant,index)=>{
  const item=(state.items||[]).find(value=>value.vendor_code===variant.card?.vendorCode)||(state.items||[])[index]||{};
  const matches=cards.filter(row=>Number(row.shop_id)===Number(job.shop_id)&&(item.nm_id?Number(row.nm_id)===Number(item.nm_id):row.vendor_code===variant.card?.vendorCode));
  const online=matches.length===1?wbProductView(matches[0]):null,card=online?.card,price=online?.price_info;
  const images=card?.photos?.map(photo=>photo.big||photo.c516x688).filter(Boolean)||variant.images||[];
  const onlinePrices=(price?.sizes||[]).map(size=>numeric(size.price)).filter(value=>value!==null),submittedPrices=(variant.card?.sizes||[]).map(size=>numeric(size.price)).filter(value=>value!==null);
  const hasOnlinePrice=onlinePrices.length>0,prices=hasOnlinePrice?onlinePrices:submittedPrices;
  return {title:card?.title||variant.card?.title||'',vendor_code:variant.card?.vendorCode||'',images,nm_id:card?.nmID||item.nm_id||null,
   barcodes:card?(card.sizes||[]).flatMap(size=>size.skus||[]):[],sizes:card?.sizes||[],
   price:prices[0]??null,prices,price_source:hasOnlinePrice?'online':'submitted',price_partial:hasOnlinePrice&&onlinePrices.length<(card?.sizes?.length||0),currency:hasOnlinePrice?price.currency:payload.currency||'CNY',
   online_status:online?.online_status||'not_synced',score:wbListingCompleteness(variant,payload),score_source:'erp_completeness',score_label:'ERP资料完整度',
   published_at:online?.published_at||null,synced_at:online?.synced_at||null};
 });
 return {...job,payload,state,payload_json:undefined,state_json:undefined,lease_token:undefined,lease_until:undefined,products,
  category_name:job.category_name||payload.template_name||'',publisher_name:job.publisher_name||'',published_at:job.created_at,
  score:products.length?Math.min(...products.map(product=>product.score)):null,score_source:'erp_completeness',score_label:'ERP资料完整度'};
}

export function createWbPublishRecords({query,request,account,refreshProductSnapshots}){
 const select=`SELECT j.*,s.name AS shop_name,p.name AS publisher_name,t.category_name FROM wb_publish_jobs j
  JOIN shops s ON s.id=j.shop_id AND s.tenant_id=j.tenant_id AND s.platform='wb'
  LEFT JOIN people p ON p.id=j.person_id
  LEFT JOIN wb_listing_templates t ON t.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload_json,'$.template_id')) AS UNSIGNED) AND t.tenant_id=j.tenant_id`;
 async function owned(tenantId,jobId){const [job]=await query(`${select} WHERE j.id=? AND j.tenant_id=?`,[id(jobId),id(tenantId)]);if(!job)throw fail('上架记录不存在或不属于当前企业。',404);return job;}
 async function cards(tenantId,shopIds){return shopIds.length?query(`SELECT * FROM wb_product_cards WHERE tenant_id=? AND shop_id IN (${shopIds.map(()=>'?').join(',')})`,[id(tenantId),...shopIds]):[];}
 async function publishRecords(tenantId){
  const jobs=await query(`${select} WHERE j.tenant_id=? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.state_json,'$.record_hidden')),'false')<>'true' ORDER BY j.id DESC LIMIT 200`,[id(tenantId)]);
  const online=await cards(tenantId,[...new Set(jobs.map(job=>Number(job.shop_id)))]);
  return {rows:jobs.map(job=>wbPublishRecordView(job,online))};
 }
 async function syncPublishRecord(tenantId,body){
  const job=await owned(tenantId,body.job_id),a=await account(tenantId,job.shop_id),payload=parse(job.payload_json),state=parse(job.state_json),warnings=[];
  let matched=0;
  for(const variant of wbListingVariants(payload)){
   const item=state.items?.find(item=>item.vendor_code===variant.card.vendorCode);
   const card=await findWbCard(request,a,variant.card.vendorCode,{nmId:item?.nm_id,matchById:Boolean(item?.nm_id)});
   if(card){await saveWbProductCard(query,a,card);matched++;}else warnings.push(`${variant.card.vendorCode}：WB 商品库暂未返回商品，请稍后同步或核对发布状态。`);
  }
  if(matched){const result=await refreshProductSnapshots(tenantId,{shop_id:a.shop_id});warnings.push(...result.warnings);}
  return {ok:true,job:wbPublishRecordView(await owned(tenantId,job.id),await cards(tenantId,[Number(job.shop_id)])),warnings};
 }
 async function deletePublishRecord(tenantId,body){
  const job=await owned(tenantId,body.job_id);
  if(['queued','processing'].includes(job.status))throw fail('该上架任务仍在处理中，请等待任务结束后删除本地记录。删除记录不会停止平台任务。');
  const result=await query("UPDATE wb_publish_jobs SET state_json=JSON_SET(state_json,'$.record_hidden',CAST('true' AS JSON)) WHERE id=? AND tenant_id=? AND status NOT IN ('queued','processing') AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP())",[job.id,id(tenantId)]);
  if(!result.affectedRows)throw fail('该记录正在被后台处理，请稍后刷新再删除。');
  return {ok:true,job_id:Number(job.id),message:'本地上架记录已删除，WB 线上商品及工作草稿保留。'};
 }
 return {publishRecords,syncPublishRecord,deletePublishRecord};
}

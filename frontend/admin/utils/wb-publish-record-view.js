import {wbListingVariants} from '../../../src/shared/wb-listing-variants.js';

const number=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const urls=values=>(Array.isArray(values)?values:[]).filter(value=>typeof value==='string'&&value.trim());

export function wbRecordProducts(job={}){
 if(Array.isArray(job.products))return job.products.map(product=>({...product,images:urls(product.images),barcodes:(Array.isArray(product.barcodes)?product.barcodes:[]).map(String),price:number(product.price),score:number(product.score),nm_id:number(product.nm_id)}));
 return wbListingVariants(job.payload||{}).map((row,index)=>({title:row.card?.title||'',vendor_code:row.card?.vendorCode||'',images:urls(row.images),video_url:row.video_url||'',price:number(row.card?.sizes?.[0]?.price),prices:(row.card?.sizes||[]).map(size=>number(size.price)).filter(value=>value!==null),currency:job.payload?.currency||'CNY',nm_id:number(job.state?.items?.[index]?.nm_id),barcodes:[],score:null,score_label:'',online_status:null,published_at:null,synced_at:null}));
}

export function wbRecordPriceText(job){
 const grouped=new Map();
 for(const product of wbRecordProducts(job)){
  const prices=Array.isArray(product.prices)?product.prices.map(number).filter(value=>value!==null):[],values=prices.length?prices:product.price===null?[]:[product.price];
  if(!values.length)continue;const currency=product.currency||job.payload?.currency||'CNY';grouped.set(currency,[...(grouped.get(currency)||[]),...values]);
 }
 return [...grouped].map(([currency,values])=>{const low=Math.min(...values),high=Math.max(...values);return `${low===high?low:low+'–'+high} ${currency}`;}).join(' / ')||'未返回';
}

export function wbRecordScore(job){
 const products=wbRecordProducts(job),scored=products.filter(product=>product.score!==null);
 if(!scored.length)return{text:'未返回',label:''};
 const values=scored.map(product=>product.score),low=Math.min(...values),high=Math.max(...values),labels=[...new Set(scored.map(product=>product.score_label||(product.score_source==='erp_completeness'?'ERP资料完整度':'评分来源未提供')))];
 return{text:`${low===high?low:low+'–'+high} 分${scored.length<products.length?'（部分）':''}`,label:labels.join(' / ')};
}

export const wbRecordHasOnlineSku=job=>wbRecordProducts(job).some(product=>Number(product.nm_id)>0);
export const wbRecordOnlineStatus=product=>({in_catalog:'在商品库',archived:'位于回收站',not_synced:'未同步'}[product.online_status]||'未返回');
export function wbRecordPriceSource(job){const products=wbRecordProducts(job).filter(product=>product.price!==null),sources=[...new Set(products.map(product=>product.price_source))],partial=products.some(product=>product.price_source==='online'&&product.price_partial);return sources.length===1?{online:partial?'线上售价（部分规格）':'线上售价',submitted:'提交售价'}[sources[0]]||'':sources.length>1?`线上 / 提交售价${partial?'（部分规格）':''}`:'';}
export const wbRecordCanDelete=job=>!['queued','processing'].includes(job.status);
export const wbRecordStatusType=job=>({completed:'success',failed:'danger',needs_review:'warning',paused:'warning',queued:'info',processing:'info'}[job.status]||'info');
export function wbRecordMatches(job,{query='',shopId='',status=''}={}){
 if(shopId&&Number(job.shop_id)!==Number(shopId)||status&&job.status!==status)return false;
 const needle=query.trim().toLocaleLowerCase();
 return !needle||[job.id,job.shop_name,job.category_name,job.publisher_name,...wbRecordProducts(job).flatMap(product=>[product.title,product.vendor_code,product.nm_id,...product.barcodes])].some(value=>String(value??'').toLocaleLowerCase().includes(needle));
}

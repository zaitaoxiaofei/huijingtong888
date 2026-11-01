import {apiClient,currentApiCacheScope} from './api.js';
import {createThumbnailBatchLoader} from './thumbnail-batch-loader.js';
const loader=createThumbnailBatchLoader({load:(url,options)=>apiClient.blobResponse(url,{...options,authExpiredRedirect:false})});
let scope=null;
export function productThumbnailUrl(value){
 try{const url=new URL(value,window.location.origin);if(url.origin!==window.location.origin||!/^\/api\/products\/\d+\/image$/.test(url.pathname)||url.searchParams.get('thumb')!=='1')return '';
 url.searchParams.delete('token');return url.pathname+url.search;
 }catch{return '';}
}
export function loadProductThumbnail(url,{force=false}={}){
 const current=currentApiCacheScope();if(current!==scope){loader.clear();scope=current;}
 return loader.request(`${current}|${url}`,url,{force});
}
window.addEventListener('erp:auth-scope-changed',()=>{scope=null;loader.clear();});
window.addEventListener('erp:product-image-changed',event=>{
 const id=Number(event.detail?.productId);if(!Number.isSafeInteger(id)||id<=0)return;
 loader.invalidate(key=>key.split('|')[1]?.split('?')[0]===`/api/products/${id}/image`);
});

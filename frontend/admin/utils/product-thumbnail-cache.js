import {apiClient,currentApiCacheScope} from './api.js';
import {createThumbnailBatchLoader} from './thumbnail-batch-loader.js';
export {productThumbnailUrl,publicImageThumbnailUrl,originalProductImageUrl} from './image-thumbnail-url.js';
const loader=createThumbnailBatchLoader({load:(url,options)=>apiClient.blobResponse(url,{...options,authExpiredRedirect:false})});
let scope=null;
export function loadProductThumbnail(url,{force=false}={}){
 const current=currentApiCacheScope();if(current!==scope){loader.clear();scope=current;}
 return loader.request(`${current}|${url}`,url,{force});
}
window.addEventListener('erp:auth-scope-changed',()=>{scope=null;loader.clear();});
window.addEventListener('erp:product-image-changed',event=>{
 const id=Number(event.detail?.productId);if(!Number.isSafeInteger(id)||id<=0)return;
 loader.invalidate(key=>key.split('|')[1]?.split('?')[0]===`/api/products/${id}/image`);
});

// Use only URLs supplied by the card. Never derive a basket host from nmID.
function imageUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function wbProductImages(card={}){
 const photos=Array.isArray(card.photos)?card.photos:[],seen=new Set();
 return photos.map(photo=>{const original=typeof photo==='string'?imageUrl(photo):['big','c516x688','hq','c246x328','square','tm'].map(key=>imageUrl(photo?.[key])).find(Boolean)||'';const thumbnail=typeof photo==='string'?original:['c246x328','c516x688','big','hq','square','tm'].map(key=>imageUrl(photo?.[key])).find(Boolean)||original;return{original,thumbnail};}).filter(photo=>photo.original&&!seen.has(photo.original)&&seen.add(photo.original));
}
export const wbImageProxy=url=>`/api/image-proxy?url=${encodeURIComponent(url)}&require_original=1`;

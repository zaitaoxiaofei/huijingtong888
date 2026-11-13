import sharp from 'sharp';
import {requestPublicMedia} from '../http/public-image-request.js';
const cache=new Map();
export async function inspectWbPublishMedia(variants,{read=requestPublicMedia,metadata=buffer=>sharp(buffer).metadata(),now=Date.now}={}){
 const errors=[];
 async function inspect(url,video){const key=(video?'video:':'image:')+url,prior=cache.get(key);if(read===requestPublicMedia&&prior&&now()-prior<5*60*1000)return;
  const maxBytes=(video?50:32)*1024*1024;
  const r=await read(url,{method:video?'HEAD':'GET',signal:AbortSignal.timeout(12000),maxBytes});
  if(!r?.ok)throw Error('文件不能通过公开直链读取，请重新上传。');
  if(video){const length=Number(r.headers.get('content-length'));if(!Number.isSafeInteger(length)||length<=0||length>maxBytes)throw Error('请使用能核对文件大小且不超过 50MB 的视频直链。');if(!/^(video\/|application\/octet-stream)/.test(r.contentType))throw Error('直链未返回视频文件，请重新上传 MP4 或 MOV。');}
  else{if(!r.contentType.startsWith('image/')||!r.buffer.length||r.buffer.length>maxBytes)throw Error('请上传不超过 32MB 的有效图片。');const m=await metadata(r.buffer);if(!['jpeg','png','webp','gif','bmp'].includes(m.format)||Number(m.pages||1)>1)throw Error('请使用 JPG、PNG、静态 GIF、BMP 或 WebP 图片。');const swapped=[5,6,7,8].includes(m.orientation),width=swapped?m.height:m.width,height=swapped?m.width:m.height;if(width<700||height<900)throw Error(`当前 ${width}×${height} 像素，WB 要求至少 700×900 像素，请更换原图。`);}
  if(read===requestPublicMedia){if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(key,now());}
 }
 for(const [index,row] of variants.entries()){for(const [imageIndex,url] of row.images.entries())try{await inspect(url,false);}catch(error){errors.push(`变体 ${index+1} 图片 ${imageIndex+1}：${/[\u4e00-\u9fff]/.test(error.message)?error.message:'公开直链读取失败，请重新上传并检查链接可公开访问。'}`);}if(row.video_url)try{await inspect(row.video_url,true);}catch(error){errors.push(`变体 ${index+1} 视频：${/[\u4e00-\u9fff]/.test(error.message)?error.message:'公开直链读取失败，请重新上传视频。'}`);}}
 return errors;
}

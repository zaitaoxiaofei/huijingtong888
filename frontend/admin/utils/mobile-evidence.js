export const MOBILE_PHOTO_LIMIT=6;
export function validateMobilePhoto(file){
 if(!file||!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(String(file.type).toLowerCase()))throw new Error('请选择 JPG、PNG、WebP 或手机照片；不支持SVG和其他附件');
 if(!file.size||file.size>20*1024*1024)throw new Error('单张原图须小于20MB，请缩小后重试');
}
export async function prepareMobilePhoto(file){
 validateMobilePhoto(file);const url=URL.createObjectURL(file);
 try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('照片格式无法解码，请从相册导出JPG或使用兼容模式拍照后重试'));image.src=url;});
 const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d');if(!context)throw new Error('无法处理图片，请重新选择');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));canvas.width=canvas.height=1;if(!blob||blob.size>4*1024*1024)throw new Error('压缩后的图片过大，请缩小照片重试');return new File([blob],`erp-photo-${crypto.randomUUID()}.jpg`,{type:'image/jpeg'});
 }finally{URL.revokeObjectURL(url);}
}
export function purchaseLink(value){const text=String(value||'').trim();if(!text)return '';const match=text.match(/https?:\/\/[^\s<>"，。]+/i);if(!match)throw new Error('采购链接须包含完整的 http 或 https 网址');const url=new URL(match[0]);if(url.username||url.password)throw new Error('采购链接不能包含账号密码');return url.href;}

// A small JPEG fits the existing own-profile avatar field, without granting
// warehouse staff listing-media privileges or uploading their face to OSS.
export async function prepareMobileAvatar(file) {
 validateMobilePhoto(file);
 const url=URL.createObjectURL(file);
 try {
  const image=new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('头像无法读取，请换用JPG或PNG图片'));image.src=url;});
  const side=Math.min(image.naturalWidth,image.naturalHeight);
  if(!side)throw new Error('头像图片为空');
  const canvas=document.createElement('canvas');canvas.width=canvas.height=160;
  const context=canvas.getContext('2d');if(!context)throw new Error('无法处理头像，请重新选择');
  context.fillStyle='#fff';context.fillRect(0,0,160,160);
  context.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,160,160);
  let result=canvas.toDataURL('image/jpeg',.78);
  if(result.length>24000)result=canvas.toDataURL('image/jpeg',.45);
  canvas.width=canvas.height=1;
  if(!result.startsWith('data:image/jpeg;base64,')||result.length>24000)throw new Error('头像压缩后仍过大，请换一张图片');
  return result;
 } finally {URL.revokeObjectURL(url);}
}

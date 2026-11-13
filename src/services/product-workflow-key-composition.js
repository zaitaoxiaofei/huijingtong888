import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestPublicImage } from '../http/public-image-request.js';

// Remove only light background connected to image edges; keep key pixels, not an AI redraw.
export function clearLightKeyBackground(data,width,height) {
  for(let i=3;i<data.length;i+=4)if(data[i]<250)return data;
  const corners=[0,(width-1)*4,(height-1)*width*4,(width*height-1)*4];
  const bg=[0,1,2].map(c=>Math.round(corners.reduce((sum,i)=>sum+data[i+c],0)/4));
  if(Math.min(...bg)>=245)return data;
  if(Math.min(...bg)<190)throw new Error('适配钥匙请使用白底或透明底图片，当前背景过深，无法安全去除；不会重画钥匙');
  const seen=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
  const visit=index=>{
    if(seen[index])return;seen[index]=1;const i=index*4;
    if(Math.min(data[i],data[i+1],data[i+2])<130||Math.max(...bg.map((v,c)=>Math.abs(v-data[i+c])))>95)return;
    data[i+3]=0;queue[tail++]=index;
  };
  for(let x=0;x<width;x++){visit(x);visit((height-1)*width+x);}
  for(let y=0;y<height;y++){visit(y*width);visit(y*width+width-1);}
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);if(x)visit(i-1);if(x<width-1)visit(i+1);if(y)visit(i-width);if(y<height-1)visit(i+width);}
  if(tail===width*height)throw new Error('适配图片未找到钥匙主体，请上传清晰的白底或透明底钥匙图');
  return data;
}
export async function renderWorkflowKeyCard(input) {
  const decoded=await sharp(input,{limitInputPixels:40000000}).rotate().resize(440,530,{fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  clearLightKeyBackground(decoded.data,decoded.info.width,decoded.info.height);
  const photo=await sharp(decoded.data,{raw:decoded.info}).trim({background:'#00000000'}).png().toBuffer({resolveWithObject:true});
  const frame=Buffer.from(`<svg width="750" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="750" height="1000" fill="white"/><path d="M94 240H656M94 785H656" stroke="#b8c0c9" stroke-width="1"/><g fill="#25303c" text-anchor="middle" font-family="DejaVu Sans,sans-serif"><text x="375" y="176" font-size="37" font-weight="bold">СОВМЕСТИМОСТЬ</text><text x="375" y="215" font-size="23">Для ключа такого типа</text><text x="375" y="823" font-size="22">Сравните форму и кнопки</text><text x="375" y="855" font-size="19">Перед заказом проверьте свой ключ</text></g></svg>`);
  return sharp(frame).composite([{input:photo.data,left:Math.round((750-photo.info.width)/2),top:Math.round(255+(530-photo.info.height)/2)}]).png().toBuffer();
}

export async function composeWorkflowKeyImage({runId,variant,node,session,guard},dependencies={}) {
  const source=variant.values[node.composeInput];
  if(!Array.isArray(source)||source.length!==1||!source[0])throw new Error('缺少适配钥匙原图，请在生产材料中选择钥匙库图片或上传一张后重新生产');
  if(!/^https?:\/\//i.test(source[0]))throw new Error('适配钥匙原图暂不能读取，请重新上传当前企业的钥匙图片；不会改用AI重画');
  await guard();
  const image=await (dependencies.readImage||requestPublicImage)(source[0],{maxBytes:20*1024*1024,signal:AbortSignal.timeout(15000),beforeRequest:guard});
  if(!image?.buffer?.length)throw new Error('适配钥匙原图读取失败，请检查资料库原图或重新上传');
  const buffer=await renderWorkflowKeyCard(image.buffer);await guard();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-key-'));
  try {
    const filePath=path.join(dir,'key-fitment.png');await fs.writeFile(filePath,buffer);
    const store=dependencies.store|| (await import('./listing-automation.js')).registerListingMediaAssetFromFile;
    const asset=await store({filePath,mime_type:'image/png',source_module:'product_workflow',source_id:`${runId}:${variant.id}:${node.id}`,variant_id:variant.id,role:'detail',width:750,height:1000},session);
    const url=asset.publish_url||asset.publishUrl||asset.preview_url||asset.url;
    if(!url)throw new Error('适配图保存失败，请重试本节点');
    return url;
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}

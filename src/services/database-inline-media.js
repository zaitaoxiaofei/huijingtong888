import crypto from 'node:crypto';
import OSS from 'ali-oss';
import {ossStorageConfig,putContentAddressedObject} from './object-storage.js';

const TYPES={'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/mp4':'mp4','video/webm':'webm'};
const MAX_MEDIA_BYTES=40*1024*1024;
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');

function validateMediaBytes(bytes,type){
 const valid=type==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
  :['image/jpeg','image/jpg'].includes(type)?bytes[0]===255&&bytes[1]===216&&bytes[2]===255
  :type==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))
  :type==='image/webp'?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'
  :type==='video/webm'?bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))
  :bytes.subarray(4,8).toString()==='ftyp'&&(type==='video/mp4'||/avif|avis/.test(bytes.subarray(8,32).toString('ascii')));
 if(!valid)throw Object.assign(new Error('图片或视频内容与文件类型不符，请重新上传'),{statusCode:400});
}

// No fallback can write binary/base64 into the database when OSS fails.
export async function archiveInlineMedia(value,{env=process.env,client,prefix='product-media',beforeRequest=async()=>{}}={}){
 if(typeof value!=='string'||!/^data:/i.test(value))return value;
 const match=/^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
 if(!match||!TYPES[match[1].toLowerCase()])throw Object.assign(new Error('请上传PNG、JPEG、WebP、GIF、AVIF图片或MP4、WebM视频'),{statusCode:400});
 if(match[2].length>Math.ceil(MAX_MEDIA_BYTES/3)*4)throw Object.assign(new Error('图片或视频超过40MB，请压缩后重试'),{statusCode:400});
 const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>MAX_MEDIA_BYTES||bytes.toString('base64')!==match[2])throw Object.assign(new Error('图片或视频编码无效'),{statusCode:400});
 const type=match[1].toLowerCase();validateMediaBytes(bytes,type);await beforeRequest();
 const s=ossStorageConfig(env);if(!s.enabled)throw Object.assign(new Error('图片未保存：OSS对象存储尚未配置，请联系管理员配置后重试'),{statusCode:503});
 const store=client||new OSS({region:s.region,bucket:s.bucket,accessKeyId:s.accessKeyId,accessKeySecret:s.accessKeySecret,stsToken:s.stsToken||undefined,internal:true,secure:true,timeout:60000});
 const uploaded=await putContentAddressedObject(bytes,{env,client:store,prefix,extension:TYPES[type],contentType:type==='image/jpg'?'image/jpeg':type});
 if(!uploaded?.url)throw Error('OSS media upload returned no URL');
 await beforeRequest();const result=await store.getStream(uploaded.objectKey),h=crypto.createHash('sha256');let size=0;
 try{for await(const chunk of result.stream){size+=chunk.length;if(size>bytes.length)throw Error('OSS media exceeds expected byte size');h.update(chunk);}}finally{result.stream.destroy?.();}
 if(size!==bytes.length||h.digest('hex')!==digest(bytes))throw Error('OSS media readback checksum mismatch');
 await beforeRequest();return uploaded.url;
}

export async function externalizeInlineMedia(value,options={}){
 const cache=new Map();let totalBytes=0;
 async function visit(item,depth=0){
  if(depth>64)throw new Error('Media JSON depth exceeds limit');
  if(typeof item==='string'&&/^data:/i.test(item)){
   const key=digest(item);if(cache.has(key))return cache.get(key);totalBytes+=Buffer.byteLength(item);if(totalBytes>64*1024*1024)throw Object.assign(new Error('本次内嵌图片总量超过64MB，请分批上传'),{statusCode:400});
   const stored=await archiveInlineMedia(item,options);cache.set(key,stored);return stored;
  }
  if(Array.isArray(item)){const out=[];for(const child of item)out.push(await visit(child,depth+1));return out;}
  if(item&&typeof item==='object'){const entries=[];for(const [key,child]of Object.entries(item))entries.push([key,await visit(child,depth+1)]);return Object.fromEntries(entries);}
  return item;
 }
 return visit(value);
}

export async function prepareInventoryInlineMedia(body,options={}){
 const selected={};
 if(body.image_url!==undefined)selected.image_url=body.image_url;
 if(body.detail_image_urls!==undefined){
  const value=body.detail_image_urls;
  if(Array.isArray(value))selected.detail_image_urls=value;
  else{try{const parsed=JSON.parse(value);selected.detail_image_urls=Array.isArray(parsed)?parsed:value;}catch{selected.detail_image_urls=value;}}
 }
 return {...body,...await externalizeInlineMedia(selected,options)};
}

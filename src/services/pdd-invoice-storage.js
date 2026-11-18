import OSS from 'ali-oss';
import {createHash} from 'node:crypto';
import {ossStorageConfig,verifyPrivateOssObject} from './object-storage.js';
const MAX_BYTES=5*1024*1024;
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode,pddStorageError:true});};
function namespace(tenantId,accountId){
 if(!Number.isSafeInteger(tenantId)||tenantId<=0||!/^[A-Za-z0-9_-]{8,64}$/.test(accountId||''))fail('附件企业或采购账号标识无效');
 return `private/tenants/${tenantId}/pdd-invoices/${accountId}/`;
}
export function createPddInvoiceStorage({env=process.env,client=null,request=fetch}={}){
 function context(){
  let config;try{config=ossStorageConfig(env);}catch{fail('私有 OSS 配置不完整，请由管理员检查存储配置；可先下载到本地');}
  if(!config.enabled)fail('系统尚未启用私有 OSS，未将附件写入服务器磁盘；请先配置 OSS 或选择本地下载');
  const oss=client||new OSS({region:config.region,bucket:config.bucket,accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,stsToken:config.stsToken||undefined,secure:true,timeout:15000});
  return {config,oss};
 }
 async function privateObject(oss,key,config){
  let verified;try{verified=await verifyPrivateOssObject(oss,key,{storage:config,request});}catch(error){if(error.message === "Private OSS object ACL verification failed")throw Object.assign(new Error("OSS 私有权限校验失败，已停止归档"),{code:"PRIVATE_OBJECT_PUBLIC",statusCode:409,pddStorageError:true});throw error;}
  if(verified.method==='unsigned_origin_read_denied')return;
  const url=`https://${config.bucket}.${config.region}.aliyuncs.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  const response=await request(url,{method:'GET',headers:{Range:'bytes=0-0','Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(10000)});
  try{if(response.status!==403||!response.headers.get('x-oss-request-id'))throw Object.assign(new Error('附件的 OSS 匿名访问未被拒绝，已停止系统归档，请检查私有存储权限'),{code:response.ok?'PRIVATE_OBJECT_PUBLIC':'PRIVATE_OBJECT_UNVERIFIED',statusCode:409,pddStorageError:true});}finally{await response.body?.cancel();}
 }
 async function body(oss,key,expected){
  const head=await oss.head(key),size=Number(head?.res?.headers?.['content-length']);
  if(!Number.isSafeInteger(size)||size!==expected.size||size>MAX_BYTES)fail('OSS 附件大小校验失败，请重新归档');
  const result=await oss.get(key),bytes=Buffer.from(result.content||[]);
  if(bytes.length!==expected.size||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)fail('OSS 附件内容校验失败，请重新归档');
  return {bytes,versionId:String(result.res?.headers?.['x-oss-version-id']||head.res?.headers?.['x-oss-version-id']||'')};
 }
 async function protect(action){try{return await action();}catch(error){if(error.pddStorageError)throw error;const code=String(error.code||error.name||'UNKNOWN').replace(/[^A-Za-z0-9_-]/g,'').slice(0,60);fail(`私有 OSS 请求失败（${code}），请检查网络、配置与访问权限；台账索引未更新`,502);}}
 return {
  status(){let configured=false;try{configured=ossStorageConfig(env).enabled;}catch{}return{configured,maxFileBytes:MAX_BYTES};},
  put(tenantId,accountId,file,bytes){return protect(async()=>{
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES||!/^[a-f0-9]{64}$/.test(file.sha256)||!['png','jpg','pdf'].includes(file.ext)||createHash('sha256').update(bytes).digest('hex')!==file.sha256)fail('待归档附件校验失败');
   const {config,oss}=context(),key=namespace(tenantId,accountId)+file.sha256+'.'+file.ext;let created=false;
   try{await oss.head(key);}catch(error){if(Number(error.status||error.statusCode)!==404&&error.code!=='NoSuchKey')throw error;
    await oss.put(key,bytes,{headers:{'Content-Type':file.ext==='pdf'?'application/pdf':file.ext==='png'?'image/png':'image/jpeg','Cache-Control':'private, no-store','x-oss-object-acl':'private'}});created=true;
   }
   try{await privateObject(oss,key,config);}catch(error){if(created&&error.code==='PRIVATE_OBJECT_PUBLIC')try{await oss.delete(key);}catch{error.message+=`；撤回失败，请管理员核查对象 ${key}`;}throw error;}
   const verified=await body(oss,key,{size:bytes.length,sha256:file.sha256});
   return {driver:'oss',bucket:config.bucket,region:config.region,objectKey:key,versionId:verified.versionId,verifiedAt:Date.now()};
  });},
  read(tenantId,accountId,file){return protect(async()=>{
   const {config,oss}=context(),storage=file.storage;
   const expected=namespace(tenantId,accountId)+file.sha256+'.'+file.ext;
   if(!storage||storage.driver!=='oss'||storage.bucket!==config.bucket||storage.region!==config.region||storage.objectKey!==expected)fail('附件存储位置与当前企业或 OSS 配置不一致，请联系管理员恢复原存储配置');
   await privateObject(oss,expected,config);return (await body(oss,expected,file)).bytes;
  });}
 };
}
export const pddInvoiceStorage=createPddInvoiceStorage();

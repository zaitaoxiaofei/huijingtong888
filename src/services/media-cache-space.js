import fs from 'node:fs/promises';
import path from 'node:path';

export async function assertMediaCacheDiskSpace({directory=process.cwd(),additionalBytes=0,statfs=fs.statfs,env=process.env}={}){
 if(env.MEDIA_CACHE_LIFECYCLE_ENABLED!=='1')return;
 const reserve=Number(env.MEDIA_CACHE_MIN_FREE_BYTES||3*1024**3);if(!Number.isSafeInteger(reserve)||reserve<512*1024**2||!Number.isSafeInteger(additionalBytes)||additionalBytes<0)throw Error('Invalid media disk reserve');
 let current=path.resolve(directory),disk;for(;;){try{disk=await statfs(current);break;}catch(e){if(e.code!=='ENOENT'||path.dirname(current)===current)throw e;current=path.dirname(current);}}
 const available=Number(disk.bavail)*Number(disk.bsize);
 if(available<reserve+additionalBytes)throw Object.assign(Error('服务器可用空间不足，已暂停媒体处理，请等待缓存回收或联系管理员'),{statusCode:503});
}

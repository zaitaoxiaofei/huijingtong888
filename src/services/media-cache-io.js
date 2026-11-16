import fs from 'node:fs/promises';
import path from 'node:path';
import {mediaCacheSource,restoreMediaCacheFile,restoreMediaCacheDirectory} from './media-cache-files.js';
import {mediaCoordinationRoot} from './media-cache-coordination.js';

export async function restoreManagedCacheInput(file){
 if(process.env.MEDIA_CACHE_LIFECYCLE_ENABLED!=='1'||typeof file!=='string')return;
 let source;try{source=mediaCacheSource(file);}catch{return;}
 await restoreMediaCacheFile(file);
 const {cacheSourceFingerprint}=await import('./media-cache-files.js');const directory=path.join(mediaCoordinationRoot(),'access');await fs.mkdir(directory,{recursive:true,mode:0o700});
 const marker=path.join(directory,cacheSourceFingerprint(source));const handle=await fs.open(marker,'w',0o600);await handle.close();
}
export async function readCacheAwareFile(file,...args){await restoreManagedCacheInput(file);return fs.readFile(file,...args);}
export async function statCacheAwareFile(file,...args){await restoreManagedCacheInput(file);return fs.stat(file,...args);}
export async function readCacheAwareDirectory(directory,...args){
 if(process.env.MEDIA_CACHE_LIFECYCLE_ENABLED==='1'&&typeof directory==='string'){
  let source;try{source=mediaCacheSource(path.join(directory,'index.png'));}catch{}
  if(source){const parts=source.split('/');if(parts.length>=5&&(parts[2]!=='temp'||parts[3]==='image-cropper'&&parts.length>=6))await restoreMediaCacheDirectory(directory);}
 }
 return fs.readdir(directory,...args);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {assertMediaCacheDiskSpace} from './media-cache-space.js';

const context=new AsyncLocalStorage();
const enabled=()=>process.env.MEDIA_CACHE_LIFECYCLE_ENABLED==='1';
export const mediaCoordinationRoot=()=>path.resolve(process.env.MEDIA_CACHE_COORDINATION_DIR||path.join(process.cwd(),'uploads','.cache-coordination'));
async function startToken(pid){try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}catch(e){if(process.platform==='linux'){if(e.code==='ENOENT')return null;throw e;}try{process.kill(pid,0);return 'portable';}catch(error){if(error.code==='ESRCH')return null;throw error;}}}
async function owner(){return `${process.pid}-${await startToken(process.pid)}-${crypto.randomUUID()}`;}
async function alive(token){const m=/^([1-9][0-9]*)-([a-z0-9]+)-[a-f0-9-]{36}$/.exec(token||'');if(!m)throw Error('Invalid media lease owner');const now=await startToken(Number(m[1]));return now!==null&&now===m[2];}
async function prepare(root){await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe media lease directory');}
async function exclusiveOwner(root){try{return await fs.readlink(path.join(root,'exclusive'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function removeDeadExclusive(root){const token=await exclusiveOwner(root);if(token&&!await alive(token)&&await exclusiveOwner(root)===token)await fs.unlink(path.join(root,'exclusive'));}
export async function mediaCoordinationGate(work){
 const {getMysqlPool}=await import('../mysql-pool.js');const connection=await getMysqlPool().getConnection();
 try{const [[r]]=await connection.query("SELECT GET_LOCK('ozon.media.cache.handshake.v1',30) AS locked");if(Number(r.locked)!==1)throw Error('Media cache coordination lock unavailable');try{return await work();}finally{await connection.query("SELECT RELEASE_LOCK('ozon.media.cache.handshake.v1')");}}finally{connection.release();}
}
async function sharedLease(root,{timeoutMs=30000,gate=mediaCoordinationGate}={}){
 await prepare(root);const token=await owner(),file=path.join(root,'read-'+token),deadline=Date.now()+timeoutMs;
 for(;;){let acquired;try{acquired=await gate(async()=>{await removeDeadExclusive(root);if(await exclusiveOwner(root))return false;const handle=await fs.open(file,'wx',0o600);await handle.close();if(await exclusiveOwner(root)){await fs.unlink(file);return false;}return true;});}catch(error){await fs.rm(file,{force:true});throw error;}
  if(acquired)return async()=>{await fs.unlink(file);};
  if(Date.now()>=deadline)throw Object.assign(Error('媒体缓存维护中，请稍后重试'),{statusCode:503});await delay(25);
 }
}
export async function withMediaCacheLease(work,{root=mediaCoordinationRoot(),gate=mediaCoordinationGate,writes=false}={}){
 if(!enabled())return work();let state=context.getStore();
 if(writes)await assertMediaCacheDiskSpace({directory:path.resolve('uploads')});
 if(state?.references>0&&state.root===root){state.references++;try{return await work();}finally{if(--state.references===0)await state.release();}}
 state={root,references:1,release:await sharedLease(root,{gate})};
 return context.run(state,async()=>{try{return await work();}finally{if(--state.references===0)await state.release();}});
}
// The request lease lasts through streaming, not merely until a handler returns
// a pathname. Background operations take their own re-entrant operation lease.
export async function protectMediaRequest(req,res,{root=mediaCoordinationRoot(),gate=mediaCoordinationGate}={}){
 if(!enabled()||!/^\/(?:api\/(?:ai|tools\/image-cropper|asset-variant-engine|listing)|uploads\/)/.test(new URL(req.url,'http://local').pathname))return;
 const release=await sharedLease(root,{gate});let released=false;const done=()=>{if(!released){released=true;void release().catch(e=>console.error('[media-cache-lease]',e.message));}};
 res.once('close',done);res.once('finish',done);if(res.destroyed||res.writableEnded)done();
}
export async function registerMediaCacheReader(){
 if(!enabled())return;const root=mediaCoordinationRoot();await prepare(root);const token=await owner();const file=path.join(root,'participant-'+token);await mediaCoordinationGate(async()=>{const handle=await fs.open(file,'wx',0o600);await handle.close();});return token;
}
export async function registeredMediaPids(root){
 await prepare(root);const pids=new Set();for(const name of await fs.readdir(root))if(name.startsWith('participant-')){const token=name.slice(12);if(await alive(token))pids.add(Number(token.split('-')[0]));else await fs.unlink(path.join(root,name));}return pids;
}
export async function withExclusiveMediaCache(work,{root=mediaCoordinationRoot(),gate=mediaCoordinationGate}={}){
 await prepare(root);const token=await owner(),lock=path.join(root,'exclusive');
 let acquired;try{acquired=await gate(async()=>{await removeDeadExclusive(root);try{await fs.symlink(token,lock);}catch(e){if(e.code==='EEXIST')return {status:'busy',deleted:0};throw e;}
  try{for(const name of await fs.readdir(root))if(name.startsWith('read-')){if(await alive(name.slice(5))){await fs.unlink(lock);return {status:'active_media',deleted:0};}await fs.unlink(path.join(root,name));}return true;}catch(e){await fs.unlink(lock);throw e;}
 });}catch(error){if(await exclusiveOwner(root)===token)await fs.unlink(lock);throw error;}
 if(acquired!==true)return acquired;
 try{return await work();}finally{try{await gate(async()=>{if(await exclusiveOwner(root)!==token)throw Error('Media cache exclusive owner changed');await fs.unlink(lock);});}catch(error){if(await exclusiveOwner(root)===token)await fs.unlink(lock);throw error;}}
}

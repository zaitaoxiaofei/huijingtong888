// Request-level image batching only: never changes table rows or business state.
export function createThumbnailBatchLoader({load,now=Date.now,concurrency=4,flushMs=40,timeoutMs=12000,maxEntries=96,maxBytes=8*1024*1024,ttlMs=300000,failureTtlMs=15000,schedule=setTimeout,cancel=clearTimeout}={}){
 const cache=new Map(),pending=new Map(),failures=new Map(),queue=[],deliveries=[];
 let active=0,bytes=0,generation=0,flushTimer=null;
 const aborted=()=>Object.assign(new Error('图片上下文已切换'),{name:'AbortError'});
 const remove=key=>{const entry=cache.get(key);if(entry){bytes-=entry.size;cache.delete(key);}};
 function flush(){
  flushTimer=null;
  for(const {entry,blob,error} of deliveries.splice(0)){
   if(entry.generation!==generation||pending.get(entry.key)!==entry)continue;
   pending.delete(entry.key);
   if(error){failures.set(entry.key,{error,until:now()+failureTtlMs});entry.reject(error);}
   else{
    failures.delete(entry.key);remove(entry.key);cache.set(entry.key,{blob,size:blob.size,until:now()+ttlMs});bytes+=blob.size;
    while(cache.size>maxEntries||bytes>maxBytes)remove(cache.keys().next().value);
    entry.resolve(blob);
   }
  }
  while(failures.size>maxEntries)failures.delete(failures.keys().next().value);
 }
 function publish(entry,blob,error){
  if(entry.generation!==generation||pending.get(entry.key)!==entry)return;
  deliveries.push({entry,blob,error});if(flushTimer===null)flushTimer=schedule(flush,flushMs);
 }
 function drain(){
  while(active<concurrency&&queue.length){
   const entry=queue.shift();if(entry.generation!==generation||pending.get(entry.key)!==entry)continue;active++;
   const controller=new AbortController();entry.controller=controller;
   let timer;
   const timeout=new Promise((_,reject)=>{timer=schedule(()=>{controller.abort();reject(new Error('图片加载超时，可单独重试'));},timeoutMs);});
   Promise.race([Promise.resolve().then(()=>load(entry.url,{signal:controller.signal,cache:entry.force?'reload':'default'})),timeout])
    .then(result=>{
     const blob=result?.blob||result,headers=result?.headers;
     if(headers?.get('X-Image-Proxy-Cache')==='PLACEHOLDER')throw new Error('主图暂不可用，可单独重试');
     if(!blob?.size||blob.size>512*1024||!/^image\//i.test(blob.type||''))throw new Error('缩略图格式或大小无效，可单独重试');
     publish(entry,blob);
    }).catch(error=>publish(entry,null,error)).finally(()=>{cancel(timer);active--;drain();});
  }
 }
 function request(key,url,{force=false}={}){
  if(pending.has(key))return pending.get(key).promise;
  const found=cache.get(key);
  if(!force&&found&&found.until>now()){cache.delete(key);cache.set(key,found);return Promise.resolve(found.blob);}
  remove(key);
  const failed=failures.get(key);if(!force&&failed?.until>now())return Promise.reject(failed.error);failures.delete(key);
  const entry={key,url,force,generation};entry.promise=new Promise((resolve,reject)=>Object.assign(entry,{resolve,reject}));pending.set(key,entry);queue.push(entry);drain();return entry.promise;
 }
 function clear(){
  generation++;if(flushTimer!==null)cancel(flushTimer);flushTimer=null;deliveries.length=0;queue.length=0;
  for(const entry of pending.values()){entry.controller?.abort();entry.reject(aborted());}
  pending.clear();cache.clear();failures.clear();bytes=0;
 }
 function invalidate(predicate){for(const key of cache.keys())if(predicate(key))remove(key);for(const key of failures.keys())if(predicate(key))failures.delete(key);for(const [key,entry] of pending)if(predicate(key)){pending.delete(key);entry.controller?.abort();entry.reject(aborted());}}
 return{request,clear,invalidate};
}
